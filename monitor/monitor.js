const { execFile, spawn } = require('child_process');
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
const TUNNEL_PORT = parseInt(process.env.MONITOR_TUNNEL_PORT || '3457', 10);
const DRIVER_PORT = parseInt(process.env.DRIVER_PORT || '3458', 10);

const botStatusMap = new Map();
let lastPostTime = 0;
let driverOk = false;
let driverErr = null;

// Log ring buffer
const MAX_LOG_ENTRIES = 500;
const logEntries = [];

function addLog(level, msg) {
  const t = new Date().toISOString().replace('T', ' ').substring(0, 19);
  logEntries.push({ t, level, msg: String(msg).substring(0, 2000) });
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
}

// Intercept console.log/error to capture in ring buffer
const _origLog = console.log.bind(console);
const _origError = console.error.bind(console);
console.log = function (...args) { addLog('info', args.join(' ')); _origLog(...args); };
console.error = function (...args) { addLog('error', args.join(' ')); _origError(...args); };

function log(...args) {
  const t = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${t}]`, ...args);
}

async function sshCmd(cmd) {
  try {
    const args = [
      '-o', 'ConnectTimeout=5',
      '-o', 'BatchMode=yes',
      `${SSH_USER}@${SSH_HOST}`,
      cmd
    ];
    log(`SSH: ${cmd.substring(0, 120)}`);
    const { stdout } = await execFileAsync('ssh', args, { timeout: 15000 });
    const result = stdout.trimEnd();
    log(`SSH OK (${result.length} chars)`);
    return { ok: true, data: result };
  } catch (e) {
    const err = e.stderr?.trim() || e.message;
    log(`SSH FAIL: ${err.substring(0, 200)}`);
    return { ok: false, error: err };
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

const fileLocks = {};
function withFileLock(relPath, fn) {
  if (!fileLocks[relPath]) fileLocks[relPath] = Promise.resolve();
  const prev = fileLocks[relPath];
  let release;
  fileLocks[relPath] = new Promise(r => { release = r; });
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

async function writeFile(relPath, data) {
  const content = JSON.stringify(data, null, 2);
  const base64 = Buffer.from(content).toString('base64');
  return await sshCmd(`echo ${base64} | base64 -d > ${DATA_PATH}/${relPath}`);
}

async function writeFileLocked(relPath, data) {
  return withFileLock(relPath, () => writeFile(relPath, data));
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
    if (p.length >= 3) load = { '1m': p[0], '5m': p[1], '15m': p[2] };
  }
  let memory = null;
  if (memR.ok && memR.data) {
    const p = memR.data.split(' ');
    if (p.length >= 4) memory = { total: p[0], used: p[1], free: p[2], avail: p[3] };
  }
  return { load, memory, bootTime: uptimeR.ok && uptimeR.data ? uptimeR.data : null };
}

async function getDecks() {
  const r = await sshCmd(`cat ${DATA_PATH}/decks.json 2>/dev/null; echo`);
  if (!r.ok) return [];
  try { const d = JSON.parse(r.data); return Array.isArray(d) ? d : []; } catch { return []; }
}

async function saveDecks(decks) {
  return await writeFileLocked('decks.json', decks);
}

async function getBotDecks() {
  const r = await sshCmd(`cat ${DATA_PATH}/bot_decks.json 2>/dev/null; echo`);
  if (!r.ok) return {};
  try { return JSON.parse(r.data); } catch { return {}; }
}

function deckName(deck) {
  if (deck.name) return deck.name;
  const leader = deck.leader?.title || deck.leader?.id || '?';
  const base = deck.base?.title || deck.base?.id || '?';
  return `${leader} / ${base}`;
}

async function getMatchups() {
  const r = await driverCurl('/api/matchups');
  if (!r.ok || r.data === '___DRIVER_DOWN___') return { pairs: [], deckList: [] };
  try { return JSON.parse(r.data); } catch { return { pairs: [], deckList: [] }; }
}

async function getFallbackBotStatuses() {
  const r = await sshCmd(`for f in ${DATA_PATH}/bot_status_*.json; do [ -f "$f" ] && cat "$f" && echo "===BOTSTATUS==="; done`);
  if (!r.ok || !r.data) return [];
  const parts = r.data.split('===BOTSTATUS===').filter(Boolean);
  return parts.map(p => {
    try { return JSON.parse(p.trim()); } catch { return null; }
  }).filter(Boolean);
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

// ── Driver management ─────────────────────────────────

async function driverCurl(path) {
  return await sshCmd(`curl -sf http://localhost:${DRIVER_PORT}${path} 2>/dev/null || echo '___DRIVER_DOWN___'`);
}

