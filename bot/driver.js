const http = require('http');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const PORT = parseInt(process.env.DRIVER_PORT || '3458', 10);
const WORKER_PATH = path.join(__dirname, 'worker.js');
const DATA_DIR = path.join(__dirname, '..', 'server', 'data');
const DECKS_PATH = path.join(DATA_DIR, 'decks.json');
const RECORDINGS_PATH = path.join(DATA_DIR, 'recordings.json');
const REC_DIR = path.join(DATA_DIR, 'recordings');

const workers = new Map();
const statusCache = new Map();
const workerOutputs = new Map();

function log(...args) {
  const t = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${t}] [DRIVER]`, ...args);
}

function readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    log(`error reading ${path.basename(filePath)}: ${e.message}`);
    return null;
  }
}

function readDecks() {
  const decks = readJSON(DECKS_PATH);
  return Array.isArray(decks) ? decks : [];
}

function loadAllRecordings() {
  const results = [];
  if (fs.existsSync(REC_DIR)) {
    for (const f of fs.readdirSync(REC_DIR)) {
      if (!f.endsWith('.json')) continue;
      try { results.push(JSON.parse(fs.readFileSync(path.join(REC_DIR, f), 'utf8'))); } catch {}
    }
  }
  const old = readJSON(RECORDINGS_PATH);
  if (Array.isArray(old)) {
    for (const rec of old) {
      if (rec && rec.gameId && !results.some(r => r.gameId === rec.gameId && r.playerName === rec.playerName)) {
        results.push(rec);
      }
    }
  }
  return results;
}

function getMatchups() {
  const recordings = loadAllRecordings();
  if (recordings.length === 0) return { pairs: [], deckList: [] };

  const decks = readDecks();
  const deckNames = decks.map(d => d.name).filter(Boolean);
  deckNames.push('cad-bane');

  const games = {};
  for (const rec of recordings) {
    if (!rec.gameId || !rec.playerName) continue;
    if (!games[rec.gameId]) games[rec.gameId] = [];
    games[rec.gameId].push(rec);
  }

  const pairMap = {};
  for (const [gameId, recs] of Object.entries(games)) {
    const decksInGame = {};
    for (const rec of recs) {
      if (rec.deckName) decksInGame[rec.playerName] = rec.deckName;
    }
    const names = Object.keys(decksInGame);
    if (names.length < 2) continue;

    let deckA, deckB, p1Name, p2Name;
    p1Name = names[0]; deckA = decksInGame[p1Name];
    p2Name = names[1]; deckB = decksInGame[p2Name];

    const winner = recs[0].winner;
    if (!winner) continue;
    const w = Array.isArray(winner) ? winner[0] : winner;
    const winnerName = w?.username || w?.name || (typeof w === 'string' ? w : null);
    if (!winnerName) continue;

    const pairId = [deckA, deckB].sort().join('||');
    if (!pairMap[pairId]) pairMap[pairId] = { deckA, deckB, aWins: 0, bWins: 0, total: 0 };
    pairMap[pairId].total++;
    if (winnerName === p1Name) pairMap[pairId].aWins++;
    else pairMap[pairId].bWins++;
  }

  const pairs = Object.values(pairMap)
    .filter(p => p.total > 0)
    .map(p => ({ ...p, ties: 0 }));

  return { pairs, deckList: [...new Set(deckNames)] };
}

function sanitizeId(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'bot';
}

function addBot(botId, botName, deckName) {
  if (workers.has(botId)) {
    log(`already running: ${botId}`);
    return { ok: false, error: 'already running' };
  }

  const env = {
    ...process.env,
    BOT_ID: botId,
    BOT_NAME: botName || deckName || botId,
    DECK_NAME: deckName || botId,
    SERVER_URL: process.env.SERVER_URL || 'http://localhost:9500'
  };

  const child = fork(WORKER_PATH, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  workerOutputs.set(botId, '');
  child.stdout.on('data', (d) => {
    const s = d.toString();
    workerOutputs.set(botId, (workerOutputs.get(botId) + s).slice(-10000));
    console.log(`[${botId}] ${s.trimEnd()}`);
  });
  child.stderr.on('data', (d) => {
    const s = d.toString();
    workerOutputs.set(botId, (workerOutputs.get(botId) + s).slice(-10000));
    console.error(`[${botId}] ${s.trimEnd()}`);
  });

  child.on('message', (msg) => {
    if (msg && msg.type === 'status') {
      statusCache.set(msg.id, { ...msg, updatedAt: Date.now(), deckName: deckName || botName || botId });
      log(`IPC status from ${msg.name}: ${msg.state}`);
    } else {
      log(`IPC unknown from ${botId}: ${JSON.stringify(msg).substring(0, 100)}`);
    }
  });

  child.on('exit', (code, signal) => {
    log(`${botId} exited (code=${code}, signal=${signal})`);
    statusCache.set(botId, { id: botId, name: botName || deckName || botId, state: 'exited', exitCode: code, message: `exited with code ${code}`, updatedAt: Date.now(), deckName: deckName || botName || botId });
    workerOutputs.delete(botId);
    workers.delete(botId);
  });

  child.on('error', (err) => {
    log(`${botId} error: ${err.message}`);
    statusCache.set(botId, { id: botId, name: botName || deckName || botId, state: 'error', message: err.message, updatedAt: Date.now(), deckName: deckName || botName || botId });
    workerOutputs.delete(botId);
    workers.delete(botId);
  });

  workers.set(botId, { child, startedAt: Date.now() });
  statusCache.set(botId, { id: botId, name: botName || deckName || botId, state: 'starting', message: 'Worker forked', updatedAt: Date.now(), deckName: deckName || botName || botId });

  log(`added: ${botId} (pid ${child.pid}, deck: ${deckName})`);
  return { ok: true, pid: child.pid };
}

function removeBot(name) {
  const entry = workers.get(name);
  if (!entry) {
    log(`not found: ${name}`);
    return { ok: false, error: 'not found' };
  }
  entry.child.kill();
  workers.delete(name);
  log(`removed: ${name}`);
  return { ok: true };
}

function initBotsFromDecks() {
  const decks = readDecks();
  const defaultDeck = 'cad-bane';
  let spawned = 0;

  for (const deck of decks) {
    const deckName = deck.name;
    if (!deckName || deckName === defaultDeck) continue;
    const botId = sanitizeId(deckName);
    const result = addBot(botId, deckName, deckName);
    if (result.ok) spawned++;
  }

  log(`initialized ${spawned} bot(s) from ${decks.length} custom deck(s)`);
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

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  if (url.pathname === '/api/health' && method === 'GET') {
    sendJSON(res, 200, { ok: true, uptime: process.uptime(), bots: workers.size });
    return;
  }

  if (url.pathname === '/api/bots' && method === 'GET') {
    const bots = Array.from(statusCache.values()).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    sendJSON(res, 200, { bots });
    return;
  }

  if (url.pathname === '/api/bots/remove' && method === 'POST') {
    const body = await readBody(req);
    const name = body.name;
    if (!name) { sendJSON(res, 400, { error: 'name required' }); return; }
    const result = removeBot(name);
    sendJSON(res, result.ok ? 200 : 404, result);
    return;
  }

  if (url.pathname === '/api/matchups' && method === 'GET') {
    const matchups = getMatchups();
    log(`matchups: ${matchups.pairs.length} pairs`);
    sendJSON(res, 200, matchups);
    return;
  }

  if (url.pathname === '/api/bot-logs' && method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id) { sendJSON(res, 400, { error: 'id required' }); return; }
    const output = workerOutputs.get(id);
    if (output === undefined) { sendJSON(res, 404, { error: 'bot not found' }); return; }
    sendJSON(res, 200, { id, lines: output.split('\n').filter(Boolean) });
    return;
  }

  sendJSON(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  log(`Driver listening on port ${PORT}`);
  initBotsFromDecks();
});

process.on('exit', () => {
  for (const [name, entry] of workers) {
    entry.child.kill();
  }
});

process.on('SIGINT', () => { process.exit(); });
process.on('SIGTERM', () => { process.exit(); });
