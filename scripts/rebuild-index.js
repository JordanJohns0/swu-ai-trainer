const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'server', 'data');
const REC_DIR = path.join(DATA_DIR, 'recordings');
const REC_INDEX_PATH = path.join(DATA_DIR, 'recording_index.json');
const oldPath = path.join(DATA_DIR, 'recordings.json');

function extractWinnerFromOldRec(rec) {
  let winner = null;
  if (Array.isArray(rec.winner)) {
    winner = rec.winner[0];
  } else if (typeof rec.winner === 'string' && rec.winner !== '[Circular]') {
    winner = rec.winner;
  }
  if (!winner && rec.states && rec.states.length > 0) {
    const last = rec.states[rec.states.length - 1];
    if (last && last.state && last.state.winners) {
      const w = Array.isArray(last.state.winners) ? last.state.winners[0] : last.state.winners;
      winner = (w && w.username) || (w && w.name) || (typeof w === 'string' ? w : null);
    }
  }
  return winner;
}

function extractWinnerFromFile(filePath) {
  const result = spawnSync('sh', ['-c', "cat '" + filePath.replace(/'/g, "'\\''") + "' | tr -d '\\n' | grep -o '\"winners\":\\[[^\\]]*\\]' | tail -1"], { timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status === 0 && result.stdout && result.stdout.trim()) {
    const line = result.stdout.trim();
    // Extract player name - try username, then name, then direct string
    const usernameMatch = line.match(/"username"\s*:\s*"([^"]+)"/);
    if (usernameMatch) return usernameMatch[1];
    const nameMatch = line.match(/"name"\s*:\s*"([^"]+)"/);
    if (nameMatch) return nameMatch[1];
    const strMatch = line.match(/"winners"\s*:\s*\[\s*"?([^"\]]+)"?\s*\]/);
    if (strMatch) return strMatch[1];
  }
  // Fallback: try top-level winner field
  const fallback = spawnSync('sh', ['-c', "grep -o '\"winner\":\"[^\"]*\"' '" + filePath.replace(/'/g, "'\\''") + "' | tail -1"], { timeout: 10000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (fallback.status === 0 && fallback.stdout && fallback.stdout.trim()) {
    const match = fallback.stdout.trim().match(/"winner":"([^"]+)"/);
    if (match && match[1] !== '[Circular]') return match[1];
  }
  return null;
}

function build() {
  const index = new Map();
  let oldCount = 0;
  let fileCount = 0;

  if (fs.existsSync(oldPath)) {
    try {
      const raw = fs.readFileSync(oldPath, 'utf8');
      const old = JSON.parse(raw);
      if (Array.isArray(old)) {
        for (const rec of old) {
          if (!rec || !rec.gameId || !rec.playerName) continue;
          const winner = extractWinnerFromOldRec(rec);
          const key = rec.gameId + '||' + rec.playerName;
          index.set(key, { gameId: rec.gameId, playerName: rec.playerName, deckName: rec.deckName || rec.playerName, winner });
          oldCount++;
        }
      }
    } catch (e) {
      console.error('Error reading old recordings.json:', e.message);
    }
  }

  if (fs.existsSync(REC_DIR)) {
    const files = fs.readdirSync(REC_DIR).filter(f => f.endsWith('.json'));
    let batchSize = 50;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      for (const f of batch) {
        const filePath = path.join(REC_DIR, f);
        try {
          // Extract gameId and playerName from filename
          const firstUnderscore = f.indexOf('_');
          const gameId = f.substring(0, firstUnderscore);
          const playerName = f.substring(firstUnderscore + 1, f.lastIndexOf('.json'));
          if (!gameId || !playerName) continue;

          const key = gameId + '||' + playerName;
          if (index.has(key)) continue;

          const winner = extractWinnerFromFile(filePath);
          index.set(key, { gameId, playerName, deckName: playerName, winner });
          fileCount++;
        } catch (e) {
          // skip
        }
      }
    }
  }

  const result = Array.from(index.values());
  const tmp = REC_INDEX_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(result), 'utf8');
  fs.renameSync(tmp, REC_INDEX_PATH);
  const withWinner = result.filter(e => e.winner && e.winner !== '[Circular]').length;
  console.log('Index rebuilt: ' + result.length + ' entries (' + withWinner + ' with valid winners)');
}

build().catch(e => console.error('Build failed:', e.message));
