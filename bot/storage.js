const fs = require('fs');
const path = require('path');
const { NeuralNet } = require('./model');

const DATA_DIR = path.join(__dirname, '..', 'server', 'data');

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

async function loadGameRecordings() {
  ensureDir();
  const p = path.join(DATA_DIR, 'recordings.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch { return []; }
}

async function saveGameRecording(recording) {
  const recordings = await loadGameRecordings();
  const idx = recordings.findIndex(r => r.gameId === recording.gameId);
  if (idx >= 0) recordings[idx] = recording;
  else recordings.push(recording);
  ensureDir();
  fs.writeFileSync(path.join(DATA_DIR, 'recordings.json'), JSON.stringify(recordings, null, 2), 'utf8');
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
}

module.exports = {
  loadModelWeights, saveModelWeights,
  loadModel, saveModelToFile,
  loadGameRecordings, saveGameRecording,
  loadTrainingStats, saveTrainingStats,
  saveBotStatus
};
