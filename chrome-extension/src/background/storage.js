const SWU_DB_NAME = 'SWU_AI_TRAINER';
const SWU_DB_VERSION = 1;

function openSWUDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SWU_DB_NAME, SWU_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('games')) {
        const store = db.createObjectStore('games', { keyPath: 'gameId' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('winner', 'winner', { unique: false });
        store.createIndex('trained', 'trained', { unique: false });
      }
      if (!db.objectStoreNames.contains('weightSnapshots')) {
        db.createObjectStore('weightSnapshots', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('trainingStats')) {
        db.createObjectStore('trainingStats', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveGameRecording(recording) {
  const db = await openSWUDB();
  const tx = db.transaction('games', 'readwrite');
  tx.objectStore('games').put(recording);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getGameRecordings(filter = {}) {
  const db = await openSWUDB();
  const tx = db.transaction('games', 'readonly');
  const store = tx.objectStore('games');
  const all = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  let results = all;
  if (filter.untrainedOnly) results = results.filter((g) => !g.trained);
  if (filter.limit) results = results.slice(0, filter.limit);
  return results;
}

async function getGameRecordingCount() {
  const db = await openSWUDB();
  const tx = db.transaction('games', 'readonly');
  const store = tx.objectStore('games');
  return new Promise((resolve, reject) => {
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function markGamesTrained(gameIds) {
  const db = await openSWUDB();
  const tx = db.transaction('games', 'readwrite');
  const store = tx.objectStore('games');
  for (const id of gameIds) {
    const game = await new Promise((r) => {
      const req = store.get(id);
      req.onsuccess = () => r(req.result);
    });
    if (game) {
      game.trained = true;
      store.put(game);
    }
  }
  return new Promise((resolve) => { tx.oncomplete = () => resolve(); });
}

async function deleteAllGameRecordings() {
  const db = await openSWUDB();
  const tx = db.transaction('games', 'readwrite');
  tx.objectStore('games').clear();
  return new Promise((resolve) => { tx.oncomplete = () => resolve(); });
}

async function clearTrainingStats() {
  const db = await openSWUDB();
  const tx = db.transaction('trainingStats', 'readwrite');
  tx.objectStore('trainingStats').clear();
  return new Promise((resolve) => { tx.oncomplete = () => resolve(); });
}

async function saveSetting(key, value) {
  const db = await openSWUDB();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put({ key, value });
  return new Promise((resolve) => { tx.oncomplete = () => resolve(); });
}

async function getSetting(key, defaultVal = null) {
  const db = await openSWUDB();
  const tx = db.transaction('settings', 'readonly');
  const store = tx.objectStore('settings');
  return new Promise((resolve) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result?.value ?? defaultVal);
    req.onerror = () => resolve(defaultVal);
  });
}

async function saveModelWeights(weights) {
  const db = await openSWUDB();
  const tx = db.transaction('weightSnapshots', 'readwrite');
  tx.objectStore('weightSnapshots').put({ id: 'latest', weights, updatedAt: Date.now() });
  return new Promise((resolve) => { tx.oncomplete = () => resolve(); });
}

async function loadModelWeights() {
  const db = await openSWUDB();
  const tx = db.transaction('weightSnapshots', 'readonly');
  const store = tx.objectStore('weightSnapshots');
  return new Promise((resolve) => {
    const req = store.get('latest');
    req.onsuccess = () => resolve(req.result?.weights ?? null);
    req.onerror = () => resolve(null);
  });
}

async function updateTrainingStats(stats) {
  const db = await openSWUDB();
  const tx = db.transaction('trainingStats', 'readwrite');
  const store = tx.objectStore('trainingStats');
  const existing = await new Promise((r) => {
    const req = store.get('main');
    req.onsuccess = () => r(req.result);
  });
  const merged = { ...(existing || { id: 'main' }), ...stats, updatedAt: Date.now() };
  store.put(merged);
  return new Promise((resolve) => { tx.oncomplete = () => resolve(); });
}

async function getTrainingStats() {
  const db = await openSWUDB();
  const tx = db.transaction('trainingStats', 'readonly');
  const store = tx.objectStore('trainingStats');
  return new Promise((resolve) => {
    const req = store.get('main');
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}
