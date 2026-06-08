importScripts('storage.js');
importScripts('model.js');

let currentGameRecording = null;
let gameCount = 0;
let isAiPlaying = false;
let aiPauseRequested = false;
let pendingRecommendations = null;
let lastUnknownEvent = null;

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

async function handlePageMessage(payload) {
  const { type, data, event, args } = payload;

  if (type === 'LOBBYSTATE' && data) {
    if (data.gameOngoing && !currentGameRecording) startNewRecording(data);
    if (isAiPlaying && !aiPauseRequested && currentGameRecording) {
      await sendRecommendations(currentGameRecording);
    }
  }

  if (type === 'GAMESTATE' && data) {
    lastUnknownEvent = null;
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

  if (type === 'GAME_EVENT') {
    const { name: eventName, data: eventData } = payload;
    if (!eventData) return;
    // If it has players, treat as direct gamestate update
    if (eventData.players) {
      if (!currentGameRecording) startNewRecording(eventData);
      if (currentGameRecording) {
        currentGameRecording.states.push({ state: eventData, timestamp: Date.now() });
        if (eventData.winners && eventData.winners.length > 0) await finalizeRecording(eventData.winners, eventData);
      }
      if (isAiPlaying && !aiPauseRequested && currentGameRecording) {
        await sendRecommendations(currentGameRecording);
      }
      return;
    }
    // Check for popup events that have prompt/button data without full players wrapper
    const actionableButtons = Array.isArray(eventData.buttons) ? eventData.buttons :
                               Array.isArray(eventData.options) ? eventData.options :
                               Array.isArray(eventData.choices) ? eventData.choices :
                               Array.isArray(eventData.actions) ? eventData.actions : null;
    const hasActionableData = eventData.promptType !== undefined || (actionableButtons && actionableButtons.length > 0);
    // Also check for object-type options (key-value pairs like {deploy: "Deploy Sabine Wren", ...})
    const objectOptions = !actionableButtons && typeof eventData.options === 'object' && eventData.options !== null;
    const objectChoices = !actionableButtons && typeof eventData.choices === 'object' && eventData.choices !== null;
    if ((hasActionableData || objectOptions || objectChoices) && currentGameRecording) {
      const lastState = currentGameRecording.states[currentGameRecording.states.length - 1]?.state;
      if (lastState && lastState.players) {
        const activeId = Object.keys(lastState.players).find(id => lastState.players[id]?.promptState?.promptType != null)
                       || Object.keys(lastState.players)[0];
        if (activeId) {
          // Convert object options to button array
          let buttons = actionableButtons || [];
          if (buttons.length === 0 && objectOptions) {
            for (const [k, v] of Object.entries(eventData.options)) {
              const label = typeof v === 'string' ? v : (v?.text || v?.label || v?.name || k);
              buttons.push({ text: label, arg: v?.arg || v?.action || v?.value || k });
            }
          } else if (buttons.length === 0 && objectChoices) {
            for (const [k, v] of Object.entries(eventData.choices)) {
              const label = typeof v === 'string' ? v : (v?.text || v?.label || v?.name || k);
              buttons.push({ text: label, arg: v?.arg || v?.action || v?.value || k });
            }
          }
          const wrapped = JSON.parse(JSON.stringify(lastState));
          wrapped.players[activeId] = wrapped.players[activeId] || {};
          wrapped.players[activeId].promptState = {
            promptType: eventData.promptType ?? 1,
            buttons: buttons,
            selectCardMode: eventData.selectCardMode || ''
          };
          lastUnknownEvent = null;
          currentGameRecording.states.push({ state: wrapped, timestamp: Date.now() });
          if (isAiPlaying && !aiPauseRequested) {
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

function findCardInfo(cardId, gameState) {
  if (!gameState || !gameState.players) return null;
  for (const playerId of Object.keys(gameState.players)) {
    const piles = gameState.players[playerId]?.cardPiles || {};
    for (const pileKey of ['hand', 'groundArena', 'spaceArena', 'resources', 'discard', 'leader']) {
      const pile = piles[pileKey];
      if (Array.isArray(pile)) {
        for (const card of pile) {
          if ((card.uuid || card.id) === cardId) {
            return { title: card.title || null, pile: pileKey, cost: card.cost, power: card.power };
          }
        }
      } else if (pile && (pile.uuid || pile.id) === cardId) {
        return { title: pile.title || null, pile: pileKey, cost: pile.cost, power: pile.power };
      }
    }
    // Check player-level leader and base
    const leader = gameState.players[playerId]?.leader;
    if (leader) {
      const leaderId = leader.uuid || leader.id;
      if (leaderId === cardId) {
        return { title: leader.title || null, pile: 'leader', cost: leader.cost, power: leader.power };
      }
    }
    const base = gameState.players[playerId]?.base;
    if (base) {
      const baseId = base.uuid || base.id;
      if (baseId === cardId) {
        return { title: base.title || null, pile: 'base', cost: null, power: null };
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
    const player = getMyPlayerState(gameState);
    const mode = player?.promptState?.selectCardMode || '';

    if (mode !== '' && mode !== 'none') {
      if (mode.includes('resource')) return `Resource ${name}`;
      if (mode.includes('target') || mode.includes('attack')) return `Target ${name}`;
      if (mode.includes('defend')) return `Defend with ${name}`;
      if (mode.includes('discard')) return `Discard ${name}`;
      return `Select ${name}`;
    }

    if (info.pile === 'hand') return `Play ${name}`;
    if (info.pile === 'groundArena' || info.pile === 'spaceArena') return `Attack with ${name}`;
    if (info.pile === 'leader') return `Use ${name}`;
    if (info.pile === 'base') return `Attack ${name}`;

    return `Select ${name}`;
  }
  return a.text || a.arg || a.command || 'Action';
}

async function sendRecommendations(recording) {
  try {
    const latestState = recording.states[recording.states.length - 1]?.state;
    if (!latestState) return;

    const actions = getAvailableActions(latestState);
    if (actions.length === 0) {
      // Try extracting buttons directly from any player's promptState
      if (latestState?.players) {
        for (const pid of Object.keys(latestState.players)) {
          const p = latestState.players[pid];
          const ps = p?.promptState;
          if (ps?.buttons?.length > 0) {
            for (const btn of ps.buttons) {
              const btnText = btn.text || btn.label || btn.name || btn.title || btn.description || btn.value || btn.content || btn.arg || btn.command || 'Action';
              actions.push({ type: 'menuButton', arg: btn.arg ?? btn.value ?? btn.id ?? '', uuid: ps.promptUuid || '', command: btn.command || '', text: btnText });
            }
            break;
          }
        }
      }
      // Try the last unknown event as fallback
      if (actions.length === 0 && lastUnknownEvent?.data) {
        const ed = lastUnknownEvent.data;
        // Check common array field names for buttons/choices
        for (const key of ['buttons', 'options', 'choices', 'actions', 'menuItems', 'selections', 'prompts', 'triggers', 'items', 'entries']) {
          if (Array.isArray(ed[key]) && ed[key].length > 0) {
            for (const entry of ed[key]) {
              const btnText = entry.text || entry.label || entry.name || entry.title || entry.description || entry.arg || entry.action || entry.value || key;
              actions.push({ type: 'menuButton', arg: entry.arg || entry.action || entry.value || entry.id || key, text: btnText });
            }
            if (actions.length > 0) break;
          }
        }
        // Also check for object-type options (key-value pairs)
        if (actions.length === 0) {
          for (const key of ['options', 'choices', 'actions']) {
            if (ed[key] && typeof ed[key] === 'object' && !Array.isArray(ed[key])) {
              for (const [optKey, optVal] of Object.entries(ed[key])) {
                const label = typeof optVal === 'string' ? optVal : (optVal.text || optVal.label || optVal.name || optVal.title || optKey);
                actions.push({ type: 'menuButton', arg: optVal.arg || optVal.action || optVal.value || optKey, text: label });
              }
              if (actions.length > 0) break;
            }
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

    // Auto-confirm resourcing
    const player = getMyPlayerState(latestState);
    if (player) {
      const prompt = player.promptState || {};
      if (prompt.selectCardMode && prompt.selectCardMode !== 'none') {
        const hand = player.cardPiles?.hand || [];
        const selected = hand.filter(c => c.selected);
        if (selected.length > 0) {
          const used = (player?.cardPiles?.resources || []).length;
          const remaining = hand.filter(c => c.selectable && !c.selected);
          const needsTwo = used === 0;
          if ((needsTwo && selected.length >= 2) || (!needsTwo && selected.length >= 1) || remaining.length === 0) {
            const confirmBtn = actions.find(a => a.type === 'menuButton');
            if (confirmBtn) {
              await sendActionToTab(confirmBtn);
              return;
            }
          }
        }
      }
    }

    // Auto-select if exactly one card-click action during selection mode
    if (player) {
      const prompt = player.promptState || {};
      if (prompt.selectCardMode && prompt.selectCardMode !== 'none') {
        const cardActions = actions.filter(a => a.type === 'cardClicked');
        if (cardActions.length === 1) {
          await sendActionToTab(cardActions[0]);
          return;
        }
      }
    }

    // Mulligan/keep: show both options as recommendations
    const keepBtn = actions.find(a => matchesMulliganAction(a, 'keep'));
    const mulliganBtn = actions.find(a => matchesMulliganAction(a, 'mulligan'));
    if (keepBtn && mulliganBtn) {
      pendingRecommendations = [keepBtn, mulliganBtn];
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'SHOW_RECOMMENDATIONS', recommendations: [
        { description: describeAction(keepBtn, latestState), score: 0.55 },
        { description: describeAction(mulliganBtn, latestState), score: 0.45 }
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
              const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
              if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'SHOW_RECOMMENDATIONS', recommendations: altTop.map(t => ({ description: describeAction(t.action, latestState), score: t.score })) }).catch(() => {});
              return;
            }
          }
        }
        pendingRecommendations = top.map(t => t.action);
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'SHOW_RECOMMENDATIONS', recommendations: top.map(t => ({ description: describeAction(t.action, latestState), score: t.score })) }).catch(() => {});
        return;
      }
    }

    // Fallback: show available actions without model scoring
    pendingRecommendations = actions.slice(0, 5);
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'SHOW_RECOMMENDATIONS', recommendations: actions.slice(0, 5).map(a => ({ description: describeAction(a, latestState), score: 0.5 })) }).catch(() => {});
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

function matchesMulliganAction(a, keyword) {
  return (a.arg && a.arg.toLowerCase().includes(keyword)) ||
         (a.command && a.command.toLowerCase().includes(keyword)) ||
         (a.text && a.text.toLowerCase().includes(keyword));
}

function trySequences(state) {
  const actions = getAvailableActions(state);
  if (actions.length === 0) return null;

  const keepBtn = actions.find(a => matchesMulliganAction(a, 'keep'));
  const mulliganBtn = actions.find(a => matchesMulliganAction(a, 'mulligan'));
  if (keepBtn && mulliganBtn) {
    const player = getMyPlayerState(state);
    const hand = player?.cardPiles?.hand || [];
    const costs = hand.map(c => c.cost).filter(c => c != null);
    return costs.includes(2) && costs.includes(3) ? keepBtn : mulliganBtn;
  }

  return null;
}

function getAvailableActions(gameState) {
  const actions = [];
  if (gameState && gameState.players) {
    // Scan all players for prompt buttons (not just getMyPlayerState, which may miss some states)
    for (const playerId of Object.keys(gameState.players)) {
      const player = gameState.players[playerId];
      const prompt = player?.promptState;
      if (prompt && prompt.buttons && prompt.buttons.length > 0) {
        for (const btn of prompt.buttons) {
          const btnText = btn.text || btn.label || btn.name || btn.title || btn.description || btn.value || btn.content || btn.arg || btn.command || 'Action';
          actions.push({ type: 'menuButton', arg: btn.arg ?? btn.value ?? btn.id ?? '', uuid: prompt.promptUuid || '', command: btn.command || '', text: btnText });
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

function getMyPlayerState(gameState) {
  if (!gameState || !gameState.players) return null;
  const playerIds = Object.keys(gameState.players);
  for (const id of playerIds) {
    const ps = gameState.players[id].promptState;
    if (ps && ps.promptType !== undefined && ps.promptType !== null && ps.promptType !== '' && ps.promptType !== false) {
      return gameState.players[id];
    }
  }
  return null;
}

function getSelectableCardIds(gameState) {
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
          if (card.selectable && !card.selected) ids.push(card.uuid || card.id);
        }
      } else if (pile && pile.selectable && !pile.selected) {
        ids.push(pile.uuid || pile.id);
      }
    }
    // Check player-level leader and base (may not be inside cardPiles)
    const leader = player.leader;
    if (leader && leader.selectable && !leader.selected) {
      const lid = leader.uuid || leader.id;
      if (lid) ids.push(lid);
    }
    const base = player.base;
    if (base && base.selectable && !base.selected) {
      const bid = base.uuid || base.id;
      if (bid) ids.push(bid);
    }
  }
  return ids;
}

async function startTraining() {
  try {
    // Reset old model and training flags to retrain from scratch with corrected labels
    await saveModelWeights(null);
    clearCachedModel();
    await markAllGamesUntrained();
    await clearTrainingStats();

    const recordings = await getGameRecordings({ limit: 200 });
    if (recordings.length === 0) { console.log('No games to train on'); return; }

    const model = await loadModel();
    if (!model) return;

    const stateBuffer = [];
    const actionBuffer = [];
    const labelBuffer = [];

    for (const game of recordings) {
      for (let i = 0; i < game.states.length - 1; i++) {
        const stateObj = game.states[i]?.state;
        if (!stateObj || !stateObj.players) continue;
        const takenActions = game.actions.filter((a) => a.stateIndex === i);
        if (takenActions.length === 0) continue;

        const allActions = getAvailableActions(stateObj);
        if (allActions.length === 0) continue;

        const stateTensor = encodeGameState(stateObj);
        const actionTensors = encodeActions(allActions);

        for (let j = 0; j < allActions.length; j++) {
          const wasTaken = takenActions.some(ta => {
            if (ta.args[0] === 'cardClicked' && allActions[j].type === 'cardClicked')
              return ta.args[1] === allActions[j].cardId;
            if (ta.args[0] === 'menuButton' && allActions[j].type === 'menuButton')
              return ta.args[1] === allActions[j].arg;
            return false;
          });
          stateBuffer.push(Array.from(stateTensor));
          actionBuffer.push(Array.from(actionTensors[j]));
          labelBuffer.push(wasTaken ? 1.0 : 0.0);
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


