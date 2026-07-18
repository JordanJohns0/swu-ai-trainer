const { loadModel, getWeightsMtime } = require('./storage');
const { encodeGameState, encodeActions, selectBestAction } = require('./model');

const MENU_BUTTON_ARGS = [
  'pass', 'claimInitiative', 'done', 'mulligan', 'keep',
  'resource', 'play', 'attack', 'cancel', 'yes', 'no',
  'selectDefenders', 'setup', 'action', 'regroup'
];

// All per-bot mutable state lives in a context object created per bot
// instance (see createBotContext / bot.js) rather than as module-level
// globals. In self-play mode two bots run in the same Node process, so
// module-level state here was shared between both bots' concurrent games —
// e.g. bot1 marking a generic action key like "menuButton:done" as failed
// would silently suppress that same action for bot2's unrelated game.
function createBotContext() {
  return {
    failedActionKeys: new Set(),
    currentPlayerId: null,
    // Stateful prompt retry tracking: key = promptUuid, value = retry attempt count
    statefulPromptRetries: {},
    // In-memory model cache, invalidated when weights.json's mtime changes
    // (previously the "cache" variable was declared but never assigned, so
    // every single decision point re-read + re-parsed weights.json from disk
    // and rebuilt a NeuralNet from scratch).
    modelCache: { model: null, mtime: -1 }
  };
}

async function getCachedModel(ctx) {
  if (!ctx) return await loadModel();
  const mtime = await getWeightsMtime();
  if (!ctx.modelCache.model || ctx.modelCache.mtime !== mtime) {
    ctx.modelCache.model = await loadModel();
    ctx.modelCache.mtime = mtime;
  }
  return ctx.modelCache.model;
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

function describeAction(a, gameState, playerId) {
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
    const player = getMyPlayerState(gameState, playerId);
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
  if (a.type === 'menuButton' && a.cardId) {
    if (!gameState) return 'Select card';
    const info = findCardInfo(a.cardId, gameState);
    if (info) return `Select ${info.title || `[${info.pile}]`}`;
  }
  return a.text || a.arg || a.command || 'Action';
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
  const planText = String(planItem.action.text || planItem.action.arg || planItem.description || '').toLowerCase().trim();
  const currentText = String(currentAction.text || currentAction.arg || currentAction.command || '').toLowerCase().trim();
  if (!planText || !currentText) return true;
  return planText === currentText || planText.includes(currentText) || currentText.includes(planText);
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
    const prompt = player.promptState;
    if (prompt && prompt.displayCards && prompt.displayCards.length > 0) {
      for (const card of prompt.displayCards) {
        const cid = card.cardUuid || card.uuid || card.id;
        const mode = prompt.selectCardMode || 'none';
        if (cid && !card.selected && !seen.has(cid)) {
          if (card.selectable || (mode !== 'none')) { seen.add(cid); ids.push(cid); }
        }
      }
    }
  }
  return ids;
}

