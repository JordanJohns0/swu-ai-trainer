const http = require('http');
const io = require('socket.io-client');
const { loadModel, saveModelToFile, saveGameRecording, loadGameRecordings, loadTrainingStats, saveTrainingStats } = require('./storage');
const { selectAiAction, getActionKey, getActionSetHash, getSelectableCardIds, getAvailableActions, getMyPlayerState } = require('./util');
const { trainModelRanking } = require('./training');
const { getDeck } = require('./decks');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const BOT_NAME = process.env.BOT_NAME || 'Bot';
const DECK_NAME = process.env.DECK_NAME || 'cad-bane';
const SELF_PLAY_MODE = process.env.SELF_PLAY === 'true' || process.env.SELF_PLAY === '1';
const TRAIN_EVERY_N = parseInt(process.env.TRAIN_EVERY_N || '5', 10);

const serverUrl = new URL(SERVER_URL);
const SERVER_HOST = serverUrl.hostname;
const SERVER_PORT = parseInt(serverUrl.port, 10) || 3000;

let gamesPlayed = 0;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: SERVER_HOST,
      port: SERVER_PORT,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = http.request(options, (res) => {
      let resp = '';
      res.on('data', chunk => resp += chunk);
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ ok, status: res.statusCode, body: resp });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function enterQueue(id, name, deck) {
  const body = {
    user: { id, username: name },
    format: 'premier',
    cardPool: 'nextSet',
    gamesToWinMode: 'bestOfOne',
    deck: {
      metadata: deck.metadata || { name: DECK_NAME, author: name },
      leader: deck.leader,
      base: deck.base,
      deck: deck.cards,
      sideboard: deck.sideboard || []
    }
  };
  const result = await httpPost('/api/enter-queue', body);
  if (result.ok) {
    console.log(`${name} entered queue`);
  } else {
    console.error(`${name} queue failed:`, result.status, result.body);
    throw new Error(`Queue status ${result.status}`);
  }
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

    sock.on('connect_error', (err) => console.error(`${name} connection error:`, err.message));
    sock.on('disconnect', (reason) => {
      if (reason !== 'io server disconnect') console.log(`${name} disconnected:`, reason);
      if (reason === 'io server disconnect' && !gameId) {
        console.log(`${name} server disconnected us, restarting...`);
        setTimeout(() => startBot(id, name).catch(console.error), 5000);
      }
    });

    let settled = false;
    sock.on('connect', () => { if (!settled) { settled = true; resolve(sock); } });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        if (sock.connected) resolve(sock);
        else { sock.close(); reject(new Error(`${name} connection timeout`)); }
      }
    }, 10000);
  });
}