async function checkDriver() {
  const r = await driverCurl('/api/health');
  if (r.ok && r.data && r.data !== '___DRIVER_DOWN___') {
    driverOk = true;
    driverErr = null;
    return true;
  }
  return false;
}

async function ensureDriver() {
  const running = await checkDriver();
  if (running) return true;

  log('Driver not running, starting it...');
  const logfile = `${DATA_PATH}/driver.log`;
  const startCmd = `nohup node ${BOT_DIR}/driver.js > ${logfile} 2>&1 & echo $!`;
  const r = await sshCmd(startCmd);
  if (!r.ok) {
    driverOk = false;
    driverErr = `failed to start driver: ${r.error}`;
    log(driverErr);
    return false;
  }
  log(`Driver started (PID: ${r.data})`);
  driverErr = null;

  // Wait for driver to come up
  for (let i = 0; i < 10; i++) {
    const up = await checkDriver();
    if (up) { log('Driver is ready'); return true; }
    await new Promise(r => setTimeout(r, 1000));
  }
  driverOk = false;
  driverErr = 'Driver started but not responding after 10s';
  log(driverErr);
  return false;
}

async function getDriverBots() {
  const r = await driverCurl('/api/bots');
  if (!r.ok || r.data === '___DRIVER_DOWN___') {
    driverOk = false;
    driverErr = 'driver not responding';
    return [];
  }
  driverOk = true;
  driverErr = null;
  try {
    const parsed = JSON.parse(r.data);
    return Array.isArray(parsed.bots) ? parsed.bots : [];
  } catch {
    return [];
  }
}

async function driverRemoveBot(name) {
  const r = await sshCmd(
    `curl -sf -X POST http://localhost:${DRIVER_PORT}/api/bots/remove -H 'Content-Type: application/json' -d '{"name":"${name}"}' 2>/dev/null || echo '___DRIVER_DOWN___'`
  );
  if (!r.ok || r.data === '___DRIVER_DOWN___') {
    driverOk = false;
    return { ok: false, error: r.error || 'driver not responding' };
  }
  try { return JSON.parse(r.data); } catch { return { ok: false, error: r.data }; }
}

// ── SSH tunnel ────────────────────────────────────────

let tunnelProcess = null;

function startTunnel() {
  if (tunnelProcess) {
    try { tunnelProcess.kill(); } catch {}
  }
  log(`Starting SSH tunnel: -R ${TUNNEL_PORT}:localhost:${PORT}`);
  tunnelProcess = spawn('ssh', [
    '-o', 'ServerAliveInterval=30',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=no',
    '-R', `${TUNNEL_PORT}:localhost:${PORT}`,
    '-N',
    `${SSH_USER}@${SSH_HOST}`
  ], { stdio: 'ignore' });
  tunnelProcess.on('exit', (code, signal) => {
    if (!tunnelProcess || tunnelProcess.killed) return;
    log(`Tunnel exited (code ${code}), restarting in 5s...`);
    setTimeout(startTunnel, 5000);
  });
  tunnelProcess.on('error', (err) => {
    log(`Tunnel error: ${err.message}`);
    setTimeout(startTunnel, 5000);
  });
  tunnelProcess.unref();
}

function stopTunnel() {
  if (tunnelProcess) {
    try { tunnelProcess.kill(); } catch {}
    tunnelProcess = null;
  }
}

