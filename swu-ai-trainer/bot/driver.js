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
const REC_INDEX_PATH = path.join(DATA_DIR, 'recording_index.json');

const workers = new Map();
const statusCache = new Map();
const workerOutputs = new Map();
const recordingIndex = new Map(); // key: gameId||playerName -> { gameId, playerName, deckName, winner }
let matchupsCache = null;
let matchupsCacheTime = 0;
const MATCHUPS_CACHE_TTL = 60000; // recompute every 60s
let trainingProgress = null; // in-memory training progress from IPC

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

function loadRecordingIndex() {
  const idx = readJSON(REC_INDEX_PATH);
  if (idx && Array.isArray(idx)) {
    recordingIndex.clear();
    for (const entry of idx) {
      if (entry && entry.gameId && entry.playerName) {
        recordingIndex.set(entry.gameId + '||' + entry.playerName, entry);
      }
    }
    log(`loaded recording index: ${recordingIndex.size} entries`);
  }
}

function saveRecordingIndex() {
  const arr = Array.from(recordingIndex.values());
  const tmp = REC_INDEX_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr), 'utf8');
  fs.renameSync(tmp, REC_INDEX_PATH);
}

function addToRecordingIndex(entry) {
  if (!entry || !entry.gameId || !entry.playerName) return;
  const key = entry.gameId + '||' + entry.playerName;
  const existing = recordingIndex.get(key);
  if (existing && existing.winner && !entry.winner) return;
  recordingIndex.set(key, entry);
}

function getMatchupEntries() {
  const entries = [];
  for (const entry of recordingIndex.values()) {
    entries.push(entry);
  }
  return entries;
}

function computeMatchupsFromIndex() {
  const entries = getMatchupEntries();
  if (entries.length === 0) return { pairs: [], deckList: [] };

  const decks = readDecks();
  const deckNames = decks.map(d => d.name).filter(Boolean);
  deckNames.push('cad-bane');

  const games = {};
  for (const entry of entries) {
    if (!entry.gameId || !entry.playerName) continue;
    if (!games[entry.gameId]) games[entry.gameId] = [];
    games[entry.gameId].push(entry);
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

    const rec0 = recs[0];
    let winnerName = null;
    const winner = rec0.winner;
    if (winner) {
      if (Array.isArray(winner)) {
        winnerName = winner[0] || null;
      } else if (typeof winner === 'string') {
        winnerName = winner;
      }
    }
    if (!winnerName) continue;

    const pairId = [deckA, deckB].sort().join('||');
    if (!pairMap[pairId]) pairMap[pairId] = { deckA, deckB, aWins: 0, bWins: 0, total: 0, lastRecordedAt: 0 };
    pairMap[pairId].total++;
    const ts = Math.max(recs[0]?.recordedAt || 0, recs[1]?.recordedAt || 0);
    if (ts > pairMap[pairId].lastRecordedAt) pairMap[pairId].lastRecordedAt = ts;
    const winnerDeck = decksInGame[winnerName];
    if (winnerDeck === pairMap[pairId].deckA) pairMap[pairId].aWins++;
    else if (winnerDeck === pairMap[pairId].deckB) pairMap[pairId].bWins++;
  }

  const pairs = Object.values(pairMap)
    .filter(p => p.total > 0)
    .map(p => ({ ...p, ties: 0 }));

  return { pairs, deckList: [...new Set(deckNames)] };
}

function recomputeMatchups() {
  try {
    matchupsCache = computeMatchupsFromIndex();
    matchupsCacheTime = Date.now();
    log(`matchups recomputed: ${matchupsCache.pairs.length} pairs from ${recordingIndex.size} entries`);
  } catch (e) {
    log(`matchups recompute error: ${e.message}`);
  }
}

function refreshMatchups() {
  recomputeMatchups();
  saveRecordingIndex();
}

function getCachedMatchups() {
  const now = Date.now();
  if (matchupsCache && (now - matchupsCacheTime) < MATCHUPS_CACHE_TTL) {
    return matchupsCache;
  }
  if (matchupsCache) return matchupsCache;
  return { pairs: [], deckList: [] };
}

function extractWinnerFromLastState(rec) {
  if (!rec || !rec.states || rec.states.length === 0) return null;
  const lastState = rec.states[rec.states.length - 1];
  if (!lastState || !lastState.state || !lastState.state.winners) return null;
  const winners = lastState.state.winners;
  if (Array.isArray(winners)) {
    const w = winners[0];
    if (w && w.username) return w.username;
    if (w && w.name) return w.name;
    if (typeof w === 'string') return w;
  }
  return null;
}