function getAvailableActions(gameState) {
  const actions = [];
  if (gameState && gameState.players) {
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
    // 5th pass: displayCards with selectCardMode but no perCardButtons
    // Server uses menuCommand (not onCardClicked), so we emit menuButton with card UUID
    for (const playerId of Object.keys(gameState.players)) {
      const player = gameState.players[playerId];
      const prompt = player?.promptState;
      if (prompt && prompt.displayCards && prompt.displayCards.length > 0 &&
          prompt.selectCardMode && prompt.selectCardMode !== 'none' &&
          (!prompt.perCardButtons || prompt.perCardButtons.length === 0)) {
        for (const card of prompt.displayCards) {
          const cardUuid = card.cardUuid || card.uuid;
          if (cardUuid && card.selectionState !== 'selected') {
            actions.push({ type: 'menuButton', arg: cardUuid, uuid: prompt.promptUuid || '', cardId: cardUuid });
          }
        }
        break;
      }
    }
    // 6th pass: Number prompt (e.g. "Choose a number" for damage/health)
    for (const playerId of Object.keys(gameState.players)) {
      const player = gameState.players[playerId];
      const prompt = player?.promptState;
      if (prompt && prompt.promptType === 'number') {
        const min = prompt.selectNumber?.min ?? 0;
        const max = prompt.selectNumber?.max ?? 9;
        const val = Math.floor((max > min ? (max - min) / 2 : 0) + min);
        actions.push({ type: 'menuButton', arg: String(val), uuid: prompt.promptUuid || '', command: '', text: String(val) });
        break;
      }
    }
  }
  // cardClicked crashes displayCards prompts (BaseStep.onCardClicked throws), so skip when any displayCards+selectCardMode is active
  const hasDisplayCardSelect = gameState?.players && Object.values(gameState.players).some(p => {
    const pr = p?.promptState;
    return pr && pr.displayCards && pr.displayCards.length > 0 && pr.selectCardMode && pr.selectCardMode !== 'none';
  });
  if (!hasDisplayCardSelect) {
    for (const cardId of getSelectableCardIds(gameState)) {
      actions.push({ type: 'cardClicked', cardId });
    }
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

function getMyPlayerState(gameState, playerId, ctx) {
  if (!gameState || !gameState.players) return null;
  const playerIds = Object.keys(gameState.players);

  // If playerId provided, check that player first (critical for self-play)
  if (playerId && playerIds.includes(playerId)) {
    const ps = gameState.players[playerId].promptState;
    if (ps && ps.promptType !== undefined && ps.promptType !== null && ps.promptType !== '' && ps.promptType !== false) {
      if (ctx) ctx.currentPlayerId = playerId;
      return gameState.players[playerId];
    }
    if (ps && ps.selectCardMode && ps.selectCardMode !== 'none') {
      if (ctx) ctx.currentPlayerId = playerId;
      return gameState.players[playerId];
    }
    if (ps && ps.buttons && ps.buttons.length > 0) {
      if (ctx) ctx.currentPlayerId = playerId;
      return gameState.players[playerId];
    }
    // No actionable prompt for this player
    return null;
  }

  // Fallback auto-detect (playerId not provided)
  let foundId = null;
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
    if (ctx) ctx.currentPlayerId = foundId;
    return gameState.players[foundId];
  }

  return null;
}

function isResourcePhase(player, actions) {
  if (!player) return false;
  const prompt = player.promptState || {};
  if (prompt.promptType === 'resource') return true;
  if (prompt.selectCardMode && prompt.selectCardMode !== 'none') {
    if (prompt.selectCardMode.includes('resource')) return true;
    return false;
  }
  const hand = player.cardPiles?.hand || [];
  const hasSelectableHand = hand.some(c => c.selectable);
  const hasResourceBtn = actions.some(a =>
    a.type === 'menuButton' && (
      a.arg === 'done' ||
      (a.text && String(a.text).toLowerCase().includes('resource')) ||
      (String(a.arg ?? '').toLowerCase().includes('resource'))
    )
  );
  return hasSelectableHand && hasResourceBtn;
}

async function cardToResource(state, actions, playerId, ctx) {
  const player = getMyPlayerState(state, playerId, ctx);
  if (!player) return null;
  const isRes = isResourcePhase(player, actions);
  if (!isRes) return null;

  const hand = player?.cardPiles?.hand || [];
  const selectable = hand.filter(c => c.selectable);
  const selected = hand.filter(c => c.selected);

  const used = (player?.cardPiles?.resources || []).length;
  const leaderCost = player?.leader?.cost ?? player?.cardPiles?.leader?.[0]?.cost ?? 6;
  const needsTwo = used === 0;
  const enoughSelected = (needsTwo && selected.length >= 2) || (!needsTwo && selected.length >= 1);

  // If enough cards are selected, click 'done' regardless of resource count
  if ((selectable.length === 0 && selected.length > 0) || enoughSelected) {
    const btn = actions.find(a => a.type === 'menuButton');
    return btn || null;
  }

  // Need to select more cards
  if (selectable.length > 0) {
    // Don't resource more if already have enough
    if (used >= Math.max(leaderCost, 2)) return null;
    const unselected = selectable.filter(c => !c.selected);
    if (unselected.length === 0) {
      const btn = actions.find(a => a.type === 'menuButton');
      return btn || null;
    }
    const model = await getCachedModel(ctx);
    const cardActions = unselected.map(c => ({ type: 'cardClicked', cardId: c.uuid || c.id }));
    if (model && cardActions.length > 1) {
      const stateTensor = encodeGameState(state);
      const actionFeatures = encodeActions(cardActions);
      return selectBestAction(model, stateTensor, actionFeatures, cardActions) || cardActions[0];
    }
    return cardActions[0];
  }

  return null;
}

async function trySequences(state, playerId, ctx) {
  let actions = getAvailableActions(state);
  const filtered = actions.filter(a => !ctx.failedActionKeys.has(getActionKey(a)));
  if (filtered.length > 0) actions = filtered;

  if (actions.length === 0) return null;

  // Allow opponent undo
  const allowBtn = actions.find(a => matchesMulliganAction(a, 'allow') || matchesMulliganAction(a, 'approve'));
  const denyBtn = actions.find(a => matchesMulliganAction(a, 'deny') || matchesMulliganAction(a, 'reject'));
  if (allowBtn && denyBtn) return allowBtn;

  // Distribute damage/healing among targets
  const player = getMyPlayerState(state, playerId, ctx);
  if (player?.promptState?.promptType === 'distributeAmongTargets') {
    const promptData = player.promptState.distributeAmongTargets;
    if (promptData) {
      const doneBtn = actions.find(a => a.command === 'statefulPromptResult' || matchesMulliganAction(a, 'done') || matchesMulliganAction(a, 'confirm'));
      const promptUuid = doneBtn?.uuid || player.promptState.promptUuid || '';
      const { type: distributeType, amount, canDistributeLess, canChooseNoTargets, maxTargets } = promptData;

      const selectableIds = getSelectableCardIds(state);

      if (selectableIds.length === 0) {
        if (canChooseNoTargets) return { type: 'statefulPromptResults', distribution: { type: distributeType, valueDistribution: [] }, uuid: promptUuid };
        return doneBtn || null;
      }

      // Score each target via NN
      const cardActions = selectableIds.map(uuid => ({ type: 'cardClicked', cardId: uuid }));
      const model = await getCachedModel(ctx);
      const stateTensor = model ? encodeGameState(state) : null;
      const actionFeatures = model ? encodeActions(cardActions) : null;
      let scored = cardActions.map((a, i) => ({
        uuid: selectableIds[i],
        score: (model && stateTensor && actionFeatures) ? model.forward(stateTensor, actionFeatures[i]) : 0.5
      }));
      scored.sort((a, b) => b.score - a.score);

      // Track retry attempts per prompt to vary distribution strategy
      const retryKey = promptUuid;
      const retryAttempt = ctx.statefulPromptRetries[retryKey] || 0;
      ctx.statefulPromptRetries[retryKey] = retryAttempt + 1;

      const targetCount = maxTargets && maxTargets > 0 ? Math.min(maxTargets, scored.length) : scored.length;
      const topTargets = scored.slice(0, targetCount);
      const totalScore = topTargets.reduce((s, t) => s + Math.max(0.01, t.score), 0);
      let remaining = amount;
      const valueDistribution = [];

      // Vary distribution strategy on retry to unstick the prompt
      const strategy = retryAttempt % 4;

      if (strategy === 2 && topTargets.length > 0) {
        // Single target — put all on highest-scored
        valueDistribution.push({ uuid: topTargets[0].uuid, amount });
      } else if (strategy === 3 && canChooseNoTargets) {
        return { type: 'statefulPromptResults', distribution: { type: distributeType, valueDistribution: [] }, uuid: promptUuid };
      } else {
        // Proportional (strategy 0) or equal split (strategy 1)
        for (let i = 0; i < topTargets.length; i++) {
          let allocated;
          if (i === topTargets.length - 1) {
            allocated = remaining;
          } else {
            if (strategy === 1) {
              allocated = Math.max(0, Math.min(remaining, Math.floor(amount / targetCount)));
            } else {
              const proportion = Math.max(0.01, topTargets[i].score) / totalScore;
              allocated = Math.max(0, Math.min(remaining, Math.round(amount * proportion)));
            }
            if (distributeType === 'distributeIndirectDamage') {
              const cardInfo = findCardInfo(topTargets[i].uuid, state);
              if (cardInfo && cardInfo.hp != null) {
                const remainingHp = cardInfo.hp - (cardInfo.damage ?? 0);
                allocated = Math.min(allocated, remainingHp);
              }
            }
          }
          valueDistribution.push({ uuid: topTargets[i].uuid, amount: allocated });
          remaining -= allocated;
        }
      }

      // Cap last target for indirect damage, rebalance remainder
      if (distributeType === 'distributeIndirectDamage' && valueDistribution.length > 0) {
        const lastEntry = valueDistribution[valueDistribution.length - 1];
        const cardInfo = findCardInfo(lastEntry.uuid, state);
        if (cardInfo && cardInfo.hp != null) {
          const remainingHp = cardInfo.hp - (cardInfo.damage ?? 0);
          lastEntry.amount = Math.min(lastEntry.amount, remainingHp);
        }
        remaining = amount - valueDistribution.reduce((s, d) => s + d.amount, 0);
      }

      // Rebalance remaining amount if targets were capped
      if (remaining > 0) {
        for (let i = 0; i < valueDistribution.length && remaining > 0; i++) {
          let perTargetMax = amount;
          if (distributeType === 'distributeIndirectDamage') {
            const cardInfo = findCardInfo(valueDistribution[i].uuid, state);
            if (cardInfo && cardInfo.hp != null) {
              perTargetMax = cardInfo.hp - (cardInfo.damage ?? 0);
            }
          }
          const headroom = perTargetMax - valueDistribution[i].amount;
          if (headroom > 0) {
            const add = Math.min(remaining, headroom);
            valueDistribution[i].amount += add;
            remaining -= add;
          }
        }
      }

      const filtered = valueDistribution.filter(d => d.amount > 0);
      if (filtered.length === 0 && canChooseNoTargets) {
        return { type: 'statefulPromptResults', distribution: { type: distributeType, valueDistribution: [] }, uuid: promptUuid };
      }

      // If can't distribute full amount, try canDistributeLess or empty
      if (remaining > 0 && filtered.length > 0) {
        if (canDistributeLess) {
          return {
            type: 'statefulPromptResults',
            distribution: { type: distributeType, valueDistribution: filtered },
            uuid: promptUuid
          };
        }
        if (canChooseNoTargets) {
          return { type: 'statefulPromptResults', distribution: { type: distributeType, valueDistribution: [] }, uuid: promptUuid };
        }
        // Last resort: dump remaining on first target
        // For indirect damage, this could exceed remaining HP — log warning
        if (distributeType === 'distributeIndirectDamage') {
          console.log(`distributeIndirectDamage: cannot distribute full ${amount}, ${remaining} remaining after capping`);
        }
        filtered[0].amount += remaining;
      }

      return {
        type: 'statefulPromptResults',
        distribution: { type: distributeType, valueDistribution: filtered.length > 0 ? filtered : [] },
        uuid: promptUuid
      };
    }

    // Fallback: NN target selection
    const cardActions = actions.filter(a => a.type === 'cardClicked');
    if (cardActions.length > 0) {
      const model = await getCachedModel(ctx);
      if (model && cardActions.length > 1) {
        const stateTensor = encodeGameState(state);
        const actionFeatures = encodeActions(cardActions);
        const chosen = selectBestAction(model, stateTensor, actionFeatures, cardActions);
        if (chosen) return chosen;
      }
      return cardActions[Math.floor(Math.random() * cardActions.length)];
    }
  }

  // Disclose prompts: click cards until done
  const chooseNothingBtn = actions.find(a => matchesMulliganAction(a, 'choosenothing') || matchesMulliganAction(a, 'choose nothing'));
  const cancelBtn = actions.find(a => matchesMulliganAction(a, 'cancel'));
  if (chooseNothingBtn || cancelBtn) {
    const selectableCards = actions.filter(a => a.type === 'cardClicked');
    if (selectableCards.length > 0) {
      return selectableCards[Math.floor(Math.random() * selectableCards.length)];
    }
    if (chooseNothingBtn) return chooseNothingBtn;
  }

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
        const goFirst = menuBtns.find(a => matchesMulliganAction(a, 'take') || matchesMulliganAction(a, 'claim') || String(a.arg ?? '') === 'claimInitiative');
        if (goFirst) return goFirst;
        if (menuBtns.length > 0) return menuBtns[0];
      }
    }
  }

  return null;
}

