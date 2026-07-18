const storage = require('./storage');

// Patch BEFORE bot.js loads — monkey-patch must be in place before
// bot.js does const { saveBotStatus } = require('./storage')
const origSaveBotStatus = storage.saveBotStatus.bind(storage);
storage.saveBotStatus = async function (id, name, status) {
  if (typeof process.send === 'function') {
    try {
      process.send({ type: 'status', id, name, ...status });
    } catch (e) {
      console.error(`[WORKER] IPC send failed: ${e.message}`);
    }
  }
  return origSaveBotStatus(id, name, status);
};

const origSaveGameRecording = storage.saveGameRecording.bind(storage);
storage.saveGameRecording = async function (recording) {
  if (typeof process.send === 'function' && recording && recording.gameId) {
    try {
      const winnerArray = recording.winner;
      const winnerName = Array.isArray(winnerArray) ? winnerArray[0] : (typeof winnerArray === 'string' ? winnerArray : null);
      process.send({
        type: 'recording_metadata',
        gameId: recording.gameId,
        playerName: recording.playerName,
        deckName: recording.deckName,
        winner: winnerName,
        recordedAt: recording.completedAt || recording.timestamp || Date.now()
      });
    } catch (e) {
      console.error(`[WORKER] IPC recording_metadata send failed: ${e.message}`);
    }
  }
  return origSaveGameRecording(recording);
};

// Patch training progress — intercept saveTrainingProgress
const origSaveTrainingProgress = storage.saveTrainingProgress ? storage.saveTrainingProgress.bind(storage) : async () => {};
if (storage.saveTrainingProgress) {
  storage.saveTrainingProgress = async function (progress) {
    if (typeof process.send === 'function' && progress) {
      try { process.send({ type: 'training_progress', ...progress }); } catch {}
    }
    return origSaveTrainingProgress(progress);
  };
}

const bot = require('./bot');

const id = process.env.BOT_ID || 'bot1';
const name = process.env.BOT_NAME || 'Bot';

console.log(`[WORKER] starting ${id} / ${name}...`);

bot.startBot(id, name).catch((e) => {
  console.error(`${name} fatal:`, e.message);
  process.exit(1);
});
