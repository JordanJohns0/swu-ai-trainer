const io = require('socket.io-client');
const { loadModel, saveModelToFile, saveGameRecording, loadGameRecordings, loadTrainingStats, saveTrainingStats } = require('./storage');
const { selectAiAction, getActionKey } = require('./util');
const { trainModelRanking } = require('./training');
const { getDeck } = require('./decks');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const BOT_NAME = process.env.BOT_NAME || 'Bot';
const DECK_NAME = process.env.DECK_NAME || 'cad-bane';
const SELF_PLAY_MODE = process.env.SELF_PLAY === 'true' || process.env.SELF_PLAY === '1';
const TRAIN_EVERY_N = parseInt(process.env.TRAIN_EVERY_N || '5', 10);

let gamesPlayed = 0;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createSocket(id, name) {
  return new Promise((resolve, reject) => {
    const userData = { id, username: name };
    const sock = io(SERVER_URL, {
      path: '/ws',
      query: {
        user: JSON.stringify(userData),
        lobby: JSON.stringify({ id: '', username: '' }),
        spectator: 'false'
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity
    });

    sock.on('connect', () => {
      console.log(`${name} connected: ${sock.id}`);
    });

    sock.on('connect_error', (err) => {
      console.error(`${name} connection error:`, err.message);
    });

    sock.on('disconnect', (reason) => {
      console.log(`${name} disconnected:`, reason);
    });

    sock.on('error', (err) => {
      console.error(`${name} socket error:`, err.message);
    });

    // Give time to connect
    let settled = false;
    sock.on('connect', () => {
      if (!settled) { settled = true; resolve(sock); }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        if (sock.connected) resolve(sock);
        else reject(new Error(`${name} connection timeout`));
      }
    }, 5000);
  });
}

async function enterQueue(id, name, deck) {
  const body = {
    user: { id, username: name },
    format: 'premier',
    cardPool: 'current',
    gamesToWinMode: 'bestOfOne',
    deck: {
      metadata: { name: DECK_NAME, author: name },
      leader: deck.leader,
      base: deck.base,
      deck: deck.cards
    }
  };

  return new Promise((resolve, reject) => {
    const http = require('http');
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/enter-queue',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(body))
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const status = res.statusCode;
        const success = status >= 200 && status < 300;
        if (success) {
          console.log(`${name} entered queue, status=${status}`);
          resolve(true);
        } else {
          console.error(`${name} queue failed status=${status}:`, data);
          reject(new Error(`Queue status ${status}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function runBot(id, name) {
  const deck = getDeck(DECK_NAME);
  let socket = null;
  let gameId = null;
  let recording = null;

  async function handleGameState(data) {
    if (!data || !data.players) return;

    const sid = data.id;
    if (sid && sid !== gameId) {
      gameId = sid;
      recording = { gameId: sid, playerId: id, states: [], actions: [], timestamp: Date.now() };
      console.log(`${name} game started: ${sid}`);
    }
    if (!recording) return;

    recording.states.push({ state: data, timestamp: Date.now() });

    if (data.winners && data.winners.length > 0) {
      recording.winner = data.winners;
      recording.completedAt = Date.now();
      console.log(`${name} game ended. Winner:`, data.winners);
      await saveGameRecording(recording).catch(() => {});
      gamesPlayed++;
      recording = null;
      gameId = null;

      if (gamesPlayed % TRAIN_EVERY_N === 0) {
        runTraining().catch(e => console.error('Training failed:', e));
      }

      setTimeout(() => {
        startBot(id, name).catch(e => console.error(`${name} restart failed:`, e));
      }, 3000);
      return;
    }

    await delay(500 + Math.random() * 1000);

    const action = await selectAiAction(data, SELF_PLAY_MODE);
    if (!action) { console.log(`${name} no action`); return; }

    console.log(`${name} action:`, getActionKey(action));

    if (recording) {
      const args = action.type === 'statefulPromptResults'
        ? [action.distribution, action.uuid]
        : action.type === 'menuButton'
          ? [action.arg, action.uuid || '']
          : [action.cardId];
      recording.actions.push({
        event: action.type === 'statefulPromptResults' ? 'statefulPromptResults' : action.type,
        args,
        stateIndex: recording.states.length - 1,
        timestamp: Date.now()
      });
    }

    switch (action.type) {
      case 'menuButton':
        socket.emit('menuButton', action.arg, action.uuid || '');
        break;
      case 'cardClicked':
        socket.emit('cardClicked', action.cardId);
        break;
      case 'statefulPromptResults':
        socket.emit('statefulPromptResults', action.distribution, action.uuid);
        break;
      case 'pass':
        socket.emit('menuButton', 'pass', '');
        break;
    }

    await delay(200);
  }

  socket = await createSocket(id, name);

  socket.on('gamestate', handleGameState);

  socket.on('game', (data) => {
    // Lobby/queue events, non-gamestate
    if (data && data.players) handleGameState(data);
  });

  await delay(1000);
  await enterQueue(id, name, deck);
}

async function runTraining() {
  console.log('Batch training...');
  const recordings = await loadGameRecordings();
  if (recordings.length === 0) return;

  const model = await loadModel();
  if (!model) return;

  console.log(`Training on ${recordings.length} games...`);
  const history = await trainModelRanking(model, recordings);
  await saveModelToFile(model);

  const acc = history.history.pref_acc[history.history.pref_acc.length - 1];
  const stats = await loadTrainingStats();
  stats.gamesTrained = (stats.gamesTrained || 0) + recordings.length;
  stats.lastTrainedAt = Date.now();
  stats.accuracy = acc;
  await saveTrainingStats(stats);
  console.log(`Training done: pref_acc=${(acc * 100).toFixed(2)}%`);
}

async function startBot(id, name) {
  try {
    await runBot(id, name);
  } catch (e) {
    console.error(`${name} error:`, e.message);
    await delay(10000);
    startBot(id, name).catch(console.error);
  }
}

async function main() {
  console.log('=== SWU AI Self-Play Bot ===');
  console.log('Server:', SERVER_URL);
  console.log('Mode:', SELF_PLAY_MODE ? 'Self-play' : 'Single');

  if (SELF_PLAY_MODE) {
    await Promise.all([startBot('bot1', 'Bot-1'), startBot('bot2', 'Bot-2')]);
  } else {
    await startBot('bot1', BOT_NAME);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
