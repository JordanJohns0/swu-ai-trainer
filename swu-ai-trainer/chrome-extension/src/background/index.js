console.log('SWU AI BG VERSION 4');
importScripts('storage.js');
importScripts('model.js');

let gameSessions = new Map(); // serverGameId → session
let gameCount = 0;
let isAiPlaying = false;
let aiPauseRequested = false;
let autoRequeue = false;
let autoTrain = false;
let autoPlay = false;
let pendingAutoPlay = false;
let pendingAutoPlayPlayers = new Set();
let minWait = 1000;
let maxWait = 3000;
let pendingRecommendations = null;
let lastUnknownEvent = null;
let lastTabId = null;
let playerTabMap = {};
let lastSentActionKey = {};
let lastSentStateHash = {};

// Active session globals (set before each message handler run)
let currentGameRecording = null;
let botPlayerId = null;
let currentPlayerId = null;
let failedActionKeys = new Set();
let currentTurnPlan = null;

function createGameSession(serverGameId, initialData) {
  const recording = {
    gameId: `game_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    gameNumber: ++gameCount,
    playerId: null,
    states: [],
    actions: [],
    winner: null,
    trained: false,
    initialState: initialData || null
  };
  const session = {
    serverGameId,
    recording,
    failedActionKeys: new Set(),
    currentTurnPlan: null,
    currentPlayerId: null,
    tabIds: new Set()
  };
  gameSessions.set(serverGameId, session);
  return session;
}

function activateSession(session) {
  if (session) {
    currentGameRecording = session.recording;
    botPlayerId = session.recording.playerId;
    currentPlayerId = session.currentPlayerId;
    failedActionKeys = session.failedActionKeys;
    currentTurnPlan = session.currentTurnPlan;
  } else {
    currentGameRecording = null;
    botPlayerId = null;
    currentPlayerId = null;
    failedActionKeys = new Set();
    currentTurnPlan = null;
  }
}

function getSessionForState(gameState) {
  const gameId = gameState?.id;
  return gameId ? (gameSessions.get(gameId) || null) : null;
}

function cleanupSession(serverGameId) {
  const session = gameSessions.get(serverGameId);
  if (!session) return;
  if (session.recording === currentGameRecording) {
    activateSession(null);
  }
  gameSessions.delete(serverGameId);
}

function syncSessionGlobals() {
  for (const [, s] of gameSessions) {
    if (s.recording === currentGameRecording) {
      s.currentTurnPlan = currentTurnPlan;
      s.currentPlayerId = currentPlayerId;
      return;
    }
  }
}

function getActionKey(action) {
  if (action.type === 'statefulPromptResults') {
    return action.type + ':' + (action.distribution?.type || 'unknown');
  }
  return action.type + ':' + (action.arg ?? action.cardId ?? '');
}

function hashActionKey(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) { hash = ((hash << 5) - hash) + key.charCodeAt(i); hash |= 0; }
  return ((hash % 10000) + 10000) % 10000 / 10000;
}

function getActionSetHash(gameState) {
  const actions = getAvailableActions(gameState);
  return actions.map(a => getActionKey(a)).sort().join('|');
}

function getBotActionsHash(state) {
  const botId = currentGameRecording?.playerId;
  if (!botId || !state?.players) return '';
  const actions = getActionsForPlayer(state, botId);
  return actions.map(a => getActionKey(a)).sort().join('|');
}

let settingsLoaded = false;
async function loadAllSettings() {
  if (settingsLoaded) return;
  settingsLoaded = true;
  try {
    const [aiPlaying, req, play, train, min, max] = await Promise.all([
      getSetting('isAiPlaying', false),
      getSetting('autoRequeue', false),
      getSetting('autoPlay', false),
      getSetting('autoTrain', false),
      getSetting('minWait', 1000),
      getSetting('maxWait', 3000),
    ]);
    isAiPlaying = aiPlaying;
    autoRequeue = req;
    autoPlay = play;
    autoTrain = train;
    minWait = min;
    maxWait = max;
    console.log('Loaded settings:', { isAiPlaying, autoRequeue, autoPlay, autoTrain, minWait, maxWait });
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab?.id) lastTabId = sender.tab.id;
  // Map sender tab to player ID (sent from content script)
  if (sender.tab?.id && msg.tabPlayerId) {
    playerTabMap[msg.tabPlayerId] = sender.tab.id;
    console.log('playerTabMap:', msg.tabPlayerId, '→ tab', sender.tab.id);
  }
  (async () => {
    await loadAllSettings();
    try {
      if (msg.type === 'FROM_PAGE') {
        await handlePageMessage(msg.payload, sender.tab?.id);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'GET_STATUS') {
        const recordings = await getGameRecordingCount();
        const stats = await getTrainingStats();
        const enabled = await getSetting('recordingEnabled', true);
        const planJson = currentTurnPlan ? JSON.parse(JSON.stringify(currentTurnPlan)) : null;
        const syncUrl = await getSyncServerUrl();
        sendResponse({ recordings, stats, enabled, isAiPlaying, autoPlay, autoRequeue, autoTrain, gameCount, activeGame: !!currentGameRecording, minWait, maxWait, plan: planJson, syncServerUrl: syncUrl });
        return;
      }
      if (msg.type === 'TOGGLE_RECORDING') {
        await saveSetting('recordingEnabled', msg.enabled);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'TOGGLE_AI_PLAY') {
        isAiPlaying = msg.enabled;
        aiPauseRequested = !msg.enabled;
        if (!isAiPlaying) aiPauseRequested = true;
        await saveSetting('isAiPlaying', isAiPlaying);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'TOGGLE_AUTO_REQUEUE') {
        autoRequeue = msg.enabled;
        await saveSetting('autoRequeue', autoRequeue);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'TOGGLE_AUTO_TRAIN') {
        autoTrain = msg.enabled;
        await saveSetting('autoTrain', autoTrain);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'TOGGLE_AUTO_PLAY') {
        autoPlay = msg.enabled;
        await saveSetting('autoPlay', autoPlay);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'SET_WAIT_TIME') {
        minWait = Math.max(100, msg.min ?? 1000);
        maxWait = Math.max(minWait, Math.min(30000, msg.max ?? 3000));
        await saveSetting('minWait', minWait);
        await saveSetting('maxWait', maxWait);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'REQUEST_AI_PLAY') {
        if (!currentGameRecording) { sendResponse({ ok: false, error: 'No active game' }); return; }
        await sendRecommendations(currentGameRecording);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'ACTION_CHOSEN') {
        const action = msg.action;
        if (action) {
          await sendActionToTab(action);
        } else {
          console.warn('ACTION_CHOSEN received without action object');
        }
        pendingRecommendations = null;
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'TRAIN_NOW') {
        await startTraining();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'CLEAR_DATA') {
        await deleteAllGameRecordings();
        await clearTrainingStats();
        await saveModelWeights(null);
        clearCachedModel();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'EXPORT_DATA') {
        const games = await getGameRecordings();
        sendResponse({ ok: true, games });
        return;
      }
      if (msg.type === 'SET_SYNC_SERVER') {
        await setSyncServerUrl(msg.url || '');
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'SYNC_NOW') {
        await syncAllToServer();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'PING') {
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'DIAG_RESULT') {
        globalThis.__swuAiDiag = msg.data;
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'GET_DIAG') {
        const result = globalThis.__swuAiDiag || {};
        if (currentGameRecording) {
          const last = currentGameRecording.states[currentGameRecording.states.length - 1]?.state;
          if (last) result.buttons = getAvailableActions(last).map(a => ({ type: a.type, arg: a.arg, command: a.command, cardId: a.cardId, text: a.text, uuid: a.uuid }));
          // Also include raw promptState for diagnosis
          for (const pid of Object.keys(last.players || {})) {
            const ps = last.players[pid]?.promptState;
            if (ps?.buttons?.length > 0) {
              result.promptUuid = ps.promptUuid;
              result.rawButtons = ps.buttons.map((b, bi) => ({ index: bi, ...Object.fromEntries(Object.entries(b).filter(([_, v]) => v != null)) }));
              break;
            }
          }
        }
        result.lastUnknownEvent = lastUnknownEvent;
        sendResponse({ ok: true, data: result });
        return;
      }
      if (msg.type === 'CHECK_CONNECTION') {
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          let pageOk = false;
          if (tabs[0]) {
            const pong = await chrome.tabs.sendMessage(tabs[0].id, { type: 'PING' });
            pageOk = pong?.ok === true;
          }
          const games = await getGameRecordingCount();
          sendResponse({ ok: true, pageOk, games, activeGame: !!currentGameRecording });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return;
      }
    } catch (e) {
      console.error('Message handler error:', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

async function handlePageMessage(payload, senderTabId) {
  const { type, data, event, args } = payload;

  // Route to correct game session by server game ID
  const serverGameId = data?.id || payload.data?.id || null;
  let session = null;

  if (type === 'GAMESTATE' && data) {
    if (serverGameId && gameSessions.has(serverGameId)) {
      session = gameSessions.get(serverGameId);
    } else if (serverGameId) {
      // Check if this tab had a lobby session; if so, adopt its recording
      const lobbyKey = `lobby_${senderTabId}`;
      const lobbySession = gameSessions.get(lobbyKey);
      if (lobbySession) {
        // Transfer recording from lobby session to game ID
        lobbySession.serverGameId = serverGameId;
        gameSessions.set(serverGameId, lobbySession);
        gameSessions.delete(lobbyKey);
        session = lobbySession;
        // Update initial state if we didn't have one
        if (!session.recording.initialState) session.recording.initialState = data;
      } else {
        session = createGameSession(serverGameId, data);
      }
    }
    if (session) session.tabIds.add(senderTabId);
    activateSession(session);
  } else if (type === 'GAME_EVENT') {
    const { data: eventData } = payload;
    if (eventData?.id && serverGameId && gameSessions.has(serverGameId)) {
      session = gameSessions.get(serverGameId);
    } else if (eventData?.players && eventData?.id && serverGameId) {
      // GAME_EVENT with full game state - could be a new game
      if (gameSessions.has(serverGameId)) {
        session = gameSessions.get(serverGameId);
      } else {
        session = createGameSession(serverGameId, eventData);
      }
      if (session) session.tabIds.add(senderTabId);
    }
    activateSession(session);
  } else if (type === 'LOBBYSTATE' && data) {
    const lobbyKey = serverGameId || `lobby_${senderTabId}`;
    if (data.gameOngoing) {
      if (gameSessions.has(lobbyKey)) {
        session = gameSessions.get(lobbyKey);
      } else {
        session = createGameSession(lobbyKey, data);
        session.tabIds.add(senderTabId);
      }
      activateSession(session);
    }
  } else {
    // OUTGOING etc. - activate session if we can find one
    if (serverGameId && gameSessions.has(serverGameId)) {
      session = gameSessions.get(serverGameId);
    }
    activateSession(session);
  }

  const shouldAct = (isAiPlaying || autoPlay) && currentGameRecording;

  if (type === 'LOBBYSTATE' && data) {
    if (shouldAct) {
      await sendRecommendations(currentGameRecording);
    }
  }

  if (type === 'GAMESTATE' && data) {
    lastUnknownEvent = null;
    if (!currentGameRecording) {
      // No session was found/created - create one now
      if (serverGameId) {
        session = createGameSession(serverGameId, data);
        session.tabIds.add(senderTabId);
        activateSession(session);
      }
    }
    if (currentGameRecording) {
      if (!currentGameRecording.playerId && data?.players) {
        for (const [id, p] of Object.entries(data.players)) {
          const ps = p.promptState;
          if (ps && ps.promptType != null && ps.promptType !== '') {
            currentGameRecording.playerId = id;
            break;
          }
        }
      }
      if (currentGameRecording.playerId) {
        botPlayerId = currentGameRecording.playerId;
        if (session) session.recording.playerId = currentGameRecording.playerId;
      }
      currentGameRecording.states.push({ state: data, timestamp: Date.now() });
      if (data.winners && data.winners.length > 0) await finalizeRecording(data.winners, data);
    }
    if (shouldAct) {
      const activeId = getActivePlayerId(data) || currentGameRecording?.playerId;
      if (autoPlay && senderTabId && activeId && playerTabMap[activeId] && playerTabMap[activeId] !== senderTabId) {
        console.log('handlePageMessage: skipping GAMESTATE from wrong perspective tab', { senderTabId, activeId });
      } else {
        await sendRecommendations(currentGameRecording);
      }
    }
  }

  if (type === 'OUTGOING' && currentGameRecording) {
    currentGameRecording.actions.push({
      event, args,
      stateIndex: currentGameRecording.states.length - 1,
      timestamp: Date.now()
    });
  }

  if (type === 'GAME_EVENT') {
    const { name: eventName, data: eventData } = payload;
    if (!eventData) return;
    // If it has players, treat as direct gamestate update
    if (eventData.players) {
      if (!currentGameRecording) {
        if (eventData?.id) {
          session = createGameSession(eventData.id, eventData);
          session.tabIds.add(senderTabId);
          activateSession(session);
        }
      }
      if (currentGameRecording) {
        if (!currentGameRecording.playerId && eventData?.players) {
          for (const [id, p] of Object.entries(eventData.players)) {
            const ps = p.promptState;
            if (ps && ps.promptType != null && ps.promptType !== '') {
              currentGameRecording.playerId = id;
              break;
            }
          }
        }
        if (currentGameRecording.playerId) {
          botPlayerId = currentGameRecording.playerId;
          if (session) session.recording.playerId = currentGameRecording.playerId;
        }
        currentGameRecording.states.push({ state: eventData, timestamp: Date.now() });
        if (eventData.winners && eventData.winners.length > 0) await finalizeRecording(eventData.winners, eventData);
      }
      if (shouldAct) {
        const activeId = getActivePlayerId(eventData) || currentGameRecording?.playerId;
        if (autoPlay && senderTabId && activeId && playerTabMap[activeId] && playerTabMap[activeId] !== senderTabId) {
          console.log('handlePageMessage: skipping GAME_EVENT(players) from wrong perspective tab');
        } else {
          await sendRecommendations(currentGameRecording);
        }
      }
      return;
    }
    // Handle pre-game match acceptance / popup events
    const actionableButtons = Array.isArray(eventData.buttons) ? eventData.buttons :
                               Array.isArray(eventData.options) ? eventData.options :
                               Array.isArray(eventData.choices) ? eventData.choices :
                               Array.isArray(eventData.actions) ? eventData.actions : null;
    const hasActionableData = eventData.promptType !== undefined || (actionableButtons && actionableButtons.length > 0);
    const objectOptions = !actionableButtons && typeof eventData.options === 'object' && eventData.options !== null;
    const objectChoices = !actionableButtons && typeof eventData.choices === 'object' && eventData.choices !== null;
    if ((hasActionableData || objectOptions || objectChoices) && currentGameRecording) {
      const lastState = currentGameRecording.states[currentGameRecording.states.length - 1]?.state;
      if (lastState && lastState.players) {
        const activeId = Object.keys(lastState.players).find(id => lastState.players[id]?.promptState?.promptType != null)
                       || Object.keys(lastState.players)[0];
        if (activeId) {
          let buttons = actionableButtons || [];
          if (buttons.length === 0 && objectOptions) {
            for (const [k, v] of Object.entries(eventData.options)) {
              const label = typeof v === 'string' ? v : (v?.text || v?.label || v?.name || k);
              buttons.push({ text: label, arg: String(v?.arg ?? v?.action ?? v?.value ?? k), uuid: String(v?.uuid ?? '') });
            }
          } else if (buttons.length === 0 && objectChoices) {
            for (const [k, v] of Object.entries(eventData.choices)) {
              const label = typeof v === 'string' ? v : (v?.text || v?.label || v?.name || k);
              buttons.push({ text: label, arg: String(v?.arg ?? v?.action ?? v?.value ?? k), uuid: String(v?.uuid ?? '') });
            }
          }
          const wrapped = JSON.parse(JSON.stringify(lastState));
          wrapped.players[activeId] = wrapped.players[activeId] || {};
          const origPrompt = wrapped.players[activeId]?.promptState ?? {};
          wrapped.players[activeId].promptState = {
            promptType: eventData.promptType ?? 1,
            promptUuid: eventData.promptUuid || origPrompt.promptUuid || '',
            buttons: buttons,
            selectCardMode: eventData.selectCardMode || ''
          };
          lastUnknownEvent = null;
          currentGameRecording.states.push({ state: wrapped, timestamp: Date.now() });
          if (isAiPlaying || autoPlay) {
            await sendRecommendations(currentGameRecording);
          }
          return;
        }
      }
    }
    lastUnknownEvent = { name: eventName, data: eventData };
    console.log('Unknown game event stored:', eventName, Object.keys(eventData), 'promptType:', eventData?.promptType, 'buttons:', Array.isArray(eventData?.buttons) ? eventData.buttons.length : typeof eventData?.buttons, 'options:', Array.isArray(eventData?.options) ? eventData.options.length : typeof eventData?.options, 'choices:', Array.isArray(eventData?.choices) ? eventData.choices.length : typeof eventData?.choices);
  }
}

// startNewRecording replaced by createGameSession + gameSessions map.

async function finalizeRecording(winners, data) {
  if (!currentGameRecording) return;

  // Find the session for this recording
  const serverGameId = data?.id;
  let session = serverGameId ? (gameSessions.get(serverGameId) || null) : null;
  // Fall back to searching sessions by recording reference
  if (!session) {
    for (const [gid, s] of gameSessions) {
      if (s.recording === currentGameRecording) {
        session = s;
        break;
      }
    }
  }

  currentGameRecording.winner = winners;
  currentGameRecording.completedAt = Date.now();
  const recording = currentGameRecording;
  await saveGameRecording(recording);
  syncToServer('api/games', recording).catch(() => {});

  // Clean up session state for this specific game only
  const requeueTabIds = session ? [...session.tabIds] : [];
  if (serverGameId) {
    cleanupSession(serverGameId);
  }

  // Auto-train before requeue
  if (autoTrain) {
    console.log('finalizeRecording: auto-training on game');
    await trainOnGame(recording);
  }

  // Auto-requeue: send to all tabs in this game, not lastTabId
  if (autoRequeue) {
    for (const tabId of requeueTabIds) {
      setTimeout(async () => {
        try {
          if (tabId) await chrome.tabs.sendMessage(tabId, { type: 'CLICK_REQUEUE' });
        } catch (e) {
          console.warn('Auto-requeue send failed for tab', tabId, e);
        }
      }, 2000);
    }
  }
}

function getBotTabId(overridePlayerId) {
  const pid = overridePlayerId || currentPlayerId || botPlayerId;
  const mapped = (pid && playerTabMap[pid]) ? playerTabMap[pid] : null;
  const result = mapped || lastTabId;
  if (mapped) console.log('getBotTabId: mapped', pid, '→ tab', mapped);
  return result;
}

async function sendActionToTab(action, overridePlayerId) {
  const targetId = overridePlayerId ? getBotTabId(overridePlayerId) : getBotTabId();
  if (!targetId) { console.warn('sendActionToTab: no tab ID available'); return; }
  try {
    await chrome.tabs.sendMessage(targetId, { type: 'INJECT_AND_EXECUTE', action });
  } catch (e) {
    console.warn('sendActionToTab failed to', targetId, '- falling back to lastTabId');
    if (targetId !== lastTabId) {
      try {
        await chrome.tabs.sendMessage(lastTabId, { type: 'INJECT_AND_EXECUTE', action });
      } catch (e2) {
        console.warn('sendActionToTab fallback also failed:', e2);
      }
    }
  }
}

async function selectAiAction(recording) {
  try {
    const latestState = recording.states[recording.states.length - 1]?.state;
    if (!latestState) { console.log('selectAiAction: no latest state'); return null; }

    const seqAction = await trySequences(latestState);
    if (seqAction) { console.log('selectAiAction: sequence returned', getActionKey(seqAction)); return seqAction; }

    const resourceAction = await cardToResource(latestState);
    if (resourceAction) { console.log('selectAiAction: cardToResource returned', getActionKey(resourceAction)); return resourceAction; }

    let allActions = getAvailableActions(latestState);
    let actions = allActions.filter(a => !failedActionKeys.has(getActionKey(a)));
    if (actions.length !== allActions.length) {
      console.log('selectAiAction: filtered failed actions', { total: allActions.length, afterFilter: actions.length });
    }
    if (actions.length === 0 && allActions.length > 0) {
      console.log('selectAiAction: all actions were in failedActionKeys, clearing set and retrying');
      failedActionKeys.clear();
      actions = allActions;
    }
    console.log('selectAiAction: no sequence or resource action, falling through to model', { actionsCount: actions.length });
    if (actions.length === 0) return null;

    // Never choose Cancel or Close if any other option exists
    const nonCancelActions = actions.filter(a => !isCancelAction(a));
    if (nonCancelActions.length > 0) {
      if (nonCancelActions.length !== actions.length) {
        console.log('selectAiAction: filtered Cancel actions', { total: actions.length, afterFilter: nonCancelActions.length });
      }
      actions = nonCancelActions;
    }

    // Try plan-based selection first (only during action/resource phases)
    const planPhase = detectPhase(latestState);
    if (currentTurnPlan && currentTurnPlan.items && currentTurnPlan.items.length > 0 && (planPhase === 'action' || planPhase === 'resource')) {
      if (currentTurnPlan.stateHash !== getBotActionsHash(latestState)) {
        currentTurnPlan = reviseTurnPlan(latestState, currentTurnPlan);
        broadcastPlan(currentTurnPlan);
      }
      const currentItem = currentTurnPlan.items.find(i => i.status === 'current' && i.source === 'bot' && !isCancelAction(i.action));
      if (currentItem) {
        const actionKey = getActionKey(currentItem.action);
        const matchedAction = actions.find(a => getActionKey(a) === actionKey && planTextMatches(currentItem, a));
        if (matchedAction) {
          console.log('selectAiAction: plan returned', actionKey, currentItem.description);
          return currentItem.action;
        }
      }
      const firstPending = currentTurnPlan.items.find(i => i.source === 'bot' && (i.status === 'pending' || i.status === 'current') && !isCancelAction(i.action));
      if (firstPending) {
        const actionKey = getActionKey(firstPending.action);
        const matchedAction = actions.find(a => getActionKey(a) === actionKey && planTextMatches(firstPending, a));
        if (matchedAction) {
          firstPending.status = 'current';
          broadcastPlan(currentTurnPlan);
          console.log('selectAiAction: plan first pending', actionKey, firstPending.description);
          return firstPending.action;
        }
      }
    }

    const model = await loadModel();
    if (!model) { console.log('selectAiAction: no model loaded'); return null; }

    const stateTensor = encodeGameState(latestState);
    const actionFeatures = encodeActions(actions);
    const chosen = selectBestAction(model, stateTensor, actionFeatures, actions);
    console.log('selectAiAction: model chose', getActionKey(chosen), chosen ? describeAction(chosen, latestState) : '');
    if (chosen && isCancelAction(chosen)) {
      const alternatives = actions.filter(a => !isCancelAction(a));
      if (alternatives.length > 0) {
        console.log('selectAiAction: model chose Cancel, picking alternative');
        const cardClicks = alternatives.filter(a => a.type === 'cardClicked');
        if (cardClicks.length > 0) return cardClicks[Math.floor(Math.random() * cardClicks.length)];
        const claimBtn = alternatives.find(a => a.type === 'menuButton' && (String(a.arg ?? '').toLowerCase().includes('claim') || String(a.command ?? '').toLowerCase().includes('claim')));
        if (claimBtn) return claimBtn;
        return alternatives[Math.floor(Math.random() * alternatives.length)];
      }
    }
    if (chosen && chosen.type === 'menuButton' && (chosen.arg === 'pass' || chosen.command === 'pass')) {
      const alternatives = actions.filter(a => {
        if (a.type !== 'menuButton') return true;
        return a.arg !== 'pass' && a.command !== 'pass';
      });
      if (alternatives.length > 0) {
        const cardClicks = alternatives.filter(a => a.type === 'cardClicked');
        if (cardClicks.length > 0) return cardClicks[Math.floor(Math.random() * cardClicks.length)];
        const claimBtn = alternatives.find(a => a.type === 'menuButton' && (String(a.arg ?? '').toLowerCase().includes('claim') || String(a.command ?? '').toLowerCase().includes('claim')));
        if (claimBtn) return claimBtn;
        return alternatives[Math.floor(Math.random() * alternatives.length)];
      }
    }
    return chosen;
  } catch (e) {
    console.error('AI selection failed:', e);
    return null;
  }
}

function getCardName(card) {
  if (!card) return null;
  return card.title || card.name || card.card?.title || card.card?.name || card.definition?.title || card.definition?.name || card.displayName || card.label || null;
}

function findCardInfo(cardId, gameState) {
  if (!gameState || !gameState.players) return null;
  for (const playerId of Object.keys(gameState.players)) {
    const piles = gameState.players[playerId]?.cardPiles || {};
    for (const pileKey of ['hand', 'groundArena', 'spaceArena', 'resources', 'discard', 'leader']) {
      const pile = piles[pileKey];
      if (Array.isArray(pile)) {
        for (const card of pile) {
          if ((card.uuid || card.id) === cardId) {
            return { title: getCardName(card), pile: pileKey, cost: card.cost, power: card.power, hp: card.hp, damage: card.damage };
          }
        }
      } else if (pile && (pile.uuid || pile.id) === cardId) {
        return { title: getCardName(pile), pile: pileKey, cost: pile.cost, power: pile.power, hp: pile.hp, damage: pile.damage };
      }
    }
    // Check player-level leader and base
    const leader = gameState.players[playerId]?.leader;
    if (leader) {
      const leaderId = leader.uuid || leader.id;
      if (leaderId === cardId) {
        return { title: getCardName(leader), pile: 'leader', cost: leader.cost, power: leader.power, hp: leader.hp, damage: leader.damage };
      }
    }
    const base = gameState.players[playerId]?.base;
    if (base) {
      const baseId = base.uuid || base.id;
      if (baseId === cardId) {
        return { title: getCardName(base), pile: 'base', cost: null, power: null, hp: null, damage: base.damage };
      }
    }
  }
  return null;
}

function describeAction(a, gameState) {
  if (a.type === 'cardClicked') {
    if (!gameState) return a.cardId || 'Select card';
    const info = findCardInfo(a.cardId, gameState);
    if (!info) return 'Select card';

    const name = info.title || `[${info.pile}]`;
    const stats = [];
    if (info.cost != null) stats.push('C:' + info.cost);
    if (info.power != null) stats.push('P:' + info.power);
    if (info.hp != null) stats.push('HP:' + info.hp);
    const suffix = stats.length ? ' (' + stats.join(' ') + ')' : '';

    const player = getMyPlayerState(gameState);
    const mode = player?.promptState?.selectCardMode || '';

    if (mode !== '' && mode !== 'none') {
      if (mode.includes('resource')) return `Resource ${name}${suffix}`;
      if (mode.includes('target') || mode.includes('attack')) return `Target ${name}${suffix}`;
      if (mode.includes('defend')) return `Defend with ${name}${suffix}`;
      if (mode.includes('discard')) return `Discard ${name}${suffix}`;
      return `Select ${name}${suffix}`;
    }

    if (info.pile === 'hand') return `Play ${name}${suffix}`;
    if (info.pile === 'groundArena' || info.pile === 'spaceArena') return `Attack with ${name}${suffix}`;
    if (info.pile === 'leader') return `Use ${name}${suffix}`;
    if (info.pile === 'base') return `Attack ${name}${suffix}`;

    return `Select ${name}${suffix}`;
  }
  if (a.type === 'statefulPromptResults') {
    const dist = a.distribution;
    if (dist && dist.valueDistribution) {
      const total = dist.valueDistribution.reduce((s, d) => s + d.amount, 0);
      const targets = dist.valueDistribution.length;
      return `Distribute ${total} ${dist.type || 'damage'} to ${targets} target${targets !== 1 ? 's' : ''}`;
    }
    return `Submit ${dist?.type || 'distribution'}`;
  }
  return a.text || a.arg || a.command || 'Action';
}

// ── Turn Plan ─────────────────────────────────────────────────────

function categorizeAction(action, state, playerId) {
  if (action.type === 'menuButton') {
    const arg = String(action.arg ?? '').toLowerCase();
    if (arg === 'pass' || arg.includes('pass')) return 'pass';
    if (arg === 'keep' || arg === 'mulligan') return 'mulligan';
    if (arg === 'claiminitiative' || arg.includes('claim') || arg.includes('initiative')) return 'initiative';
    if (arg === 'resource' || arg.includes('resource')) return 'resource';
    if (arg === 'attack' || arg.includes('attack')) return 'attack';
    if (arg === 'play' || arg.includes('play') || arg === 'done') return 'play';
    return 'menu';
  }
  if (action.type === 'cardClicked' && state) {
    const info = findCardInfo(action.cardId, state);
    if (info) {
      if (info.pile === 'hand') return 'play';
      if (info.pile === 'groundArena' || info.pile === 'spaceArena') return 'attack';
      if (info.pile === 'leader') return 'ability';
    }
    return 'select';
  }
  return 'other';
}

function getActionsForPlayer(gameState, playerId) {
  if (!gameState?.players) return [];
  const player = gameState.players[playerId];
  if (!player) return [];
  const actions = [];
  const prompt = player.promptState;
  if (prompt && prompt.buttons && prompt.buttons.length > 0) {
    for (let bi = 0; bi < prompt.buttons.length; bi++) {
      const btn = prompt.buttons[bi];
      const btnText = btn.text || btn.label || btn.name || btn.title || btn.description || btn.value || btn.content || btn.arg || btn.command || `Option ${bi + 1}`;
      actions.push({ type: 'menuButton', arg: btn.arg ?? btn.value ?? btn.id ?? '', uuid: btn.uuid ?? prompt.promptUuid ?? '', command: btn.command || '', text: btnText });
    }
  }
  const piles = player.cardPiles || {};
  for (const pileKey of ['hand', 'groundArena', 'spaceArena', 'resources', 'discard', 'leader']) {
    const pile = piles[pileKey];
    if (Array.isArray(pile)) {
      for (const card of pile) {
        if (card.selectable && !card.selected) actions.push({ type: 'cardClicked', cardId: card.uuid || card.id });
      }
    } else if (pile && pile.selectable && !pile.selected) {
      actions.push({ type: 'cardClicked', cardId: pile.uuid || pile.id });
    }
  }
  const leader = player.leader;
  if (leader && leader.selectable && !leader.selected) {
    const lid = leader.uuid || leader.id;
    if (lid) actions.push({ type: 'cardClicked', cardId: lid });
  }
  const base = player.base;
  if (base && base.selectable && !base.selected) {
    const bid = base.uuid || base.id;
    if (bid) actions.push({ type: 'cardClicked', cardId: bid });
  }
  return actions;
}

function predictOpponentActions(state, model) {
  if (!state?.players) return [];
  const botId = currentGameRecording?.playerId;
  if (!botId) return [];
  const oppId = Object.keys(state.players).find(id => id !== botId);
  if (!oppId) return [];
  const oppActions = getActionsForPlayer(state, oppId);
  if (oppActions.length === 0) return [];
  const stateTensor = encodeGameStateForPlayer(state, oppId);
  const actionFeatures = encodeActions(oppActions);
  const scored = oppActions.map((a, i) => {
    const rawScore = model ? model.forward(stateTensor, actionFeatures[i]) : 0;
    const dispersion = hashActionKey(getActionKey(a)) * 0.02 - 0.01;
    return {
      action: a,
      description: describeAction(a, state),
      score: rawScore + dispersion,
      source: 'opponent',
      status: 'predicted',
      category: categorizeAction(a, state, oppId)
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function isBotFirstActive(state) {
  const botId = currentGameRecording?.playerId;
  if (!botId || !state?.players) return true;
  const me = state.players[botId];
  if (me?.isActionPhaseActivePlayer) return true;
  const activeId = findActivePlayerId(state);
  return activeId === botId;
}

function interleaveItems(botItems, oppItems, botFirst) {
  const items = [];
  let bi = 0, oi = 0;
  let nextIsBot = botFirst;
  while (bi < botItems.length || oi < oppItems.length) {
    if (nextIsBot && bi < botItems.length) {
      items.push({ ...botItems[bi], status: 'pending' });
      bi++;
    } else if (!nextIsBot && oi < oppItems.length) {
      items.push({ ...oppItems[oi], status: 'predicted' });
      oi++;
    } else if (bi < botItems.length) {
      items.push({ ...botItems[bi], status: 'pending' });
      bi++;
    } else if (oi < oppItems.length) {
      items.push({ ...oppItems[oi], status: 'predicted' });
      oi++;
    }
    nextIsBot = !nextIsBot;
  }
  return items;
}

function detectPhase(state) {
  if (!state?.players) return 'unknown';
  const botId = currentGameRecording?.playerId;
  if (!botId) return 'unknown';
  const me = state.players[botId];
  const prompt = me?.promptState || {};
  const promptType = prompt.promptType || '';
  const mode = prompt.selectCardMode || 'none';
  if (state.winners?.length > 0) return 'end';
  if (promptType === 'resource' || (mode !== 'none' && mode.includes('resource'))) return 'resource';
  if (promptType === 'initiative') return 'initiative';
  if (promptType === 'action' || promptType === 'regroup') return promptType;
  const anyPrompt = Object.values(state.players).find(p => p?.promptState?.promptType);
  if (anyPrompt) return anyPrompt.promptState.promptType;
  return 'action';
}

async function generateTurnPlan(state) {
  const botId = currentGameRecording?.playerId;
  if (!botId || !state?.players) return null;
  const model = await loadModel();
  const oppId = Object.keys(state.players).find(id => id !== botId);
  const phase = detectPhase(state);
  const round = state.roundNumber || 0;
  const stateHash = getBotActionsHash(state);

  const allActions = getActionsForPlayer(state, botId);
  const activeActions = allActions.filter(a => !failedActionKeys.has(getActionKey(a)));
  if (activeActions.length === 0) return null;

  const stateTensor = encodeGameState(state);
  const actionFeatures = encodeActions(activeActions);

  const scoredBot = activeActions.map((a, i) => {
    const rawScore = model ? model.forward(stateTensor, actionFeatures[i]) : 0;
    const dispersion = hashActionKey(getActionKey(a)) * 0.02 - 0.01;
    return {
      action: a,
      description: describeAction(a, state),
      score: rawScore + dispersion,
      source: 'bot',
      status: 'pending',
      category: categorizeAction(a, state, botId)
    };
  });

  const catOrder = ['resource', 'play', 'ability', 'attack', 'select', 'menu', 'initiative', 'mulligan', 'pass', 'other'];
  scoredBot.sort((a, b) => {
    const ca = catOrder.indexOf(a.category);
    const cb = catOrder.indexOf(b.category);
    if (ca !== cb) return ca - cb;
    return b.score - a.score;
  });

  const oppPreds = predictOpponentActions(state, model);
  const botFirst = isBotFirstActive(state);
  const items = interleaveItems(scoredBot, oppPreds, botFirst);

  const plan = {
    phase,
    round,
    stateHash,
    items,
    botId,
    oppId: oppId || null,
    generatedAt: Date.now()
  };
  return plan;
}

function reviseTurnPlan(state, plan) {
  if (!plan || !plan.items || !state) return plan;
  const botId = currentGameRecording?.playerId;
  const currentHash = getBotActionsHash(state);
  const currentActions = botId ? getActionsForPlayer(state, botId) : getAvailableActions(state);
  const currentKeys = new Set(currentActions.map(a => getActionKey(a)));

  // 1. Detect done actions: pending bot actions that are no longer available
  for (const item of plan.items) {
    if (item.source === 'bot' && item.status === 'pending') {
      if (!currentKeys.has(getActionKey(item.action))) {
        item.status = 'done';
      }
    }
    if (item.source === 'opponent' && item.status === 'predicted') {
      if (!currentKeys.has(getActionKey(item.action))) {
        item.status = 'done';
      }
    }
  }

  // 2. Mark current: first pending bot action
  let foundCurrent = false;
  for (const item of plan.items) {
    if (item.source === 'bot' && item.status === 'pending' && !foundCurrent) {
      item.status = 'current';
      foundCurrent = true;
    } else if (item.source === 'bot' && item.status === 'current' && foundCurrent) {
      item.status = 'pending';
    }
  }

  // 3. Remove predicted items that correspond to completed bot actions (stale predictions)
  const completedCount = plan.items.filter(i => i.status === 'done' && i.source === 'bot').length;
  if (completedCount > 0) {
    let predRemoved = 0;
    plan.items = plan.items.filter(i => {
      if (i.source === 'opponent' && (i.status === 'done' || i.status === 'predicted')) {
        if (predRemoved < completedCount) { predRemoved++; return false; }
      }
      return true;
    });
  }

  // 4. Add new actions that appeared since plan generation
  const planKeys = new Set(plan.items.filter(i => i.source === 'bot').map(i => getActionKey(i.action)));
  const newActions = currentActions.filter(a => !planKeys.has(getActionKey(a)) && !failedActionKeys.has(getActionKey(a)));
  if (newActions.length > 0) {
    const model = loadModel(); // best-effort fire-and-forget
    if (state?.players) {
      model.then(m => {
        const st = encodeGameState(state);
        const af = encodeActions(newActions);
        const newScored = newActions.map((a, i) => ({
          action: a,
          description: describeAction(a, state),
          score: m ? m.forward(st, af[i]) : 0,
          source: 'bot',
          status: 'pending',
          category: categorizeAction(a, state, botId)
        }));
        const catOrder = ['resource', 'play', 'ability', 'attack', 'select', 'menu', 'initiative', 'mulligan', 'pass', 'other'];
        newScored.sort((a, b) => {
          const ca = catOrder.indexOf(a.category);
          const cb = catOrder.indexOf(b.category);
          if (ca !== cb) return ca - cb;
          return b.score - a.score;
        });
        plan.items.push(...newScored.map(i => ({ ...i, status: 'pending' })));
        broadcastPlan(plan);
      });
    }
  }

  plan.stateHash = currentHash;
  return plan;
}

function broadcastPlan(plan) {
  const serialized = plan ? JSON.parse(JSON.stringify(plan)) : null;
  chrome.runtime.sendMessage({ type: 'PLAN_UPDATE', plan: serialized }).catch(() => {});
}

// ── End Turn Plan ─────────────────────────────────────────────────

async function sendRecommendations(recording) {
  try {
    if (!recording) return;
    const latestState = recording.states[recording.states.length - 1]?.state;
    if (!latestState) return;
    console.log('sendRecommendations called V4', { autoPlay, isAiPlaying, pendingAutoPlay, statesLen: recording.states.length, stateId: latestState.id });

    // Guard: if botPlayerId is set and it's not the bot's turn, skip entirely
    // Prevents stale state from wrong tab causing false failure detection
    if (botPlayerId && latestState?.players) {
      const myPlayer = getMyPlayerState(latestState);
      if (!myPlayer) {
        console.log('sendRecommendations: not our turn, skipping');
        return;
      }
    }

    // Failed action detection: if state hash matches lastSentStateHash, action had no effect
    if (currentPlayerId && lastSentStateHash[currentPlayerId] !== undefined) {
      const currentHash = getActionSetHash(latestState);
      if (currentHash === lastSentStateHash[currentPlayerId]) {
        failedActionKeys.add(lastSentActionKey[currentPlayerId]);
        console.log('failedActionKeys added', lastSentActionKey[currentPlayerId]);
      } else {
        failedActionKeys.clear();
      }
      delete lastSentActionKey[currentPlayerId];
      delete lastSentStateHash[currentPlayerId];
    }

    const allActions = getAvailableActions(latestState);
    let actions = allActions.filter(a => !failedActionKeys.has(getActionKey(a)));
    if (actions.length !== allActions.length) {
      console.log('sendRecommendations: filtered failed actions', { total: allActions.length, afterFilter: actions.length });
    }
    if (actions.length === 0 && allActions.length > 0) {
      console.log('sendRecommendations: all actions were in failedActionKeys, clearing set and retrying');
      failedActionKeys.clear();
      actions = allActions;
    }
    if (actions.length === 0) {
      // Try extracting buttons directly from any player's promptState
      if (latestState?.players) {
        for (const pid of Object.keys(latestState.players)) {
          const p = latestState.players[pid];
          const ps = p?.promptState;
          if (ps?.buttons?.length > 0) {
            for (let bi = 0; bi < ps.buttons.length; bi++) {
              const btn = ps.buttons[bi];
              const btnText = btn.text || btn.label || btn.name || btn.title || btn.description || btn.value || btn.content || btn.arg || btn.command || `Option ${bi + 1}`;
              actions.push({ type: 'menuButton', arg: btn.arg ?? btn.value ?? btn.id ?? '', uuid: btn.uuid ?? ps.promptUuid ?? '', command: btn.command || '', text: btnText });
            }
            break;
          }
        }
      }
      // Try the last unknown event as fallback
      if (actions.length === 0 && lastUnknownEvent?.data) {
        const ed = lastUnknownEvent.data;
        // Check common array field names for buttons/choices
        for (const key of ['buttons', 'options', 'choices', 'actions', 'menuItems', 'selections', 'prompts', 'triggers', 'items', 'entries', 'perCardButtons', 'players']) {
          if (Array.isArray(ed[key]) && ed[key].length > 0) {
            for (let ei = 0; ei < ed[key].length; ei++) {
              const entry = ed[key][ei];
              const btnText = entry.text || entry.label || entry.name || entry.title || entry.description || entry.arg || entry.action || entry.value || entry.command || `Option ${ei + 1}`;
              actions.push({ type: 'menuButton', arg: entry.arg ?? entry.action ?? entry.value ?? entry.id ?? key, uuid: entry.uuid ?? '', command: entry.command || '', text: btnText });
            }
            if (actions.length > 0) break;
          }
        }
        // Also check for object-type options (key-value pairs)
        if (actions.length === 0) {
          for (const key of ['options', 'choices', 'actions', 'selections']) {
            if (ed[key] && typeof ed[key] === 'object' && !Array.isArray(ed[key])) {
              for (const [optKey, optVal] of Object.entries(ed[key])) {
                const label = typeof optVal === 'string' ? optVal : (optVal.text || optVal.label || optVal.name || optVal.title || optKey);
                actions.push({ type: 'menuButton', arg: optVal.arg ?? optVal.action ?? optVal.value ?? optKey, uuid: optVal.uuid ?? '', command: optVal.command || '', text: label });
              }
              if (actions.length > 0) break;
            }
          }
        }
        // Check for displayCards – create cardClicked entries
        if (actions.length === 0 && Array.isArray(ed.displayCards) && ed.displayCards.length > 0) {
          for (const card of ed.displayCards) {
            const cardId = card.uuid || card.id;
            if (cardId) actions.push({ type: 'cardClicked', cardId, text: card.name || card.title || 'Select card' });
          }
        }
      }
      if (actions.length === 0) {
        // Last resort: show diagnostic info about the event so the user can report it
        if (lastUnknownEvent?.data) {
          const ed = lastUnknownEvent.data;
          actions.push({ type: 'menuButton', text: `[Debug] Event: ${lastUnknownEvent.name} | Keys: ${Object.keys(ed).join(', ')}`, arg: 'debug' });
          for (const [k, v] of Object.entries(ed)) {
            if (typeof v === 'string' && v.length > 2 && v.length < 120) {
              actions.push({ type: 'menuButton', text: `${k}: ${v}`, arg: k });
            }
          }
        }
        if (actions.length === 0) return;
      }
    }

    // Never choose Cancel or Close if any other option exists
    const cancelActions = actions.filter(a => isCancelAction(a));
    if (cancelActions.length > 0 && cancelActions.length < actions.length) {
      actions = actions.filter(a => !isCancelAction(a));
      console.log('sendRecommendations: filtered Cancel actions', { total: actions.length, filteredCancel: cancelActions.length });
    }

    // Auto-confirm resourcing
    const recPlayer = getMyPlayerState(latestState);
    const isResource = isResourcePhase(recPlayer, actions);
    console.log('auto-confirm check', { hasPlayer: !!recPlayer, isResourcePhase: isResource, actionsCount: actions.length, selectableHand: recPlayer ? recPlayer.cardPiles?.hand?.filter(c => c.selectable)?.length : 0, selectedHand: recPlayer ? recPlayer.cardPiles?.hand?.filter(c => c.selected)?.length : 0 });
    if (recPlayer && isResource) {
      const hand = recPlayer.cardPiles?.hand || [];
      const selected = hand.filter(c => c.selected);
      if (selected.length > 0) {
        const used = (recPlayer?.cardPiles?.resources || []).length;
        const remaining = hand.filter(c => c.selectable && !c.selected);
        const needsTwo = used === 0;
        console.log('auto-confirm selected check', { selectedLen: selected.length, used, remainingLen: remaining.length, needsTwo, enough: ((needsTwo && selected.length >= 2) || (!needsTwo && selected.length >= 1) || remaining.length === 0) });
        if ((needsTwo && selected.length >= 2) || (!needsTwo && selected.length >= 1) || remaining.length === 0) {
          const confirmBtn = actions.find(a => a.type === 'menuButton');
          if (confirmBtn) {
            console.log('auto-confirm: confirming resources', confirmBtn);
            await sendActionToTab(confirmBtn);
            return;
          }
        }
      }
    }

    // Auto-select if exactly one card-click action during selection mode
    if (recPlayer) {
      const prompt = recPlayer.promptState || {};
      if (prompt.selectCardMode && prompt.selectCardMode !== 'none') {
        const cardActions = actions.filter(a => a.type === 'cardClicked');
        if (cardActions.length === 1) {
          await sendActionToTab(cardActions[0]);
          return;
        }
      }
    }

    // Turn plan generation/update (for visualization and action ordering)
    if (currentGameRecording?.playerId && latestState && actions.length > 0) {
      if (!currentTurnPlan || currentTurnPlan.stateHash !== getBotActionsHash(latestState) || currentTurnPlan.round !== (latestState.roundNumber || 0)) {
        currentTurnPlan = await generateTurnPlan(latestState);
      } else {
        currentTurnPlan = reviseTurnPlan(latestState, currentTurnPlan);
      }
      broadcastPlan(currentTurnPlan);
    }

    // Auto-play: auto-execute the best action without overlay
    if (autoPlay) {
      // Per-player pending check: allow concurrent auto-play for different players
      if (pendingAutoPlayPlayers.has(currentPlayerId)) {
        console.log('autoPlay: pendingAutoPlay locked for', currentPlayerId, 'skipping');
        return;
      }
      const apPlayerId = currentPlayerId;
      console.log('autoPlay: starting auto-play cycle for', apPlayerId);
      pendingAutoPlay = true;
      pendingAutoPlayPlayers.add(apPlayerId);
      try {
        const autoAction = await selectAiAction(recording);
        console.log('autoPlay: selectAiAction returned', autoAction ? getActionKey(autoAction) : 'null');
        if (autoAction) {
          let delay = minWait + Math.random() * (maxWait - minWait);
          if (actions.length <= 2) {
            delay /= 2;
          }
          delay = Math.max(delay, 1000);
          const desc = describeAction(autoAction, latestState);
          if (delay > 0) {
            if (lastTabId) {
              const cdTabId = getBotTabId(apPlayerId);
              if (cdTabId) chrome.tabs.sendMessage(cdTabId, { type: 'SHOW_COUNTDOWN', description: desc, totalMs: Math.round(delay) }).catch(() => {});
            }
            await new Promise(r => setTimeout(r, delay));
          }
          // Capture state hash right before send, after delay, to avoid false-positive
          // failure detection from GAMESTATE events arriving during the wait.
          lastSentStateHash[apPlayerId] = getActionSetHash(latestState);
          lastSentActionKey[apPlayerId] = getActionKey(autoAction);
          await sendActionToTab(autoAction, apPlayerId);
        }
      } finally {
        pendingAutoPlayPlayers.delete(apPlayerId);
        if (pendingAutoPlayPlayers.size === 0) pendingAutoPlay = false;
      }
      return;
    }

    // Mulligan/keep: show both options as recommendations
    const keepBtn = actions.find(a => matchesMulliganAction(a, 'keep'));
    const mulliganBtn = actions.find(a => matchesMulliganAction(a, 'mulligan'));
    if (keepBtn && mulliganBtn) {
      pendingRecommendations = [keepBtn, mulliganBtn];
      const recTabId = getBotTabId();
      if (recTabId) chrome.tabs.sendMessage(recTabId, { type: 'SHOW_RECOMMENDATIONS', recommendations: [
        { description: describeAction(keepBtn, latestState), score: 0.55, action: keepBtn },
        { description: describeAction(mulliganBtn, latestState), score: 0.45, action: mulliganBtn }
      ] }).catch(() => {});
      return;
    }

    const model = await loadModel();
    if (model) {
      const stateTensor = encodeGameState(latestState);
      const actionFeatures = encodeActions(actions);
      const top = selectTopActions(model, stateTensor, actionFeatures, actions, 5);
      if (top.length > 0) {
        if (top[0].action.type === 'menuButton' && (top[0].action.arg === 'pass' || top[0].action.command === 'pass')) {
          const nonPass = actions.filter(a => {
            if (a.type !== 'menuButton') return true;
            return a.arg !== 'pass' && a.command !== 'pass';
          });
          if (nonPass.length > 0) {
            const af = encodeActions(nonPass);
            const altTop = selectTopActions(model, stateTensor, af, nonPass, 5);
            if (altTop.length > 0) {
              pendingRecommendations = altTop.map(t => t.action);
              const altTabId = getBotTabId();
              if (altTabId) chrome.tabs.sendMessage(altTabId, { type: 'SHOW_RECOMMENDATIONS', recommendations: altTop.map(t => ({ description: describeAction(t.action, latestState), score: t.score, action: t.action })) }).catch(() => {});
              return;
            }
          }
        }
        pendingRecommendations = top.map(t => t.action);
        const topTabId = getBotTabId();
        if (topTabId) chrome.tabs.sendMessage(topTabId, { type: 'SHOW_RECOMMENDATIONS', recommendations: top.map(t => ({ description: describeAction(t.action, latestState), score: t.score, action: t.action })) }).catch(() => {});
        return;
      }
    }

    // Fallback: show available actions without model scoring
    pendingRecommendations = actions.slice(0, 5);
    const fallbackTabId = getBotTabId();
    if (fallbackTabId) chrome.tabs.sendMessage(fallbackTabId, { type: 'SHOW_RECOMMENDATIONS', recommendations: actions.slice(0, 5).map(a => ({ description: describeAction(a, latestState), score: 0.5, action: a })) }).catch(() => {});
  } catch (e) {
    console.error('sendRecommendations failed:', e);
  } finally {
    syncSessionGlobals();
  }
}

async function cardToResource(state) {
  const player = getMyPlayerState(state);
  if (!player) { console.log('cardToResource: no player'); return null; }
  const actions = getAvailableActions(state).filter(a => !failedActionKeys.has(getActionKey(a)));
  const isRes = isResourcePhase(player, actions);
  console.log('cardToResource: phase check', { isResource: isRes, actionsCount: actions.length });
  if (!isRes) return null;

  const used = (player?.cardPiles?.resources || []).length;
  const leaderCost = player?.leader?.cost ?? player?.cardPiles?.leader?.[0]?.cost ?? 6;
  console.log('cardToResource: resources', { used, leaderCost, maxNeeded: Math.max(leaderCost, 2) });
  if (used >= Math.max(leaderCost, 2)) { console.log('cardToResource: enough resources'); return null; }

  const hand = player?.cardPiles?.hand || [];
  const selectable = hand.filter(c => c.selectable);
  const selected = hand.filter(c => c.selected);
  console.log('cardToResource: hand', { handLen: hand.length, selectableLen: selectable.length, selectedLen: selected.length });

  const needsTwo = used === 0;
  const enoughSelected = (needsTwo && selected.length >= 2) || (!needsTwo && selected.length >= 1);

  // All selectable done or enough selected → confirm
  if ((selectable.length === 0 && selected.length > 0) || enoughSelected) {
    const btn = actions.find(a => a.type === 'menuButton');
    if (btn) { console.log('cardToResource: confirming', { btn: btn.arg }); return btn; }
    return null;
  }

  // Some selected but not enough yet → keep selecting
  if (selected.length > 0) {
    console.log('cardToResource: selected but not enough', { selectedLen: selected.length, needsTwo });
    // fall through to select another card below
  }

  if (selectable.length > 0) {
    const unselected = selectable.filter(c => !c.selected);
    console.log('cardToResource: selecting from unselected', { unselectedLen: unselected.length });
    if (unselected.length === 0) {
      const btn = actions.find(a => a.type === 'menuButton');
      if (btn) return btn;
      return null;
    }
    const model = await loadModel();
    const cardActions = unselected.map(c => ({ type: 'cardClicked', cardId: c.uuid || c.id }));
    if (model && cardActions.length > 1) {
      const stateTensor = encodeGameState(state);
      const actionFeatures = encodeActions(cardActions);
      const best = selectBestAction(model, stateTensor, actionFeatures, cardActions);
      if (best) { console.log('cardToResource: NN chose', best.cardId); return best; }
    }
    console.log('cardToResource: picking first card', cardActions[0]?.cardId);
    return cardActions[0];
  }

  console.log('cardToResource: nothing to do');
  return null;
}

function matchesMulliganAction(a, keyword) {
  return String(a.arg ?? '').toLowerCase().includes(keyword) ||
         String(a.command ?? '').toLowerCase().includes(keyword) ||
         String(a.text ?? '').toLowerCase().includes(keyword);
}

function isCancelAction(a) {
  return matchesMulliganAction(a, 'cancel') || matchesMulliganAction(a, 'close');
}

function planTextMatches(planItem, currentAction) {
  // Verify the current action's text is similar to the plan item's text,
  // preventing stale key collisions where different buttons share the same arg.
  const planText = String(planItem.action.text || planItem.action.arg || planItem.description || '').toLowerCase().trim();
  const currentText = String(currentAction.text || currentAction.arg || currentAction.command || '').toLowerCase().trim();
  if (!planText || !currentText) return true;
  return planText === currentText || planText.includes(currentText) || currentText.includes(planText);
}

async function trySequences(state) {
  const actions = getAvailableActions(state).filter(a => !failedActionKeys.has(getActionKey(a)));
  if (actions.length === 0) return null;

  // Always allow opponent undo/takeback requests
  const allowBtn = actions.find(a => matchesMulliganAction(a, 'allow') || matchesMulliganAction(a, 'approve'));
  const denyBtn = actions.find(a => matchesMulliganAction(a, 'deny') || matchesMulliganAction(a, 'reject'));
  if (allowBtn && denyBtn) {
    console.log('undo: allowing opponent undo', { arg: allowBtn.arg, text: allowBtn.text });
    return allowBtn;
  }

  // Distribute damage / healing among targets — submit statefulPromptResults
  const player = getMyPlayerState(state);
  if (player?.promptState?.promptType === 'distributeAmongTargets') {
    const promptData = player.promptState.distributeAmongTargets;
    if (promptData) {
      const doneBtn = actions.find(a => a.command === 'statefulPromptResult' || matchesMulliganAction(a, 'done') || matchesMulliganAction(a, 'confirm'));
      const promptUuid = doneBtn?.uuid || player.promptState.promptUuid || '';
      const { type: distributeType, amount, canDistributeLess, canChooseNoTargets, maxTargets } = promptData;

      const selectableIds = getSelectableCardIds(state);

      // No targets — submit empty if allowed, else fallback to done
      if (selectableIds.length === 0) {
        if (canChooseNoTargets) {
          console.log('distribute: no targets, submitting empty');
          return { type: 'statefulPromptResults', distribution: { type: distributeType, valueDistribution: [] }, uuid: promptUuid };
        }
        console.log('distribute: no targets but distribution required');
        return doneBtn || null;
      }

      // Score each target via NN (encode as cardClicked)
      const model = await loadModel();
      const cardActions = selectableIds.map(id => ({ type: 'cardClicked', cardId: id }));
      let scored;
      if (model && cardActions.length > 0) {
        const stateTensor = encodeGameState(state);
        const actionFeatures = encodeActions(cardActions);
        scored = selectableIds.map((id, i) => {
          const rawScore = model.forward(stateTensor, actionFeatures[i]);
          const cleanScore = isNaN(rawScore) || !isFinite(rawScore) ? 0.5 : rawScore;
          return { uuid: id, score: cleanScore };
        });
      } else {
        scored = selectableIds.map(id => ({ uuid: id, score: 0.5 }));
      }

      // Sort by score descending, apply maxTargets limit
      scored.sort((a, b) => b.score - a.score);
      if (maxTargets && maxTargets > 0 && maxTargets < scored.length) {
        scored = scored.slice(0, maxTargets);
      }

      // Proportional distribution by score
      const totalScore = scored.reduce((sum, t) => sum + Math.max(0.01, t.score), 0);
      const valueDistribution = [];
      let remaining = amount;

      for (let i = 0; i < scored.length; i++) {
        let allocated;
        if (i === scored.length - 1) {
          allocated = remaining;
        } else {
          const proportion = Math.max(0.01, scored[i].score) / totalScore;
          allocated = Math.max(0, Math.min(remaining, Math.round(amount * proportion)));
        }
        if (distributeType === 'distributeIndirectDamage') {
          const cardInfo = findCardInfo(scored[i].uuid, state);
          if (cardInfo && cardInfo.hp != null) {
            allocated = Math.min(allocated, cardInfo.hp - (cardInfo.damage ?? 0));
          }
        }
        valueDistribution.push({ uuid: scored[i].uuid, amount: allocated });
        remaining -= allocated;
      }

      const filtered = valueDistribution.filter(d => d.amount > 0);

      if (filtered.length === 0 && canChooseNoTargets) {
        console.log('distribute: all zero, submitting empty');
        return { type: 'statefulPromptResults', distribution: { type: distributeType, valueDistribution: [] }, uuid: promptUuid };
      }

      console.log('distribute: submitting distribution', { type: distributeType, targets: filtered, total: filtered.reduce((s, d) => s + d.amount, 0), amount });
      return {
        type: 'statefulPromptResults',
        distribution: { type: distributeType, valueDistribution: filtered.length > 0 ? filtered : [] },
        uuid: promptUuid
      };
    }

    // Fallback: old cardClicked/perCard/done behavior
    const cardActions = actions.filter(a => a.type === 'cardClicked');
    const perCardActions = actions.filter(a => a.type === 'menuButton' && a.cardId);
    const doneBtn = actions.find(a => matchesMulliganAction(a, 'done') || matchesMulliganAction(a, 'confirm'));
    if (cardActions.length > 0) {
      const model = await loadModel();
      if (model && cardActions.length > 1) {
        const stateTensor = encodeGameState(state);
        const actionFeatures = encodeActions(cardActions);
        const chosen = selectBestAction(model, stateTensor, actionFeatures, cardActions);
        if (chosen) { console.log('distribute: NN chose target', { cardId: chosen.cardId }); return chosen; }
      }
      const pick = cardActions[Math.floor(Math.random() * cardActions.length)];
      console.log('distribute: random target', { cardId: pick.cardId });
      return pick;
    }
    if (perCardActions.length > 0) {
      const model = await loadModel();
      if (model && perCardActions.length > 1) {
        const stateTensor = encodeGameState(state);
        const actionFeatures = encodeActions(perCardActions);
        const chosen = selectBestAction(model, stateTensor, actionFeatures, perCardActions);
        if (chosen) { console.log('distribute: NN chose per-card action', { arg: chosen.arg, cardId: chosen.cardId }); return chosen; }
      }
      const pick = perCardActions[Math.floor(Math.random() * perCardActions.length)];
      console.log('distribute: random per-card action', { arg: pick.arg, cardId: pick.cardId });
      return pick;
    }
    if (doneBtn) {
      console.log('distribute: confirming damage assignment');
      return doneBtn;
    }
  }

  // Disclose prompts: click cards until requirement is met, then confirm
  const chooseNothingBtn = actions.find(a => matchesMulliganAction(a, 'choosenothing') || matchesMulliganAction(a, 'choose nothing'));
  const cancelBtn = actions.find(a => matchesMulliganAction(a, 'cancel'));
  if (chooseNothingBtn || cancelBtn) {
    const selectableCards = actions.filter(a => a.type === 'cardClicked');
    if (selectableCards.length > 0) {
      const pick = selectableCards[Math.floor(Math.random() * selectableCards.length)];
      console.log('disclose: selecting card to meet aspect requirement', { cardId: pick.cardId });
      return pick;
    }
    if (chooseNothingBtn) {
      console.log('disclose: no more cards to select, clicking choose nothing');
      return chooseNothingBtn;
    }
  }

  // Mulligan handled by model (hand card IDs are encoded in game state)

  // Initiative
  if (state?.players) {
    const playerIds = Object.keys(state.players);
    const activeId = playerIds.find(id => {
      const ps = state.players[id]?.promptState;
      return ps && ps.promptType !== undefined && ps.promptType !== null && ps.promptType !== '' && ps.promptType !== false;
    });
    if (activeId) {
      const player = state.players[activeId];
      if (player?.promptState?.promptType === 'initiative') {
        const menuBtns = actions.filter(a => a.type === 'menuButton');

        // Dedra Meero + Colossus: always pass initiative
        if (state.players[activeId]) {
          const leaderName = getCardName(state.players[activeId].leader);
          const baseName = getCardName(state.players[activeId].base);
          if (leaderName && leaderName.includes('Dedra Meero') && baseName && baseName.includes('Colossus')) {
            const goSecond = menuBtns.find(a => matchesMulliganAction(a, 'pass') || String(a.arg ?? '').includes('pass'));
            if (goSecond) { console.log('initiative: Dedra+Colossus, giving opponent first', { arg: goSecond.arg, text: goSecond.text }); return goSecond; }
          }
        }

        // Default: always pick "Take Initiative" (go first)
        const goFirst = menuBtns.find(a => matchesMulliganAction(a, 'take') || matchesMulliganAction(a, 'claim') || String(a.arg ?? '') === 'claimInitiative');
        if (goFirst) { console.log('initiative: going first', { arg: goFirst.arg, text: goFirst.text }); return goFirst; }
        if (menuBtns.length > 0) { console.log('initiative: picking first button', { arg: menuBtns[0].arg }); return menuBtns[0]; }
      }
    }
  }

  return null;
}

function getAvailableActions(gameState) {
  const actions = [];
  if (gameState && gameState.players) {
    // Scan all players for prompt buttons
    for (const playerId of Object.keys(gameState.players)) {
      const player = gameState.players[playerId];
      const prompt = player?.promptState;
      if (prompt && prompt.buttons && prompt.buttons.length > 0) {
        for (let bi = 0; bi < prompt.buttons.length; bi++) {
          const btn = prompt.buttons[bi];
          const btnText = btn.text || btn.label || btn.name || btn.title || btn.description || btn.value || btn.content || btn.arg || btn.command || `Option ${bi + 1}`;
          actions.push({ type: 'menuButton', arg: btn.arg ?? btn.value ?? btn.id ?? '', uuid: btn.uuid ?? prompt.promptUuid ?? '', command: btn.command || '', text: btnText });
        }
        break;
      }
    }
    // Also extract dropdown list options (choose from list prompt)
    for (const playerId of Object.keys(gameState.players)) {
      const player = gameState.players[playerId];
      const prompt = player?.promptState;
      if (prompt && prompt.dropdownListOptions && Array.isArray(prompt.dropdownListOptions) && prompt.dropdownListOptions.length > 0) {
        for (const opt of prompt.dropdownListOptions) {
          const optText = typeof opt === 'string' ? opt : (opt.text || opt.label || opt.name || opt.title || String(opt));
          const optVal = typeof opt === 'string' ? opt : (opt.arg || opt.value || opt.id || optText);
          actions.push({ type: 'menuButton', arg: optVal, uuid: prompt.promptUuid ?? '', command: '', text: optText });
        }
        break;
      }
    }
    // Also extract perCardButtons paired with displayCards
    for (const playerId of Object.keys(gameState.players)) {
      const player = gameState.players[playerId];
      const prompt = player?.promptState;
      if (prompt && prompt.displayCards && prompt.displayCards.length > 0 && prompt.perCardButtons && prompt.perCardButtons.length > 0) {
        for (const card of prompt.displayCards) {
          const cardId = card.uuid || card.id;
          if (!cardId) continue;
          for (const btn of prompt.perCardButtons) {
            const btnText = btn.text || btn.label || btn.name || btn.title || btn.arg || btn.command || 'Action';
            actions.push({ type: 'menuButton', arg: btn.arg ?? btn.value ?? btn.id ?? cardId, uuid: btn.uuid ?? prompt.promptUuid ?? '', command: btn.command || '', text: btnText, cardId: cardId });
          }
        }
        break;
      }
    }
  }
  for (const cardId of getSelectableCardIds(gameState)) {
    actions.push({ type: 'cardClicked', cardId });
  }
  return actions;
}

function getActivePlayerId(gameState) {
  if (!gameState?.players) return null;
  const pids = Object.keys(gameState.players);
  for (const id of pids) {
    const ps = gameState.players[id].promptState;
    if (ps && ps.promptType != null && ps.promptType !== '' && ps.promptType !== false) return id;
  }
  for (const id of pids) {
    const ps = gameState.players[id].promptState;
    if (ps && ps.selectCardMode && ps.selectCardMode !== 'none') return id;
  }
  for (const id of pids) {
    const ps = gameState.players[id].promptState;
    if (ps && ps.buttons && ps.buttons.length > 0) return id;
  }
  return null;
}

function getMyPlayerState(gameState) {
  if (!gameState || !gameState.players) { console.log('getMyPlayerState: no gameState/players'); return null; }
  const playerIds = Object.keys(gameState.players);
  let foundId = null;
  // When autoPlay is on for self-play, check ANY player with a prompt (not just botPlayerId)
  if (autoPlay) {
    for (const id of playerIds) {
      const ps = gameState.players[id].promptState;
      if (ps && ps.promptType !== undefined && ps.promptType !== null && ps.promptType !== '' && ps.promptType !== false) {
        foundId = id; break;
      }
    }
    if (!foundId) {
      for (const id of playerIds) {
        const ps = gameState.players[id].promptState;
        if (ps && ps.selectCardMode && ps.selectCardMode !== 'none') { foundId = id; break; }
      }
    }
    if (!foundId) {
      for (const id of playerIds) {
        const ps = gameState.players[id].promptState;
        if (ps && ps.buttons && ps.buttons.length > 0) { foundId = id; break; }
      }
    }
    if (foundId) {
      if (!botPlayerId) botPlayerId = foundId;
      currentPlayerId = foundId;
      console.log('getMyPlayerState: found active player', foundId);
      return gameState.players[foundId];
    }
    console.log('getMyPlayerState: no player found, playerIds:', playerIds, 'states:', playerIds.map(id => ({ id, promptState: gameState.players[id]?.promptState ? Object.keys(gameState.players[id].promptState) : 'no prompt' })));
    return null;
  }
  // Single-player mode: only check the detected bot player
  if (botPlayerId) {
    if (playerIds.includes(botPlayerId)) {
      const ps = gameState.players[botPlayerId].promptState;
      if (ps && ps.promptType !== undefined && ps.promptType !== null && ps.promptType !== '' && ps.promptType !== false) {
        currentPlayerId = botPlayerId;
        console.log('getMyPlayerState: found bot player via promptType', botPlayerId, ps.promptType);
        return gameState.players[botPlayerId];
      }
    }
    console.log('getMyPlayerState: bot player', botPlayerId, 'has no prompt, skipping');
    return null;
  }
  for (const id of playerIds) {
    const ps = gameState.players[id].promptState;
    if (ps && ps.promptType !== undefined && ps.promptType !== null && ps.promptType !== '' && ps.promptType !== false) {
      currentPlayerId = id;
      console.log('getMyPlayerState: found via promptType', id, ps.promptType);
      return gameState.players[id];
    }
  }
  for (const id of playerIds) {
    const ps = gameState.players[id].promptState;
    if (ps && ps.selectCardMode && ps.selectCardMode !== 'none') {
      currentPlayerId = id;
      console.log('getMyPlayerState: found via selectCardMode', id, ps.selectCardMode);
      return gameState.players[id];
    }
  }
  for (const id of playerIds) {
    const ps = gameState.players[id].promptState;
    if (ps && ps.buttons && ps.buttons.length > 0) {
      currentPlayerId = id;
      console.log('getMyPlayerState: found via buttons', id, 'buttonCount:', ps.buttons.length);
      return gameState.players[id];
    }
  }
  console.log('getMyPlayerState: no player found, playerIds:', playerIds, 'states:', playerIds.map(id => ({ id, promptState: gameState.players[id]?.promptState ? Object.keys(gameState.players[id].promptState) : 'no prompt' })));
  return null;
}

function isResourcePhase(player, actions) {
  if (!player) { console.log('isResourcePhase: no player'); return false; }
  const prompt = player.promptState || {};
  if (prompt.promptType === 'resource') {
    console.log('isResourcePhase: via promptType', { result: true });
    return true;
  }
  if (prompt.selectCardMode && prompt.selectCardMode !== 'none') {
    if (prompt.selectCardMode.includes('resource')) {
      console.log('isResourcePhase: via selectCardMode', { selectCardMode: prompt.selectCardMode, result: true });
      return true;
    }
    // Non-resource select modes (disclose, target, etc.) are not resource phase
    console.log('isResourcePhase: non-resource selectCardMode', { selectCardMode: prompt.selectCardMode, result: false });
    return false;
  }
  const hand = player.cardPiles?.hand || [];
  const hasSelectableHand = hand.some(c => c.selectable);
  const btnTexts = actions.filter(a => a.type === 'menuButton').map(a => ({ text: a.text, arg: a.arg }));
  const hasResourceBtn = actions.some(a =>
    a.type === 'menuButton' && (
      a.arg === 'done' ||
      (a.text && String(a.text).toLowerCase().includes('resource')) ||
      (String(a.arg ?? '').toLowerCase().includes('resource'))
    )
  );
  console.log('isResourcePhase: fallback', { hasSelectableHand, hasResourceBtn, handLen: hand.length, selectableInHand: hand.filter(c => c.selectable).length, btnTexts, selectCardMode: prompt.selectCardMode });
  return hasSelectableHand && hasResourceBtn;
}

function getSelectableCardIds(gameState) {
  const seen = new Set();
  const ids = [];
  if (!gameState || !gameState.players) return ids;
  for (const playerId of Object.keys(gameState.players)) {
    const player = gameState.players[playerId];
    if (!player) continue;
    const piles = player.cardPiles || {};
    for (const pileKey of ['hand', 'groundArena', 'spaceArena', 'resources', 'discard', 'leader']) {
      const pile = piles[pileKey];
      if (Array.isArray(pile)) {
        for (const card of pile) {
          const id = card.uuid || card.id;
          if (id && card.selectable && !card.selected && !seen.has(id)) { seen.add(id); ids.push(id); }
        }
      } else if (pile) {
        const id = pile.uuid || pile.id;
        if (id && pile.selectable && !pile.selected && !seen.has(id)) { seen.add(id); ids.push(id); }
      }
    }
    // Check player-level leader and base (may not be inside cardPiles)
    const leader = player.leader;
    if (leader) {
      const lid = leader.uuid || leader.id;
      if (lid && leader.selectable && !leader.selected && !seen.has(lid)) { seen.add(lid); ids.push(lid); }
    }
    const base = player.base;
    if (base) {
      const bid = base.uuid || base.id;
      if (bid && base.selectable && !base.selected && !seen.has(bid)) { seen.add(bid); ids.push(bid); }
    }
    // Check promptState displayCards for selectable cards
    const prompt = player.promptState;
    if (prompt && prompt.displayCards && prompt.displayCards.length > 0) {
      for (const card of prompt.displayCards) {
        const cid = card.cardUuid || card.uuid || card.id;
        if (cid && card.selectable && !card.selected && !seen.has(cid)) { seen.add(cid); ids.push(cid); }
      }
    }
  }
  return ids;
}

async function startTraining() {
  try {
    await saveModelWeights(null);
    clearCachedModel();
    await markAllGamesUntrained();
    await clearTrainingStats();

    const recordings = await getGameRecordings({ limit: 200 });
    if (recordings.length === 0) { console.log('No games to train on'); return; }

    const model = await loadModel();
    if (!model) return;

    console.log(`Training on ${recordings.length} games with ranking loss...`);
    const history = await trainModelRanking(model, recordings);
    await saveModelToDB(model);

    const finalPrefAcc = history.history.pref_acc[history.history.pref_acc.length - 1];
    const stats = await getTrainingStats();
    await updateTrainingStats({
      gamesTrained: (stats?.gamesTrained || 0) + recordings.length,
      lastTrainedAt: Date.now(),
      accuracy: finalPrefAcc,
      examples: recordings.reduce((s, g) => s + g.states.length, 0)
    });
    await markGamesTrained(recordings.map((g) => g.gameId));

    // Sync to local server
    syncToServer('api/weights', model.save()).catch(() => {});
    const updatedStats = await getTrainingStats();
    if (updatedStats) syncToServer('api/stats', updatedStats).catch(() => {});

    console.log(`Trained on ${recordings.length} games, final pref_acc=${(finalPrefAcc * 100).toFixed(2)}%`);
  } catch (e) {
    console.error('Training failed:', e);
  }
}

async function trainOnGame(recording) {
  try {
    const model = await loadModel();
    if (!model) { console.log('trainOnGame: no model loaded'); return; }

    const history = await trainModelRanking(model, [recording], { epochs: 3 });
    await saveModelToDB(model);

    const finalPrefAcc = history.history.pref_acc[history.history.pref_acc.length - 1];
    const stats = await getTrainingStats();
    await updateTrainingStats({
      gamesTrained: (stats?.gamesTrained || 0) + 1,
      lastTrainedAt: Date.now(),
      accuracy: finalPrefAcc,
      examples: (stats?.examples || 0) + recording.states.length
    });

    recording.trained = true;
    await saveGameRecording(recording);
    syncToServer('api/games', recording).catch(() => {});

    // Sync model + stats to local server
    syncToServer('api/weights', model.save()).catch(() => {});
    const updatedStats = await getTrainingStats();
    if (updatedStats) syncToServer('api/stats', updatedStats).catch(() => {});

    console.log(`trainOnGame: 1 game, pref_acc=${(finalPrefAcc * 100).toFixed(2)}%`);
  } catch (e) {
    console.error('trainOnGame failed:', e);
  }
}

async function syncAllToServer() {
  try {
    const games = await getGameRecordings();
    for (const game of games) {
      syncToServer('api/games', game).catch(() => {});
    }
    const model = await loadModel();
    if (model) syncToServer('api/weights', model.save()).catch(() => {});
    const stats = await getTrainingStats();
    if (stats) syncToServer('api/stats', stats).catch(() => {});
    console.log('syncAllToServer: synced', games.length, 'games');
  } catch (e) {
    console.error('syncAllToServer failed:', e);
  }
}


