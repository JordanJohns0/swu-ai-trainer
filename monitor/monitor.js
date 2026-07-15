const { exec } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);

const SSH_HOST = (process.env.SSH_HOST || '192.168.1.157').trim();
const SSH_USER = (process.env.SSH_USER || 'jordan').trim();
const DATA_PATH = process.env.DATA_PATH || '/home/jordan/swu/swu-ai-trainer/server/data';
const PORT = parseInt(process.env.PORT || '3456', 10);

async function sshCmd(cmd) {
  const fullCmd = `ssh -o ConnectTimeout=5 -o BatchMode=yes ${SSH_USER}@${SSH_HOST} "${cmd.replace(/"/g, '\\"')}"`;
  try {
    const { stdout } = await execAsync(fullCmd, { timeout: 15000, shell: true });
    return { ok: true, data: stdout.trimEnd() };
  } catch (e) {
    return { ok: false, error: e.stderr?.trim() || e.message };
  }
}

// Individual SSH calls for each piece of data
async function readFile(relPath) {
  const r = await sshCmd(`cat ${DATA_PATH}/${relPath} 2>/dev/null || echo ""`);
  if (!r.ok) return null;
  try { return JSON.parse(r.data); } catch { return null; }
}

async function getProcesses() {
  const r = await sshCmd(`ps aux | grep -v grep | grep "node.*bot"`);
  if (!r.ok || !r.data) return [];
  return r.data.split('\n').filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) return null;
    const cmd = parts.slice(10).join(' ');
    return {
      user: parts[0],
      pid: parts[1],
      cpu: parts[2],
      mem: parts[3],
      vsz: parts[4],
      rss: parts[5],
      start: parts[8],
      time: parts[9],
      cmd,
      name: cmd.includes('bot1') ? 'Bot-1' : cmd.includes('bot2') ? 'Bot-2' : 'bot'
    };
  }).filter(Boolean);
}

async function getArrayLength(relPath) {
  const r = await sshCmd(`node -e "try{const d=require('${DATA_PATH}/${relPath}');console.log(d.length||0)}catch(e){console.log(0)}" 2>/dev/null || echo "0"`);
  if (!r.ok) return 0;
  return parseInt(r.data, 10) || 0;
}

async function getFileMtime(relPath) {
  const r = await sshCmd(`stat -c %Y ${DATA_PATH}/${relPath} 2>/dev/null || echo "0"`);
  if (!r.ok) return 0;
  return parseInt(r.data, 10) * 1000;
}

async function getServerInfo() {
  const [loadR, memR, uptimeR] = await Promise.all([
    sshCmd(`cat /proc/loadavg 2>/dev/null || echo ""`),
    sshCmd(`free -m | awk 'NR==2{print $2" "$3" "$4" "$7}'`),
    sshCmd(`uptime -s 2>/dev/null || echo ""`)
  ]);

  let load = null;
  if (loadR.ok && loadR.data) {
    const p = loadR.data.split(' ');
    load = { '1m': p[0], '5m': p[1], '15m': p[2], running: p[3], total: p[4] };
  }

  let memory = null;
  if (memR.ok && memR.data) {
    const p = memR.data.split(' ');
    memory = { total: p[0], used: p[1], free: p[2], avail: p[3] };
  }

  return { load, memory, bootTime: uptimeR.ok ? uptimeR.data : null };
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/status') {
    const [sshCheck, stats, recordingsCount, processes, serverInfo, weightsMtime, recordingsMtime] = await Promise.all([
      sshCmd('echo ok'),
      readFile('stats.json'),
      getArrayLength('recordings.json'),
      getProcesses(),
      getServerInfo(),
      getFileMtime('weights.json'),
      getFileMtime('recordings.json')
    ]);

    const data = {
      timestamp: Date.now(),
      stats: stats || { gamesTrained: 0, accuracy: 0, examples: 0, lastTrainedAt: null },
      recordingsCount,
      weightsModified: weightsMtime || null,
      recordingsModified: recordingsMtime || null,
      processes,
      server: serverInfo,
      sshOk: sshCheck.ok,
      sshError: sshCheck.ok ? null : sshCheck.error
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);
  const ext = path.extname(filePath);

  try {
    const content = await fs.promises.readFile(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`SWU Bot Monitor started at http://localhost:${PORT}`);
  console.log(`SSH: ${SSH_USER}@${SSH_HOST}`);
  console.log(`Data: ${DATA_PATH}`);
});
