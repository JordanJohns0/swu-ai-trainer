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

// In-memory bot statuses received via POST /api/bot/status
const botStatusMap = new Map();

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

async function saveBotDecks(config) {
  return await writeFileLocked('bot_decks.json', config);
}

function deckName(deck) {
  if (deck.name) return deck.name;
  const leader = deck.leader?.title || deck.leader?.id || '?';
  const base = deck.base?.title || deck.base?.id || '?';
  return `${leader} / ${base}`;
}

async function getMatchups() {
  const [recordings, botDecks, decks] = await Promise.all([
    readFile('recordings.json'),
    getBotDecks(),
    getDecks()
  ]);
  if (!Array.isArray(recordings)) return { pairs: [], deckList: [] };

  const deckNames = decks.map(d => d.name).filter(Boolean);
  deckNames.push('cad-bane');

  const pairMap = {};

  function getWinnerName(winner) {
    if (!winner) return null;
    if (Array.isArray(winner)) {
      if (winner.length === 0) return null;
      const w = winner[0];
      return w?.username || w?.name || null;
    }
    return typeof winner === 'string' ? winner : (winner?.username || winner?.name || null);
  }

  for (const rec of recordings) {
    if (!rec.playerName || !rec.winner) continue;

    const myDeck = rec.deckName || botDecks[rec.playerName];
    if (!myDeck) continue;

    const oppName = Object.keys(botDecks).find(n => n !== rec.playerName);
    const oppDeck = oppName ? botDecks[oppName] : null;
    if (!oppDeck) continue;

    const pairId = [myDeck, oppDeck].sort().join('||');
    if (!pairMap[pairId]) pairMap[pairId] = [];
    pairMap[pairId].push({ myDeck, oppDeck, winner: rec.winner, playerName: rec.playerName });
  }

  const pairs = [];
  for (const [pairId, games] of Object.entries(pairMap)) {
    const recent = games.slice(-50);
    const [d1, d2] = pairId.split('||');
    let d1Wins = 0, d2Wins = 0, ties = 0;
    for (const g of recent) {
      const winnerName = getWinnerName(g.winner);
      if (!winnerName) { ties++; continue; }
      if (winnerName === g.playerName) {
        if (g.myDeck === d1) d1Wins++;
        else d2Wins++;
      } else {
        if (g.myDeck === d1) d2Wins++;
        else d1Wins++;
      }
    }
    if (d1Wins + d2Wins + ties > 0) {
      pairs.push({
        deckA: d1,
        deckB: d2,
        aWins: d1Wins,
        bWins: d2Wins,
        ties,
        total: recent.length
      });
    }
  }

  return { pairs, deckList: [...new Set(deckNames)] };
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

// SSH reverse tunnel management
let tunnelProcess = null;

function startTunnel() {
  if (tunnelProcess) {
    try { tunnelProcess.kill(); } catch {}
  }
  console.log(`Starting SSH tunnel: -R ${TUNNEL_PORT}:localhost:${PORT}`);
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
    if (code !== 0 && !tunnelProcess.killed) {
      console.log(`Tunnel exited (code ${code}), restarting in 5s...`);
      setTimeout(startTunnel, 5000);
    }
  });
  tunnelProcess.on('error', (err) => {
    console.error('Tunnel error:', err.message);
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

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // Bot status POST (from bots via SSH tunnel)
  if (url.pathname === '/api/bot/status' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.id && body.state) {
      body.updatedAt = Date.now();
      botStatusMap.set(body.id, body);
    }
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    const [sshCheck, stats, recordingsCount, serverInfo, weightsMtime, recordingsMtime, botDecks] = await Promise.all([
      sshCmd('echo ok'),
      readFile('stats.json'),
      getArrayLength('recordings.json'),
      getServerInfo(),
      getFileMtime('weights.json'),
      getFileMtime('recordings.json'),
      getBotDecks()
    ]);

    sendJSON(res, 200, {
      timestamp: Date.now(),
      stats: stats || { gamesTrained: 0, accuracy: 0, examples: 0, lastTrainedAt: null },
      recordingsCount,
      weightsModified: weightsMtime || null,
      recordingsModified: recordingsMtime || null,
      bots: Array.from(botStatusMap.values()),
      botDecks,
      server: serverInfo,
      sshOk: sshCheck.ok,
      sshError: sshCheck.ok ? null : sshCheck.error
    });
    return;
  }

  if (url.pathname === '/api/bots/add' && req.method === 'POST') {
    const body = await readBody(req);
    const name = body.name || '';
    if (!name) { sendJSON(res, 400, { error: 'name required' }); return; }
    const escaped = name.replace(/'/g, "'\\''");
    const pidCmd = `nohup /usr/bin/env MONITOR_URL='http://localhost:${TUNNEL_PORT}' BOT_NAME='${escaped}' node ${BOT_DIR}/bot.js > /dev/null 2>&1 & PID=$!; echo $PID > ${DATA_PATH}/bot_pid_${escaped}; echo $PID`;
    const r = await sshCmd(pidCmd);
    if (r.ok) sendJSON(res, 200, { ok: true, pid: r.data, name });
    else sendJSON(res, 500, { error: r.error });
    return;
  }

  if (url.pathname === '/api/bots/remove' && req.method === 'POST') {
    const body = await readBody(req);
    const name = body.name || '';
    if (!name) { sendJSON(res, 400, { error: 'name required' }); return; }
    const escaped = name.replace(/'/g, "'\\''");
    const killCmd = `PID=$(cat ${DATA_PATH}/bot_pid_${escaped} 2>/dev/null); if [ -n "$PID" ] && kill -0 $PID 2>/dev/null; then kill $PID 2>/dev/null; echo "killed $PID"; else echo "not running"; fi; rm -f ${DATA_PATH}/bot_pid_${escaped} ${DATA_PATH}/bot_status_${escaped}.json`;
    const r = await sshCmd(killCmd);
    if (r.ok) sendJSON(res, 200, { ok: true, result: r.data, name });
    else sendJSON(res, 500, { error: r.error });
    return;
  }

  // Bot deck assignment
  if (url.pathname === '/api/bots/deck' && req.method === 'POST') {
    const body = await readBody(req);
    const { botName, deckName: deck } = body;
    if (!botName) { sendJSON(res, 400, { error: 'botName required' }); return; }
    const config = await getBotDecks();
    if (deck) config[botName] = deck;
    else delete config[botName];
    const r = await saveBotDecks(config);
    if (r.ok) sendJSON(res, 200, { ok: true });
    else sendJSON(res, 500, { error: r.error });
    return;
  }

  // Deck CRUD
  if (url.pathname === '/api/decks' && req.method === 'GET') {
    const decks = await getDecks();
    sendJSON(res, 200, decks);
    return;
  }

  if (url.pathname === '/api/decks' && req.method === 'POST') {
    const body = await readBody(req);
    const cards = body.cards || body.deck;
    if (!body.leader || !body.base || !cards) {
      sendJSON(res, 400, { error: 'leader, base, and cards/deck required' });
      return;
    }
    const name = body.name || body.metadata?.name || deckName(body);
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

  if (url.pathname === '/api/decks' && req.method === 'DELETE') {
    const body = await readBody(req);
    const name = body.name;
    if (!name) { sendJSON(res, 400, { error: 'name required' }); return; }
    let decks = await getDecks();
    decks = decks.filter(d => d.name !== name);
    const r = await saveDecks(decks);
    if (r.ok) sendJSON(res, 200, { ok: true });
    else sendJSON(res, 500, { error: r.error });
    return;
  }

  // Matchups
  if (url.pathname === '/api/matchups' && req.method === 'GET') {
    const matchups = await getMatchups();
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
  console.log(`SWU Bot Monitor started at http://localhost:${PORT}`);
  console.log(`SSH: ${SSH_USER}@${SSH_HOST}`);
  console.log(`Tunnel port: ${TUNNEL_PORT}`);
  console.log(`Bot dir: ${BOT_DIR}`);
  console.log(`Data: ${DATA_PATH}`);
  startTunnel();
});

process.on('exit', stopTunnel);
process.on('SIGINT', () => { stopTunnel(); process.exit(); });
process.on('SIGTERM', () => { stopTunnel(); process.exit(); });
