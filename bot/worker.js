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

const bot = require('./bot');

const id = process.env.BOT_ID || 'bot1';
const name = process.env.BOT_NAME || 'Bot';

console.log(`[WORKER] starting ${id} / ${name}...`);

bot.startBot(id, name).catch((e) => {
  console.error(`${name} fatal:`, e.message);
  process.exit(1);
});
