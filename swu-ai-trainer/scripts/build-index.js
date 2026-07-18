const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'server', 'data');
const REC_DIR = path.join(DATA_DIR, 'recordings');
const REC_INDEX_PATH = path.join(DATA_DIR, 'recording_index.json');
const oldPath = path.join(DATA_DIR, 'recordings.json');

const CHUNK_SIZE = 4096;

function extractFields(buf) {
  const s = buf.toString('utf8').replace(/\0/g, '');
  const gameId = (s.match(/"gameId"\s*:\s*"([^"]+)"/) || [])[1];
  const playerName = (s.match(/"playerName"\s*:\s*"([^"]+)"/) || [])[1];
  const deckName = (s.match(/"deckName"\s*:\s*"([^"]+)"/) || [])[1];
  return { gameId, playerName, deckName };
}

function extractWinner(buf) {
  const s = buf.toString('utf8').replace(/\0/g, '');
  const winnerMatch = s.match(/"winner"\s*:\s*"([^"]+)"/);
  if (winnerMatch) return winnerMatch[1];
  const winnersMatch = s.match(/"winners"\s*:\s*\[([^\]]+)\]/);
  if (winnersMatch) {
    const inner = winnersMatch[1];
    const nameMatch = inner.match(/"username"\s*:\s*"([^"]+)"/);
    if (nameMatch) return nameMatch[1];
    const strMatch = inner.match(/"([^"]+)"\s*[}\]\]]/);
    if (strMatch) return strMatch[1];
  }
  return null;
}

async function build() {
  const index = new Map();

  if (fs.existsSync(oldPath)) {
    try {
      const raw = fs.readFileSync(oldPath, 'utf8');
      const old = JSON.parse(raw);
      if (Array.isArray(old)) {
        for (const rec of old) {
          if (!rec || !rec.gameId || !rec.playerName) continue;
          let winner = null;
          if (Array.isArray(rec.winner)) {
            winner = rec.winner[0];
          } else if (typeof rec.winner === 'string') {
            winner = rec.winner;
          }
          if (winner === '[Circular]') {
            if (rec.states && rec.states.length > 0) {
              const last = rec.states[rec.states.length - 1];
              if (last && last.state && last.state.winners) {
                const w = Array.isArray(last.state.winners) ? last.state.winners[0] : last.state.winners;
                winner = (w && w.username) || (w && w.name) || (typeof w === 'string' ? w : null);
              }
            }
          }
          const key = rec.gameId + '||' + rec.playerName;
          index.set(key, {
            gameId: rec.gameId,
            playerName: rec.playerName,
            deckName: rec.deckName || rec.playerName,
            winner
          });
        }
      }
    } catch (e) {
      console.error('Error reading old recordings.json:', e.message);
    }
  }

  if (fs.existsSync(REC_DIR)) {
    const files = fs.readdirSync(REC_DIR).filter(f => f.endsWith('.json'));
    const total = files.length;
    let processed = 0;
    let batchSize = 50;

    for (let i = 0; i < total; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      for (const f of batch) {
        const filePath = path.join(REC_DIR, f);
        try {
          const fd = fs.openSync(filePath, 'r');
          const headerBuf = Buffer.alloc(CHUNK_SIZE);
          const bytesRead = fs.readSync(fd, headerBuf, 0, CHUNK_SIZE, 0);
          const header = headerBuf.slice(0, bytesRead);
          const fields = extractFields(header);
          if (!fields.gameId || !fields.playerName) {
            fs.closeSync(fd);
            continue;
          }

          let winner = null;
          // Check if winner is "[Circular]" in the header (unlikely but possible for tiny recordings)
          const winnerInHeader = extractWinner(header);
          if (winnerInHeader) {
            winner = winnerInHeader;
          } else {
            // Read tail to find winner
            const stat = fs.fstatSync(fd);
            const tailSize = Math.min(CHUNK_SIZE, stat.size);
            const tailBuf = Buffer.alloc(tailSize);
            fs.readSync(fd, tailBuf, 0, tailSize, stat.size - tailSize);
            const tailWinner = extractWinner(tailBuf);
            if (tailWinner) winner = tailWinner;
          }
          fs.closeSync(fd);

          const key = fields.gameId + '||' + fields.playerName;
          if (!index.has(key)) {
            index.set(key, {
              gameId: fields.gameId,
              playerName: fields.playerName,
              deckName: fields.deckName || fields.playerName,
              winner
            });
          }
        } catch (e) {
          // skip unreadable files
        }
        processed++;
      }

      if (i + batchSize < total) {
        await new Promise(r => setImmediate(r));
      }
    }
  }

  const result = Array.from(index.values());
  const tmp = REC_INDEX_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(result), 'utf8');
  fs.renameSync(tmp, REC_INDEX_PATH);
  console.log(`Index built: ${result.length} entries`);
}

build().catch(e => console.error('Build failed:', e.message));
