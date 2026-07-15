const storage = require('./storage');
const bot = require('./bot');

console.log(`[WORKER] process.send=${typeof process.send}, pid=${process.pid}`);

const origSaveBotStatus = storage.saveBotStatus.bind(storage);
storage.saveBotStatus = async function (id, name, status) {
  if (typeof process.send === 'function') {
    const msg = { type: 'status', id, name, ...status };
    const sent = process.send(msg);
    console.log(`[WORKER] IPC sent for ${name}: ${status.state} (queued=${sent})`);
  } else {
    console.log(`[WORKER] process.send not available for ${name}`);
  }
  return origSaveBotStatus(id, name, status);
};

const id = process.env.BOT_ID || 'bot1';
const name = process.env.BOT_NAME || 'Bot';

console.log(`[WORKER] starting ${id} / ${name}...`);

bot.startBot(id, name).catch((e) => {
  console.error(`${name} fatal:`, e.message);
  process.exit(1);
});