function buildIndexFromOldRecordings() {
  const old = readJSON(RECORDINGS_PATH);
  if (!Array.isArray(old)) return 0;
  let added = 0;
  for (const rec of old) {
    if (!rec || !rec.gameId || !rec.playerName) continue;
    let winnerName = null;
    const winner = rec.winner;
    if (winner === '[Circular]' || (Array.isArray(winner) && winner[0] === '[Circular]')) {
      winnerName = extractWinnerFromLastState(rec);
    } else if (Array.isArray(winner)) {
      winnerName = winner[0] || null;
    } else if (typeof winner === 'string') {
      winnerName = winner;
    }
    const key = rec.gameId + '||' + rec.playerName;
    if (!recordingIndex.has(key)) {
      recordingIndex.set(key, {
        gameId: rec.gameId,
        playerName: rec.playerName,
        deckName: rec.deckName || rec.playerName,
        winner: winnerName,
        recordedAt: rec.completedAt || rec.timestamp || 0
      });
      added++;
    }
  }
  return added;
}

function buildIndexFromRecordingFiles() {
  if (!fs.existsSync(REC_DIR)) return 0;
  let added = 0;
  for (const f of fs.readdirSync(REC_DIR)) {
    if (!f.endsWith('.json')) continue;
    const gameId = f.substring(0, f.indexOf('_'));
    const playerName = f.substring(f.indexOf('_') + 1, f.lastIndexOf('.json'));
    if (!gameId || !playerName) continue;
    const key = gameId + '||' + playerName;
    if (recordingIndex.has(key)) continue;
    try {
      const raw = fs.readFileSync(path.join(REC_DIR, f), 'utf8');
      const rec = JSON.parse(raw);
      if (!rec || !rec.gameId) continue;
      let winnerName = null;
      const winner = rec.winner;
      if (winner === '[Circular]' || (Array.isArray(winner) && winner[0] === '[Circular]')) {
        winnerName = extractWinnerFromLastState(rec);
      } else if (Array.isArray(winner)) {
        winnerName = winner[0] || null;
      } else if (typeof winner === 'string') {
        winnerName = winner;
      }
      recordingIndex.set(key, {
        gameId: rec.gameId,
        playerName: rec.playerName || playerName,
        deckName: rec.deckName || rec.playerName || playerName,
        winner: winnerName,
        recordedAt: rec.completedAt || rec.timestamp || 0
      });
      added++;
    } catch {}
  }
  return added;
}

function initRecordingIndex() {
  log('building recording index...');
  const t0 = Date.now();
  const fromOld = buildIndexFromOldRecordings();
  const fromFiles = buildIndexFromRecordingFiles();
  saveRecordingIndex();
  log(`recording index built: ${recordingIndex.size} entries (${fromOld} from old, ${fromFiles} from files) in ${Date.now() - t0}ms`);
  recomputeMatchups();
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
    } else if (msg && msg.type === 'training_progress') {
      trainingProgress = { ...msg, type: undefined, updatedAt: Date.now() };
    } else if (msg && msg.type === 'recording_metadata') {
      addToRecordingIndex({
        gameId: msg.gameId,
        playerName: msg.playerName,
        deckName: msg.deckName || deckName || botName || botId,
        winner: msg.winner,
        recordedAt: msg.recordedAt || Date.now()
      });
      saveRecordingIndex();
      matchupsCache = null;
      recomputeMatchups();
    } else {
      log(`IPC unknown from ${botId}: ${JSON.stringify(msg).substring(0, 100)}`);
    }
  });

  child.on('exit', (code, signal) => {
    log(`${botId} exited (code=${code}, signal=${signal})`);
    statusCache.set(botId, { id: botId, name: botName || deckName || botId, state: 'exited', exitCode: code, message: `exited with code ${code}`, updatedAt: Date.now(), deckName: deckName || botName || botId });
    workerOutputs.delete(botId);
    workers.delete(botId);
    // Auto-restart exited workers after 30s delay
    setTimeout(() => {
      if (!workers.has(botId)) {
        log(`auto-restarting ${botId}`);
        addBot(botId, botName || deckName || botId, deckName || botName || botId);
      }
    }, 30000);
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
  if (entry) {
    entry.child.kill();
    workers.delete(name);
  }
  statusCache.delete(name);
  workerOutputs.delete(name);
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
    const matchups = getCachedMatchups();
    sendJSON(res, 200, matchups);
    return;
  }

  if (url.pathname === '/api/weights' && method === 'GET') {
    const weights = readJSON(path.join(DATA_DIR, 'weights.json'));
    sendJSON(res, 200, weights || { layers: [] });
    return;
  }

  if (url.pathname === '/api/training-progress' && method === 'GET') {
    sendJSON(res, 200, trainingProgress || {});
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

const BIND_HOST = process.env.DRIVER_BIND_HOST || '127.0.0.1';
server.listen(PORT, BIND_HOST, () => {
  log(`Driver listening on ${BIND_HOST}:${PORT}`);
  initBotsFromDecks();
  loadRecordingIndex();
  if (recordingIndex.size === 0) {
    setTimeout(initRecordingIndex, 1000);
  } else {
    recomputeMatchups();
  }
  setInterval(refreshMatchups, MATCHUPS_CACHE_TTL);
});

process.on('exit', () => {
  for (const [name, entry] of workers) {
    entry.child.kill();
  }
});

process.on('SIGINT', () => { process.exit(); });
process.on('SIGTERM', () => { process.exit(); });
