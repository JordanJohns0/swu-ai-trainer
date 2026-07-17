const fs = require('fs');
const path = require('path');
const http = require('http');
const { NeuralNet } = require('./model');

const DATA_DIR = path.join(__dirname, '..', 'server', 'data');
const MONITOR_URL = process.env.MONITOR_URL || '';

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

async function loadModelWeights() {
  ensureDir();
  const p = path.join(DATA_DIR, 'weights.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function saveModelWeights(weights) {
  ensureDir();
  const p = path.join(DATA_DIR, 'weights.json');
  fs.writeFileSync(p, JSON.stringify(weights, null, 2), 'utf8');
}

async function loadModel() {
  const model = new NeuralNet();
  try {
    const w = await loadModelWeights();
    if (w && w.layers) model.setWeights(w);
  } catch (e) { /* fresh model */ }
  return model;
}

async function saveModelToFile(model) {
  await saveModelWeights(model.save());
}

function safeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  }, 2);
}

const REC_DIR = path.join(DATA_DIR, 'recordings');

function loadAllRecordings() {
  ensureDir();
  const results = [];
  if (fs.existsSync(REC_DIR)) {
    for (const f of fs.readdirSync(REC_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(REC_DIR, f), 'utf8');
        const rec = JSON.parse(raw);
        if (rec && rec.gameId) results.push(rec);
      } catch {}
    }
  }
  return results;
}

async function loadGameRecordings() {
  const old = loadAllRecordings();
  const oldFile = path.join(DATA_DIR, 'recordings.json');
  if (fs.existsSync(oldFile)) {
    try {
      const raw = fs.readFileSync(oldFile, 'utf8');
      const legacy = JSON.parse(raw);
      if (Array.isArray(legacy)) {
        for (const rec of legacy) {
          if (rec && rec.gameId && !old.some(r => r.gameId === rec.gameId && r.playerName === rec.playerName)) {
            old.push(rec);
          }
        }
      }
    } catch {}
  }
  return old;
}

async function saveGameRecording(recording) {
  ensureDir();
  if (!fs.existsSync(REC_DIR)) fs.mkdirSync(REC_DIR, { recursive: true });
  const safeName = (recording.playerName || 'unknown').replace(/[<>:"/\\|?*]/g, '_');
  const filePath = path.join(REC_DIR, `${recording.gameId}_${safeName}.json`);
  const out = safeStringify(recording);
  if (out === undefined) { console.error('saveGameRecording: safeStringify returned undefined'); return; }
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, filePath);
}

const TRAINING_PROGRESS_PATH = path.join(DATA_DIR, 'training_progress.json');

async function saveTrainingProgress(progress) {
  ensureDir();
  try {
    fs.writeFileSync(TRAINING_PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf8');
  } catch {}
}

async function loadTrainingProgress() {
  ensureDir();
  try {
    const raw = fs.readFileSync(TRAINING_PROGRESS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function clearTrainingProgress() {
  try { fs.unlinkSync(TRAINING_PROGRESS_PATH); } catch {}
}

async function loadTrainingStats() {
  ensureDir();
  const p = path.join(DATA_DIR, 'stats.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch { return { gamesTrained: 0, lastTrainedAt: null, accuracy: 0, examples: 0 }; }
}

async function saveTrainingStats(stats) {
  ensureDir();
  fs.writeFileSync(path.join(DATA_DIR, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8');
}

async function postToMonitor(endpoint, data) {
  if (!MONITOR_URL) return;
  try {
    const url = new URL(MONITOR_URL);
    const body = JSON.stringify(data);
    return new Promise((resolve) => {
      const req = http.request({
        hostname: url.hostname,
        port: parseInt(url.port, 10) || 80,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 3000
      }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => resolve());
      req.write(body);
      req.end();
    });
  } catch { /* ignore */ }
}

async function saveBotStatus(id, name, status) {
  ensureDir();
  const data = {
    id,
    name,
    state: status.state || 'unknown',
    gameId: status.gameId || null,
    phase: status.phase || null,
    opponent: status.opponent || null,
    message: status.message || '',
    updatedAt: Date.now()
  };
  fs.writeFileSync(path.join(DATA_DIR, `bot_status_${id}.json`), JSON.stringify(data, null, 2), 'utf8');
  await postToMonitor('/api/bot/status', data);
}

module.exports = {
  loadModelWeights, saveModelWeights,
  loadModel, saveModelToFile,
  loadGameRecordings, saveGameRecording,
  loadTrainingStats, saveTrainingStats,
  saveTrainingProgress, loadTrainingProgress, clearTrainingProgress,
  saveBotStatus
};
