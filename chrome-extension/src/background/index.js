console.log('SWU AI BG VERSION 4');
importScripts('storage.js');
importScripts('model.js');

let currentGameRecording = null;
let gameCount = 0;
let isAiPlaying = false;
let aiPauseRequested = false;
let autoRequeue = false;
let autoTrain = false;
let autoPlay = false;
let pendingAutoPlay = false;
let minWait = 1000;
let maxWait = 3000;
let pendingRecommendations = null;
let lastUnknownEvent = null;
let lastTabId = null;
let failedActionKeys = new Set();
let lastSentActionKey = null;
let lastSentStateHash = null;

function getActionKey(action) {
  return action.type + ':' + (action.arg ?? action.cardId ?? '');
}

function getActionSetHash(gameState) {
  const actions = getAvailableActions(gameState);
  return actions.map(a => getActionKey(a)).sort().join('|');
}

// Load persistent settings
getSetting('minWait', 1000).then(v => minWait = v).catch(() => {});
getSetting('maxWait', 3000).then(v => maxWait = v).catch(() => {});
getSetting('autoTrain', false).then(v => autoTrain = v).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab?.id) lastTabId = sender.tab.id;
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
        sendResponse({ recordings, stats, enabled, isAiPlaying, autoPlay, autoRequeue, autoTrain, gameCount, activeGame: !!currentGameRecording, minWait, maxWait });
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
      if (msg.type === 'TOGGLE_AUTO_REQUEUE') {
        autoRequeue = msg.enabled;
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

async function handlePageMessage(payload) {
  const { type, data, event, args } = payload;

  const shouldAct = (isAiPlaying || autoPlay) && currentGameRecording;

  if (type === 'LOBBYSTATE' && data) {
    if (data.gameOngoing && !currentGameRecording) startNewRecording(data);
    if (shouldAct) {
      await sendRecommendations(currentGameRecording);
    }
  }

  if (type === 'GAMESTATE' && data) {
    lastUnknownEvent = null;
    if (!currentGameRecording) startNewRecording(data);
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
      currentGameRecording.states.push({ state: data, timestamp: Date.now() });
      if (data.winners && data.winners.length > 0) await finalizeRecording(data.winners, data);
    }
    if (shouldAct) {
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
        if (!currentGameRecording.playerId && eventData?.players) {
          for (const [id, p] of Object.entries(eventData.players)) {
            const ps = p.promptState;
            if (ps && ps.promptType != null && ps.promptType !== '') {
              currentGameRecording.playerId = id;
              break;
            }
          }
        }
        currentGameRecording.states.push({ state: eventData, timestamp: Date.now() });
        if (eventData.winners && eventData.winners.length > 0) await finalizeRecording(eventData.winners, eventData);
      }
      if (shouldAct) {
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

let lastFinalizedGameId = null;

function startNewRecording(data) {
  if (data?.id && data.id === lastFinalizedGameId) return;
  gameCount++;
  currentGameRecording = {
    gameId: `game_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    gameNumber: gameCount,
    playerId: null,
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
  const recording = currentGameRecording;
  await saveGameRecording(recording);
  if (data?.id) lastFinalizedGameId = data.id;
  currentGameRecording = null;
  failedActionKeys.clear();
  lastSentActionKey = null;
  lastSentStateHash = null;

  // Auto-train before requeue
  if (autoTrain) {
    console.log('finalizeRecording: auto-training on game');
    await trainOnGame(recording);
  }

  // Auto-requeue: wait for the "Game ended" DOM to render, then click Requeue
  if (autoRequeue && lastTabId) {
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(lastTabId, { type: 'CLICK_REQUEUE' });
      } catch (e) {
        console.warn('Auto-requeue send failed:', e);
      }
    }, 2000);
  }
}

async function sendActionToTab(action) {
  const tabId = lastTabId;
  if (!tabId) { console.warn('sendActionToTab: no tab ID available'); return; }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'INJECT_AND_EXECUTE', action });
  } catch (e) {
    console.warn('sendActionToTab failed:', e);
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

    const model = await loadModel();
    if (!model) { console.log('selectAiAction: no model loaded'); return null; }

    const stateTensor = encodeGameState(latestState);
    const actionFeatures = encodeActions(actions);
    const chosen = selectBestAction(model, stateTensor, actionFeatures, actions);
    console.log('selectAiAction: model chose', getActionKey(chosen), chosen ? describeAction(chosen, latestState) : '');
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
            return { title: getCardName(card), pile: pileKey, cost: card.cost, power: card.power, hp: card.hp };
          }
        }
      } else if (pile && (pile.uuid || pile.id) === cardId) {
        return { title: getCardName(pile), pile: pileKey, cost: pile.cost, power: pile.power, hp: pile.hp };
      }
    }
    // Check player-level leader and base
    const leader = gameState.players[playerId]?.leader;
    if (leader) {
      const leaderId = leader.uuid || leader.id;
      if (leaderId === cardId) {
        return { title: getCardName(leader), pile: 'leader', cost: leader.cost, power: leader.power, hp: leader.hp };
      }
    }
    const base = gameState.players[playerId]?.base;
    if (base) {
      const baseId = base.uuid || base.id;
      if (baseId === cardId) {
        return { title: getCardName(base), pile: 'base', cost: null, power: null, hp: null };
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
  return a.text || a.arg || a.command || 'Action';
}

async function sendRecommendations(recording) {
  try {
    if (!recording) return;
    const latestState = recording.states[recording.states.length - 1]?.state;
    if (!latestState) return;
    console.log('sendRecommendations called V4', { autoPlay, isAiPlaying, pendingAutoPlay, statesLen: recording.states.length, stateId: latestState.id });

    // Failed action detection: if state hash matches lastSentStateHash, action had no effect
    if (lastSentActionKey && lastSentStateHash) {
      const currentHash = getActionSetHash(latestState);
      if (currentHash === lastSentStateHash) {
        failedActionKeys.add(lastSentActionKey);
        console.log('failedActionKeys added', lastSentActionKey);
      } else {
        failedActionKeys.clear();
      }
      lastSentActionKey = null;
      lastSentStateHash = null;
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
        for (const key of ['buttons', 'options', 'choices', 'actions', 'menuItems', 'selections', 'prompts', 'triggers', 'items', 'entries']) {
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
          for (const key of ['options', 'choices', 'actions']) {
            if (ed[key] && typeof ed[key] === 'object' && !Array.isArray(ed[key])) {
              for (const [optKey, optVal] of Object.entries(ed[key])) {
                const label = typeof optVal === 'string' ? optVal : (optVal.text || optVal.label || optVal.name || optVal.title || optKey);
                actions.push({ type: 'menuButton', arg: optVal.arg ?? optVal.action ?? optVal.value ?? optKey, uuid: optVal.uuid ?? '', command: optVal.command || '', text: label });
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

    // Auto-play: auto-execute the best action without overlay
    if (autoPlay) {
      if (pendingAutoPlay) { console.log('autoPlay: pendingAutoPlay locked, skipping'); return; }
      console.log('autoPlay: starting auto-play cycle');
      pendingAutoPlay = true;
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
          if (lastTabId) {
            chrome.tabs.sendMessage(lastTabId, { type: 'SHOW_COUNTDOWN', description: desc, totalMs: Math.round(delay) }).catch(() => {});
          }
          await new Promise(r => setTimeout(r, delay));
          // Capture state hash right before send, after delay, to avoid false-positive
          // failure detection from GAMESTATE events arriving during the wait.
          lastSentStateHash = getActionSetHash(latestState);
          lastSentActionKey = getActionKey(autoAction);
          await sendActionToTab(autoAction);
        }
      } finally {
        pendingAutoPlay = false;
      }
      return;
    }

    // Mulligan/keep: show both options as recommendations
    const keepBtn = actions.find(a => matchesMulliganAction(a, 'keep'));
    const mulliganBtn = actions.find(a => matchesMulliganAction(a, 'mulligan'));
    if (keepBtn && mulliganBtn) {
      pendingRecommendations = [keepBtn, mulliganBtn];
      if (lastTabId) chrome.tabs.sendMessage(lastTabId, { type: 'SHOW_RECOMMENDATIONS', recommendations: [
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
              if (lastTabId) chrome.tabs.sendMessage(lastTabId, { type: 'SHOW_RECOMMENDATIONS', recommendations: altTop.map(t => ({ description: describeAction(t.action, latestState), score: t.score, action: t.action })) }).catch(() => {});
              return;
            }
          }
        }
        pendingRecommendations = top.map(t => t.action);
        if (lastTabId) chrome.tabs.sendMessage(lastTabId, { type: 'SHOW_RECOMMENDATIONS', recommendations: top.map(t => ({ description: describeAction(t.action, latestState), score: t.score, action: t.action })) }).catch(() => {});
        return;
      }
    }

    // Fallback: show available actions without model scoring
    pendingRecommendations = actions.slice(0, 5);
    if (lastTabId) chrome.tabs.sendMessage(lastTabId, { type: 'SHOW_RECOMMENDATIONS', recommendations: actions.slice(0, 5).map(a => ({ description: describeAction(a, latestState), score: 0.5, action: a })) }).catch(() => {});
  } catch (e) {
    console.error('sendRecommendations failed:', e);
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

  // Distribute damage / assign indirect damage — use NN to pick targets
  const player = getMyPlayerState(state);
  if (player?.promptState?.promptType === 'distributeAmongTargets') {
    const cardActions = actions.filter(a => a.type === 'cardClicked');
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
        const botId = currentGameRecording?.playerId;
        if (botId && state.players[botId]) {
          const leaderName = getCardName(state.players[botId].leader);
          const baseName = getCardName(state.players[botId].base);
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
    // Scan all players for prompt buttons (not just getMyPlayerState, which may miss some states)
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
  }
  for (const cardId of getSelectableCardIds(gameState)) {
    actions.push({ type: 'cardClicked', cardId });
  }
  return actions;
}

function getMyPlayerState(gameState) {
  if (!gameState || !gameState.players) { console.log('getMyPlayerState: no gameState/players'); return null; }
  const playerIds = Object.keys(gameState.players);
  for (const id of playerIds) {
    const ps = gameState.players[id].promptState;
    if (ps && ps.promptType !== undefined && ps.promptType !== null && ps.promptType !== '' && ps.promptType !== false) {
      console.log('getMyPlayerState: found via promptType', id, ps.promptType);
      return gameState.players[id];
    }
  }
  for (const id of playerIds) {
    const ps = gameState.players[id].promptState;
    if (ps && ps.selectCardMode && ps.selectCardMode !== 'none') {
      console.log('getMyPlayerState: found via selectCardMode', id, ps.selectCardMode);
      return gameState.players[id];
    }
  }
  for (const id of playerIds) {
    const ps = gameState.players[id].promptState;
    if (ps && ps.buttons && ps.buttons.length > 0) {
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
    console.log(`trainOnGame: 1 game, pref_acc=${(finalPrefAcc * 100).toFixed(2)}%`);
  } catch (e) {
    console.error('trainOnGame failed:', e);
  }
}


