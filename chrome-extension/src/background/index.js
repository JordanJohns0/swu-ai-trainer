importScripts('storage.js');
importScripts('model.js');

let currentGameRecording = null;
let gameCount = 0;
let isAiPlaying = false;
let aiPauseRequested = false;
let pendingRecommendations = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'FROM_PAGE') {
        await handlePageMessage(msg.payload);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'GET_STATUS') {
        const recordings = await getGameRecordingCount();
        const stats = await getTrainingStats();
        const enabled = await getSetting('recordingEnabled', true);
        sendResponse({ recordings, stats, enabled, isAiPlaying, gameCount, activeGame: !!currentGameRecording });
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
        const idx = msg.index;
        if (pendingRecommendations && idx >= 0 && idx < pendingRecommendations.length) {
          await sendActionToTab(pendingRecommendations[idx]);
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
          if (last) result.buttons = getAvailableActions(last).map(a => ({ type: a.type, arg: a.arg, command: a.command, cardId: a.cardId }));
        }
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

async function handlePageMessage(payload) {
  const { type, data, event, args } = payload;

  if (type === 'LOBBYSTATE' && data) {
    if (data.gameOngoing && !currentGameRecording) startNewRecording(data);
  }

  if (type === 'GAMESTATE' && data) {
    if (!currentGameRecording) startNewRecording(data);
    if (currentGameRecording) {
      currentGameRecording.states.push({ state: data, timestamp: Date.now() });
      if (data.winners && data.winners.length > 0) await finalizeRecording(data.winners, data);
    }
    if (isAiPlaying && !aiPauseRequested && currentGameRecording) {
      await sendRecommendations(currentGameRecording);
    }
  }

  if (type === 'OUTGOING' && currentGameRecording) {
    currentGameRecording.actions.push({
      event, args,
      stateIndex: currentGameRecording.states.length - 1,
      timestamp: Date.now()
    });
  }
}

let lastFinalizedGameId = null;

function startNewRecording(data) {
  if (data?.id && data.id === lastFinalizedGameId) return;
  gameCount++;
  currentGameRecording = {
    gameId: `game_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    gameNumber: gameCount,
    states: [],
    actions: [],
    winner: null,
    trained: false,
    initialState: data || null
  };
}

async function finalizeRecording(winners, data) {
  if (!currentGameRecording) return;
  currentGameRecording.winner = winners;
  currentGameRecording.completedAt = Date.now();
  await saveGameRecording(currentGameRecording);
  if (data?.id) lastFinalizedGameId = data.id;
  currentGameRecording = null;
}

async function sendActionToTab(action) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'INJECT_AND_EXECUTE', action }).catch(() => {});
}

async function selectAiAction(recording) {
  try {
    const latestState = recording.states[recording.states.length - 1]?.state;
    if (!latestState) return null;

    const seqAction = trySequences(latestState);
    if (seqAction) return seqAction;

    const resourceAction = await cardToResource(latestState);
    if (resourceAction) return resourceAction;

    const actions = getAvailableActions(latestState);
    if (actions.length === 0) return null;

    const model = await loadModel();
    if (!model) return null;

    const stateTensor = encodeGameState(latestState);
    const actionFeatures = encodeActions(actions);
    const chosen = selectBestAction(model, stateTensor, actionFeatures, actions);
    if (chosen && chosen.type === 'menuButton' && (chosen.arg === 'pass' || chosen.command === 'pass')) {
      const alternatives = actions.filter(a => {
        if (a.type !== 'menuButton') return true;
        return a.arg !== 'pass' && a.command !== 'pass';
      });
      if (alternatives.length > 0) {
        const claimBtn = alternatives.find(a => a.type === 'menuButton' && ((a.arg && a.arg.toLowerCase().includes('claim')) || (a.command && a.command.toLowerCase().includes('claim'))));
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

function describeAction(a) {
  if (a.type === 'cardClicked') return 'Select card';
  return a.text || a.arg || a.command || 'Action';
}

async function sendRecommendations(recording) {
  try {
    const latestState = recording.states[recording.states.length - 1]?.state;
    if (!latestState) return;

    const seqAction = trySequences(latestState);
    if (seqAction) { await sendActionToTab(seqAction); return; }

    const resourceAction = await cardToResource(latestState);
    if (resourceAction) { await sendActionToTab(resourceAction); return; }

    const actions = getAvailableActions(latestState);
    if (actions.length === 0) return;

    const model = await loadModel();
    if (!model) return;

    const stateTensor = encodeGameState(latestState);
    const actionFeatures = encodeActions(actions);
    const top = selectTopActions(model, stateTensor, actionFeatures, actions, 3);
    if (top.length === 0) return;

    if (top[0].action.type === 'menuButton' && (top[0].action.arg === 'pass' || top[0].action.command === 'pass')) {
      const alternates = actions.filter(a => {
        if (a.type !== 'menuButton') return true;
        return a.arg !== 'pass' && a.command !== 'pass';
      });
      if (alternates.length > 0) {
        const af = encodeActions(alternates);
        const altTop = selectTopActions(model, stateTensor, af, alternates, 3);
        if (altTop.length > 0) {
          pendingRecommendations = altTop.map(t => t.action);
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'SHOW_RECOMMENDATIONS', recommendations: altTop.map(t => ({ description: describeAction(t.action), score: t.score })) }).catch(() => {});
          return;
        }
      }
    }

    pendingRecommendations = top.map(t => t.action);
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'SHOW_RECOMMENDATIONS', recommendations: top.map(t => ({ description: describeAction(t.action), score: t.score })) }).catch(() => {});
  } catch (e) {
    console.error('sendRecommendations failed:', e);
  }
}

async function cardToResource(state) {
  const player = getMyPlayerState(state);
  if (!player) return null;
  const prompt = player.promptState || {};
  if (!prompt.selectCardMode || prompt.selectCardMode === 'none') return null;

  const used = (player?.cardPiles?.resources || []).length;
  const leaderCost = player?.leader?.cost ?? player?.cardPiles?.leader?.[0]?.cost ?? 6;
  if (used >= Math.max(leaderCost, 2)) return null;

  const hand = player?.cardPiles?.hand || [];
  const selectable = hand.filter(c => c.selectable);
  const selected = hand.filter(c => c.selected);

  if (selectable.length === 0 && selected.length > 0) {
    const actions = getAvailableActions(state);
    const btn = actions.find(a => a.type === 'menuButton');
    if (btn) return btn;
    return null;
  }

  if (selected.length > 0) {
    const actions = getAvailableActions(state);
    const anyBtn = actions.find(a => a.type === 'menuButton');
    if (anyBtn || selectable.length === 0) return anyBtn;
  }

  if (selectable.length > 0) {
    const unselected = selectable.filter(c => !c.selected);
    if (unselected.length === 0) {
      const actions = getAvailableActions(state);
      const btn = actions.find(a => a.type === 'menuButton');
      if (btn) return btn;
      return null;
    }
    const model = await loadModel();
    const target = unselected;
    const cardActions = target.map(c => ({ type: 'cardClicked', cardId: c.uuid || c.id }));
    if (model && cardActions.length > 1) {
      const stateTensor = encodeGameState(state);
      const actionFeatures = encodeActions(cardActions);
      return selectBestAction(model, stateTensor, actionFeatures, cardActions);
    }
    return cardActions[0];
  }

  return null;
}

function trySequences(state) {
  const actions = getAvailableActions(state);
  if (actions.length === 0) return null;

  const keepBtn = actions.find(a => a.arg && a.arg.toLowerCase().includes('keep'));
  const mulliganBtn = actions.find(a => a.arg && a.arg.toLowerCase().includes('mulligan'));
  if (keepBtn && mulliganBtn) {
    const player = getMyPlayerState(state);
    const hand = player?.cardPiles?.hand || [];
    const costs = hand.map(c => c.cost).filter(c => c != null);
    return costs.includes(2) && costs.includes(3) ? keepBtn : mulliganBtn;
  }

  const menuActions = actions.filter(a => a.type === 'menuButton');
  if (menuActions.length > 0 && (state.roundNumber || 0) <= 1 && !keepBtn && !mulliganBtn) {
    const selfBtn = menuActions.find(a => (a.arg && (a.arg === 'self' || a.arg.toLowerCase().includes('me'))) || (a.command && a.command.toLowerCase().includes('self')));
    return selfBtn || menuActions[0];
  }

  return null;
}

function getAvailableActions(gameState) {
  const actions = [];
  const playerState = getMyPlayerState(gameState);
  if (!playerState) return actions;
  const prompt = playerState.promptState || {};
  if (prompt.buttons) {
    for (const btn of prompt.buttons) {
      actions.push({ type: 'menuButton', arg: btn.arg, uuid: prompt.promptUuid || '', command: btn.command || '', text: btn.text || btn.arg });
    }
  }
  if (prompt.selectCardMode && prompt.selectCardMode !== 'none') {
    for (const cardId of getSelectableCardIds(gameState)) {
      actions.push({ type: 'cardClicked', cardId });
    }
  }
  return actions;
}

function getMyPlayerState(gameState) {
  if (!gameState || !gameState.players) return null;
  const playerIds = Object.keys(gameState.players);
  for (const id of playerIds) {
    const ps = gameState.players[id].promptState;
    if (ps && ps.promptType !== undefined && ps.promptType !== null && ps.promptType !== '' && ps.promptType !== false && ps.promptType !== 0) {
      return gameState.players[id];
    }
  }
  return null;
}

function getSelectableCardIds(gameState) {
  const ids = [];
  const player = getMyPlayerState(gameState);
  if (!player) return ids;
  const piles = player.cardPiles || {};
  for (const pileKey of ['hand', 'groundArena', 'spaceArena', 'resources', 'discard']) {
    const pile = piles[pileKey];
    if (pile) {
      for (const card of pile) {
        if (card.selectable) ids.push(card.uuid || card.id);
      }
    }
  }
  return ids;
}

async function startTraining() {
  try {
    const recordings = await getGameRecordings({ untrainedOnly: true, limit: 200 });
    if (recordings.length === 0) { console.log('No untrained games'); return; }

    const model = await loadModel();
    if (!model) return;

    const stateBuffer = [];
    const actionBuffer = [];
    const labelBuffer = [];

    for (const game of recordings) {
      const labels = buildTrainingLabels(game);
      for (let i = 0; i < game.states.length - 1; i++) {
        const stateObj = game.states[i]?.state;
        if (!stateObj || !stateObj.players) continue;
        const gameActions = game.actions.filter((a) => a.stateIndex === i);
        if (gameActions.length === 0) continue;
        const stateTensor = encodeGameState(stateObj);
        const actionTensors = encodeActions(gameActions);
        for (let j = 0; j < gameActions.length; j++) {
          stateBuffer.push(Array.from(stateTensor));
          actionBuffer.push(Array.from(actionTensors[j]));
          labelBuffer.push(labels[i]?.[j] ?? 0.5);
        }
      }
    }

    if (stateBuffer.length === 0) { console.log('No training examples'); return; }

    const history = await trainModel(model, stateBuffer, actionBuffer, labelBuffer, 5);
    await saveModelToDB(model);

    const finalLoss = history.history.loss[history.history.loss.length - 1];
    const finalAcc = history.history.acc[history.history.acc.length - 1];
    const stats = await getTrainingStats();
    await updateTrainingStats({
      gamesTrained: (stats?.gamesTrained || 0) + recordings.length,
      lastTrainedAt: Date.now(),
      loss: finalLoss,
      accuracy: finalAcc,
      examples: stateBuffer.length
    });
    await markGamesTrained(recordings.map((g) => g.gameId));
    console.log(`Trained: ${stateBuffer.length} examples from ${recordings.length} games, acc=${finalAcc.toFixed(4)}`);
  } catch (e) {
    console.error('Training failed:', e);
  }
}

function buildTrainingLabels(game) {
  const labels = {};
  const firstState = game.states.find(s => s?.state?.players && Object.keys(s.state.players).length >= 2);
  const pIds = firstState ? Object.keys(firstState.state.players) : [];
  if (pIds.length < 2) return labels;
  const p1Id = pIds[0], p2Id = pIds[1];
  const p1Won = Array.isArray(game.winner) ? game.winner.includes(p1Id) : game.winner === p1Id;

  let currentPlayerId = p1Id;
  let actionIdx = 0;

  for (let i = 0; i < game.states.length; i++) {
    const state = game.states[i]?.state;
    if (!state || !state.players) continue;

    const activeId = findActivePlayerInState(state);
    if (activeId && activeId !== currentPlayerId) {
      currentPlayerId = activeId;
    }

    const stateActions = game.actions.filter((a) => a.stateIndex === i);
    if (stateActions.length > 0) {
      if (!labels[i]) labels[i] = [];
      const playerWon = (currentPlayerId === p1Id && p1Won) || (currentPlayerId === p2Id && !p1Won);
      for (let j = 0; j < stateActions.length; j++) {
        labels[i][j] = playerWon ? 1.0 : 0.0;
      }
    }
  }
  return labels;
}

function findActivePlayerInState(state) {
  const players = state.players || {};
  for (const [id, p] of Object.entries(players)) {
    const ps = p.promptState;
    if (ps && ps.promptType !== undefined && ps.promptType !== null && ps.promptType !== '' && ps.promptType !== false && ps.promptType !== 0) return id;
  }
  return null;
}