// ── HTTP server ───────────────────────────────────────

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
  const method = req.method;

  log(`${method} ${url.pathname}`);

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // Bot status POST (from bots via SSH tunnel — DEPRECATED, driver handles this now)
  if (url.pathname === '/api/bot/status' && method === 'POST') {
    const body = await readBody(req);
    lastPostTime = Date.now();
    if (body.id && body.state) {
      body.updatedAt = lastPostTime;
      botStatusMap.set(body.id, body);
    }
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/status' && method === 'GET') {
    const [sshCheck, stats, recordingsCount, serverInfo, weightsMtime, recordingsMtime, fallbackStatuses, driverBots] = await Promise.all([
      sshCmd('echo ok'),
      readFile('stats.json'),
      getArrayLength('recordings.json'),
      getServerInfo(),
      getFileMtime('weights.json'),
      getFileMtime('recordings.json'),
      getFallbackBotStatuses(),
      getDriverBots()
    ]);

    // Priority: driver status > tunnel-pushed > file-based fallback
    const merged = new Map();
    for (const fb of fallbackStatuses) {
      if (fb.id) merged.set(fb.id, fb);
    }
    for (const [id, status] of botStatusMap) {
      merged.set(id, status);
    }
    for (const db of driverBots) {
      if (db.id) merged.set(db.id, db);
    }

    const tunnelOk = (Date.now() - lastPostTime) < 30000;

    log(`status: ${merged.size} bots, ${recordingsCount} recordings, tunnel=${tunnelOk}, ssh=${sshCheck.ok}, driver=${driverOk}`);

    sendJSON(res, 200, {
      timestamp: Date.now(),
      stats: stats || { gamesTrained: 0, accuracy: 0, examples: 0, lastTrainedAt: null },
      recordingsCount,
      weightsModified: weightsMtime || null,
      recordingsModified: recordingsMtime || null,
      bots: Array.from(merged.values()),
      server: serverInfo,
      sshOk: sshCheck.ok,
      sshError: sshCheck.ok ? null : sshCheck.error,
      tunnelOk,
      driverOk,
      driverError: driverErr
    });
    return;
  }

  if (url.pathname === '/api/logs' && method === 'GET') {
    const n = parseInt(url.searchParams.get('n') || '100', 10);
    sendJSON(res, 200, { logs: logEntries.slice(-n) });
    return;
  }

  if (url.pathname === '/api/bots/remove' && method === 'POST') {
    const body = await readBody(req);
    const name = body.name || '';
    log(`remove bot: "${name}"`);
    if (!name) { sendJSON(res, 400, { error: 'name required' }); return; }

    if (!driverOk) {
      sendJSON(res, 500, { error: 'driver not running' });
      return;
    }
    const result = await driverRemoveBot(name);
    log(`remove result: ok=${result.ok}, error="${result.error || ''}"`);
    if (result.ok) sendJSON(res, 200, result);
    else sendJSON(res, 404, { error: result.error || 'not found' });
    return;
  }

  // Deck CRUD
  if (url.pathname === '/api/decks' && method === 'GET') {
    const decks = await getDecks();
    sendJSON(res, 200, decks);
    return;
  }

  if (url.pathname === '/api/decks' && method === 'POST') {
    const body = await readBody(req);
    const cards = body.cards || body.deck;
    if (!body.leader || !body.base || !cards) {
      sendJSON(res, 400, { error: 'leader, base, and cards/deck required' });
      return;
    }
    const name = body.name || body.metadata?.name || deckName(body);
    log(`deck add/update: "${name}"`);
    const decks = await getDecks();
    const existing = decks.findIndex(d => d.name === name);
    const entry = { name, leader: body.leader, base: body.base, cards, sideboard: body.sideboard || [] };
    if (existing >= 0) decks[existing] = entry;
    else decks.push(entry);
    const r = await saveDecks(decks);
    if (r.ok) sendJSON(res, 200, { ok: true, name });
    else sendJSON(res, 500, { error: r.error });
    return;
  }

  if (url.pathname === '/api/decks' && method === 'DELETE') {
    const body = await readBody(req);
    const name = body.name;
    if (!name) { sendJSON(res, 400, { error: 'name required' }); return; }
    log(`deck delete: "${name}"`);
    let decks = await getDecks();
    decks = decks.filter(d => d.name !== name);
    const r = await saveDecks(decks);
    if (r.ok) sendJSON(res, 200, { ok: true });
    else sendJSON(res, 500, { error: r.error });
    return;
  }

  // Matchups
  if (url.pathname === '/api/matchups' && method === 'GET') {
    const matchups = await getMatchups();
    log(`matchups: ${matchups.pairs.length} pairs`);
    sendJSON(res, 200, matchups);
    return;
  }

  // Static files
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
  log(`SWU Bot Monitor started at http://0.0.0.0:${PORT}`);
  log(`SSH: ${SSH_USER}@${SSH_HOST}`);
  log(`Tunnel port: ${TUNNEL_PORT}`);
  log(`Bot dir: ${BOT_DIR}`);
  log(`Data: ${DATA_PATH}`);
  log(`Driver port: ${DRIVER_PORT}`);
  startTunnel();
  ensureDriver().then(ok => log(`Driver initial check: ${ok ? 'running' : 'not running'}`));
  setInterval(() => {
    ensureDriver().then(ok => { if (!ok) log('Driver restart attempted'); });
  }, 30000);
});

process.on('exit', stopTunnel);
process.on('SIGINT', () => { stopTunnel(); process.exit(); });
process.on('SIGTERM', () => { stopTunnel(); process.exit(); });