async function runBot(id, name) {
  const deck = getDeck(DECK_NAME);

  await enterQueue(id, name, deck);

  const socket = await createSocket(id, name);
  let gameId = null;
  let recording = null;
  let pendingRequeue = false;
  let firstConnect = true;
  let lastStateHash = null;
  let lastActionSentTime = Date.now();
  let triedActionsMap = new Map();
  let lastActionKeySent = null;
  const STUCK_TIMEOUT = 60000;
  socket.on('connect', () => {
    console.log(`${name} connected: ${socket.id}`);
    if (!firstConnect && !gameId) {
      console.log(`${name} reconnected, requeuing`);
      socket.emit('requeue');
    }
    firstConnect = false;
  });

  function computeRichHash(data) {
    const phase = data.phase || '';
    const promptUuids = Object.values(data.players || {})
      .map(p => p?.promptState?.promptUuid || '')
      .filter(Boolean)
      .sort()
      .join('|');
    return `${phase}|${promptUuids}|${getActionSetHash(data)}`;
  }

  function getPlayerStateSummary(data) {
    if (!data || !data.players) return [];
    return Object.entries(data.players).map(([pid, p]) => ({
      id: pid,
      phase: data.phase,
      promptType: p?.promptState?.promptType,
      selectCardMode: p?.promptState?.selectCardMode,
      menuTitle: p?.promptState?.menuTitle?.slice(0, 60),
      buttons: p?.promptState?.buttons?.length || 0,
      buttonArgs: (p?.promptState?.buttons || []).map(b => b.arg).filter(Boolean),
      selectableCards: getSelectableCardIds(data).length,
      hand: p?.cardPiles?.hand?.length || 0,
      resources: p?.cardPiles?.resources?.length || 0,
      groundArena: p?.cardPiles?.groundArena?.length || 0,
      spaceArena: p?.cardPiles?.spaceArena?.length || 0
    }));
  }

  async function handleGameState(data) {
    if (!data || !data.players) return;

    const now = Date.now();
    const sid = data.id;
    if (sid && sid !== gameId && !pendingRequeue) {
      gameId = sid;
      pendingRequeue = false;
      lastStateHash = null;
      lastActionSentTime = now;
      triedActionsMap.clear();
      recording = { gameId: sid, playerId: id, states: [], actions: [], timestamp: Date.now() };
      console.log(`${name} game started: ${sid}`);
    }
    if (!recording) return;

    recording.states.push({ state: data, timestamp: Date.now() });

    if (data.winners && data.winners.length > 0 && !pendingRequeue) {
      pendingRequeue = true;
      gameId = null;
      recording.winner = data.winners;
      recording.completedAt = Date.now();
      console.log(`${name} game ended. Winner:`, data.winners);
      await saveGameRecording(recording).catch(() => {});
      gamesPlayed++;
      recording = null;

      if (gamesPlayed % TRAIN_EVERY_N === 0) {
        runTraining().catch(e => console.error('Training failed:', e));
      }

      setTimeout(() => {
        socket.emit('requeue');
        console.log(`${name} requeued`);
        pendingRequeue = false;
      }, 3000);
      return;
    }

    // Stuck detection: if no action sent for STUCK_TIMEOUT ms during active game, force requeue
    if (now - lastActionSentTime > STUCK_TIMEOUT && !pendingRequeue) {
      console.log(`${name} *** STUCK *** no progress for ${STUCK_TIMEOUT / 1000}s, force re-queuing`);
      console.log(`${name} last state:`, JSON.stringify(getPlayerStateSummary(data)));
      pendingRequeue = true;
      socket.emit('requeue');
      setTimeout(() => {
        pendingRequeue = false;
        lastActionSentTime = Date.now();
      }, 3000);
      return;
    }

    // Smart hash dedup: if state unchanged, try different action
    const currentHash = computeRichHash(data);
    const tried = triedActionsMap.get(currentHash);
    if (currentHash === lastStateHash && tried) {
      const player = getMyPlayerState(data, id);
      const isDistributePrompt = player?.promptState?.promptType === 'distributeAmongTargets';

      if (isDistributePrompt) {
        // For distribute prompts, use selectAiAction which varies distribution strategies
        const action = await selectAiAction(data, SELF_PLAY_MODE, id);
        if (action) {
          const key = getActionKey(action);
          // Track under a variant key so different distributions count as different tries
          const retryKey = key + ':retry' + (tried.size);
          if (!tried.has(retryKey)) {
            tried.add(retryKey);
            console.log(`${name} retry distribute (${tried.size}): ${key}`);
            await sendAction(action);
            return;
          }
        }
        console.log(`${name} distribute strategies exhausted, waiting for timeout`);
        return;
      }

      // For other prompts, try an untried raw action from the remaining set
      const allActions = getAvailableActions(data);
      const untried = allActions.filter(a => !tried.has(getActionKey(a)));
      if (untried.length === 0) {
        console.log(`${name} hash exhausted (all ${tried.size} actions tried): ${currentHash}`);
        return;
      }
      const fallback = untried[Math.floor(Math.random() * untried.length)];
      tried.add(getActionKey(fallback));
      console.log(`${name} retry (${tried.size}/${allActions.length}): ${getActionKey(fallback)}`);
      await sendAction(fallback);
      return;
    }
    if (currentHash !== lastStateHash) {
      lastStateHash = currentHash;
      triedActionsMap.delete(currentHash);
    }
    console.log(`${name} hash new: ${currentHash}`);

    const action = await selectAiAction(data, SELF_PLAY_MODE, id);
    if (!action) {
      console.log(`${name} no action [${JSON.stringify(getPlayerStateSummary(data))}]`);
      return;
    }

    lastActionKeySent = getActionKey(action);
    // Initialize tried set with this action for repeat detection
    if (!triedActionsMap.has(currentHash)) {
      triedActionsMap.set(currentHash, new Set([lastActionKeySent]));
    }
    console.log(`${name} action: ${lastActionKeySent}`);
    await sendAction(action);
  }

  async function sendAction(action) {
    if (!action) return;
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
        socket.emit('game', 'menuButton', action.arg, action.uuid || '');
        break;
      case 'cardClicked':
        socket.emit('game', 'cardClicked', action.cardId);
        break;
      case 'statefulPromptResults':
        socket.emit('game', 'statefulPromptResults', action.distribution, action.uuid);
        break;
      case 'pass':
        socket.emit('game', 'menuButton', 'pass', '');
        break;
    }

    lastActionSentTime = Date.now();
    await delay(200);
  }

  socket.on('connection_error', (msg) => {
    console.error(`${name} connection error from server:`, msg);
    // Server will disconnect us; let the disconnect handler restart
  });

  socket.on('gamestate', handleGameState);
  socket.on('game', (data) => {
    if (data && data.players) handleGameState(data);
  });
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

  if (SELF_PLAY_MODE) {
    await Promise.all([startBot('bot1', 'Bot-1'), startBot('bot2', 'Bot-2')]);
  } else {
    await startBot('bot1', BOT_NAME);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
