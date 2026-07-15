const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const SSH_HOST = (process.env.MONITOR_SSH_HOST || '192.168.1.157').trim();
const SSH_USER = (process.env.MONITOR_SSH_USER || 'jordan').trim();
const DATA_PATH = process.env.DATA_PATH || '/home/jordan/swu/swu-ai-trainer/server/data';
const BOT_DIR = process.env.BOT_DIR || '/home/jordan/swu/swu-ai-trainer/bot';
const PORT = parseInt(process.env.PORT || '3456', 10);

const BOT_ENV = `BOT_NAME="Bot-$NAME" DECK_NAME="cad-bane" SERVER_URL="http://localhost:3000"`;

async function sshCmd(cmd) {
  try {
    const args = [
      '-o', 'ConnectTimeout=5',
      '-o', 'BatchMode=yes',
      `${SSH_USER}@${SSH_HOST}`,
      cmd
    ];
    const { stdout } = await execFileAsync('ssh', args, { timeout: 15000 });
    return { ok: true, data: stdout.trimEnd() };
  } catch (e) {
    return { ok: false, error: e.stderr?.trim() || e.message };
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); } catch { resolve({}); }
    });
  });
}

async function readFile(relPath) {
  const r = await sshCmd(`cat ${DATA_PATH}/${relPath} 2>/dev/null; echo`);
  if (!r.ok) return null;
  try { return JSON.parse(r.data); } catch { return null; }
}

async function getBotStatuses() {
  const r = await sshCmd(`for f in ${DATA_PATH}/bot_status_*.json; do [ -f "$f" ] && cat "$f" && echo "===BOTSTATUS==="; done`);
  if (!r.ok || !r.data) return [];
  const parts = r.data.split('===BOTSTATUS===').filter(Boolean);
  return parts.map(p => {
    try { return JSON.parse(p.trim()); } catch { return null; }
  }).filter(Boolean);
}

async function getArrayLength(relPath) {
  const r = await sshCmd(`grep -c '"gameId"' ${DATA_PATH}/${relPath} 2>/dev/null || echo 0`);
  if (!r.ok) return 0;
  return parseInt(r.data, 10) || 0;
}

async function getFileMtime(relPath) {
  const r = await sshCmd(`stat -c %Y ${DATA_PATH}/${relPath} 2>/dev/null; echo 0`);
  if (!r.ok) return 0;
  const lines = r.data.split('\n').filter(Boolean);
  const val = parseInt(lines[0], 10);
  return val > 0 ? val * 1000 : 0;
}

async function getServerInfo() {
  const [loadR, memR, uptimeR] = await Promise.all([
    sshCmd('cat /proc/loadavg 2>/dev/null; echo'),
    sshCmd(`free -m | awk 'NR==2{print $2" "$3" "$4" "$7}'`),
    sshCmd('uptime -s 2>/dev/null; echo')
  ]);

  let load = null;
  if (loadR.ok && loadR.data) {
    const p = loadR.data.split(' ');
    if (p.length >= 3) {
      load = { '1m': p[0], '5m': p[1], '15m': p[2] };
    }
  }

  let memory = null;
  if (memR.ok && memR.data) {
    const p = memR.data.split(' ');
    if (p.length >= 4) {
      memory = { total: p[0], used: p[1], free: p[2], avail: p[3] };
    }
  }

  return { load, memory, bootTime: uptimeR.ok && uptimeR.data ? uptimeR.data : null };
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
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

  if (url.pathname === '/api/status' && req.method === 'GET') {
    const [sshCheck, stats, recordingsCount, botStatuses, serverInfo, weightsMtime, recordingsMtime] = await Promise.all([
      sshCmd('echo ok'),
      readFile('stats.json'),
      getArrayLength('recordings.json'),
      getBotStatuses(),
      getServerInfo(),
      getFileMtime('weights.json'),
      getFileMtime('recordings.json')
    ]);

    sendJSON(res, 200, {
      timestamp: Date.now(),
      stats: stats || { gamesTrained: 0, accuracy: 0, examples: 0, lastTrainedAt: null },
      recordingsCount,
      weightsModified: weightsMtime || null,
      recordingsModified: recordingsMtime || null,
      bots: botStatuses,
      server: serverInfo,
      sshOk: sshCheck.ok,
      sshError: sshCheck.ok ? null : sshCheck.error
    });
    return;
  }

  if (url.pathname === '/api/bots/add' && req.method === 'POST') {
    const body = await readBody(req);
    const name = body.name || '';

    if (!name) {
      sendJSON(res, 400, { error: 'name required' });
      return;
    }

    const escaped = name.replace(/'/g, "'\\''");
    const pidCmd = `nohup /usr/bin/env BOT_NAME='${escaped}' DECK_NAME='cad-bane' node ${BOT_DIR}/bot.js > /dev/null 2>&1 & PID=$!; echo $PID > ${DATA_PATH}/bot_pid_${escaped}; echo $PID`;
    const r = await sshCmd(pidCmd);

    if (r.ok) {
      sendJSON(res, 200, { ok: true, pid: r.data, name });
    } else {
      sendJSON(res, 500, { error: r.error });
    }
    return;
  }

  if (url.pathname === '/api/bots/remove' && req.method === 'POST') {
    const body = await readBody(req);
    const name = body.name || '';

    if (!name) {
      sendJSON(res, 400, { error: 'name required' });
      return;
    }

    const escaped = name.replace(/'/g, "'\\''");
    const killCmd = `PID=$(cat ${DATA_PATH}/bot_pid_${escaped} 2>/dev/null); if [ -n "$PID" ] && kill -0 $PID 2>/dev/null; then kill $PID 2>/dev/null; echo "killed $PID"; else echo "not running"; fi; rm -f ${DATA_PATH}/bot_pid_${escaped} ${DATA_PATH}/bot_status_${escaped}.json`;
    const r = await sshCmd(killCmd);

    if (r.ok) {
      sendJSON(res, 200, { ok: true, result: r.data, name });
    } else {
      sendJSON(res, 500, { error: r.error });
    }
    return;
  }

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
  console.log(`Bot dir: ${BOT_DIR}`);
  console.log(`Data: ${DATA_PATH}`);
});