async function selectAiAction(state, isSelfPlay, playerId, ctx) {
  try {
    if (!state) return null;
    if (!ctx) ctx = createBotContext();

    const seqAction = await trySequences(state, playerId, ctx);
    if (seqAction) return seqAction;

    let allActions = getAvailableActions(state);
    let actions = allActions.filter(a => !ctx.failedActionKeys.has(getActionKey(a)));
    if (actions.length !== allActions.length) {
      console.log('selectAiAction: filtered failed actions', { total: allActions.length, afterFilter: actions.length });
    }
    if (actions.length === 0 && allActions.length > 0) {
      ctx.failedActionKeys.clear();
      actions = allActions;
    }
    if (actions.length === 0) {
      const dbg = state?.players ? Object.entries(state.players).map(([id, p]) => ({
        id,
        promptType: p?.promptState?.promptType,
        selectCardMode: p?.promptState?.selectCardMode,
        buttons: p?.promptState?.buttons?.length || 0,
        selectableCards: getSelectableCardIds(state).length
      })) : 'no players';
      console.log('selectAiAction: no actions available', JSON.stringify(dbg));
      return null;
    }

    // Try card-to-resource first
    const resourceAction = await cardToResource(state, actions, playerId, ctx);
    if (resourceAction) {
      console.log('cardToResource picked:', getActionKey(resourceAction));
      return resourceAction;
    }

    // Never choose Cancel or Close if any other option exists
    const nonCancelActions = actions.filter(a => !isCancelAction(a));
    if (nonCancelActions.length > 0) {
      if (nonCancelActions.length !== actions.length) {
        actions = nonCancelActions;
      }
    }

    console.log(`actions: ${actions.length} total [${actions.map(a => getActionKey(a)).join(', ')}]`);

    // Use the model to score actions
    const model = await getCachedModel(ctx);
    if (!model) {
      console.log('NN: no model, picking random');
      return actions[Math.floor(Math.random() * actions.length)];
    }

    const stateTensor = encodeGameState(state);
    const actionFeatures = encodeActions(actions);
    const scores = actionFeatures.map((af) => model.forward(stateTensor, af));
    const bestScore = Math.max(...scores);
    const worstScore = Math.min(...scores);
    console.log(`NN scores: best=${bestScore.toFixed(4)} worst=${worstScore.toFixed(4)} spread=${(bestScore - worstScore).toFixed(4)}`);
    const chosen = selectBestAction(model, stateTensor, actionFeatures, actions);
    if (chosen && isCancelAction(chosen)) {
      const alternatives = actions.filter(a => !isCancelAction(a));
      if (alternatives.length > 0) {
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
    // Safeguard: prefer clicking a card over done when cards are available and not in resource phase
    if (chosen && chosen.type === 'menuButton' && (chosen.arg === 'done' || String(chosen.arg).toLowerCase() === 'done')) {
      const cardActions = actions.filter(a => a.type === 'cardClicked');
      const player = getMyPlayerState(state, playerId, ctx);
      if (cardActions.length > 0 && !isResourcePhase(player, actions)) {
        console.log(`Safeguard: preferring card click over done (${cardActions.length} cards available)`);
        const model = await getCachedModel(ctx);
        if (model && cardActions.length > 1) {
          const stateTensor = encodeGameState(state);
          const actionFeatures = encodeActions(cardActions);
          return selectBestAction(model, stateTensor, actionFeatures, cardActions) || cardActions[0];
        }
        return cardActions[0];
      }
    }
    return chosen;
  } catch (e) {
    console.error('AI selection failed:', e);
    return null;
  }
}

module.exports = {
  createBotContext,
  getActionKey, getActionSetHash, getAvailableActions, getSelectableCardIds,
  getActivePlayerId, getMyPlayerState, isResourcePhase,
  describeAction, matchesMulliganAction, isCancelAction, planTextMatches,
  cardToResource, trySequences, selectAiAction, findCardInfo, getCardName
};
