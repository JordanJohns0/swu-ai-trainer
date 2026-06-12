const MAX_CARDS_IN_ZONE = 5;
const NUM_SCALAR_FEATURES = 45;
const SELECT_CARD_MODES = ['resource', 'target', 'defend', 'discard', 'play', 'attack', 'select'];
const CARD_FEATURE_COUNT = 10 * MAX_CARDS_IN_ZONE * 7;
const STATE_SIZE = NUM_SCALAR_FEATURES + CARD_FEATURE_COUNT;
const ACTION_FEATURE_SIZE = 64;
const ACTION_GAIN = 5;
const PHASES = ['setup', 'action', 'regroup', 'initiative', 'end'];
let cachedModel = null;

function getStateSize() { return STATE_SIZE; }
function getActionFeatureSize() { return ACTION_FEATURE_SIZE; }

function encodeGameState(gameState) {
  if (!gameState || !gameState.players) return new Float64Array(STATE_SIZE);
  const playerIds = Object.keys(gameState.players);
  const myId = findActivePlayerId(gameState);
  const opponentId = playerIds.find((id) => id !== myId) || playerIds[0];
  const me = gameState.players[myId] || {};
  const opp = gameState.players[opponentId] || {};
  const mine = me.cardPiles || {};
  const theirs = opp.cardPiles || {};
  const scalars = encodeScalarFeatures(gameState, me, opp, mine, theirs);
  const cardFeatures = encodeCardFeatures(mine, theirs);
  const out = new Float64Array(STATE_SIZE);
  out.set(scalars, 0);
  out.set(cardFeatures, NUM_SCALAR_FEATURES);
  return out;
}

function encodeGameStateForPlayer(gameState, playerId) {
  if (!gameState || !gameState.players) return new Float64Array(STATE_SIZE);
  const playerIds = Object.keys(gameState.players);
  const myId = playerId;
  const opponentId = playerIds.find((id) => id !== myId) || playerIds[0];
  const me = gameState.players[myId] || {};
  const opp = gameState.players[opponentId] || {};
  const mine = me.cardPiles || {};
  const theirs = opp.cardPiles || {};
  const scalars = encodeScalarFeatures(gameState, me, opp, mine, theirs);
  const cardFeatures = encodeCardFeatures(mine, theirs);
  const out = new Float64Array(STATE_SIZE);
  out.set(scalars, 0);
  out.set(cardFeatures, NUM_SCALAR_FEATURES);
  return out;
}

function findActivePlayerId(gameState) {
  const players = gameState.players || {};
  for (const [id, p] of Object.entries(players)) {
    const ps = p.promptState;
    if (ps && ps.promptType !== undefined && ps.promptType !== null && ps.promptType !== '' && ps.promptType !== false && ps.promptType !== 0) return id;
  }
  return Object.keys(players)[0];
}

function totalPower(cards) {
  return (cards || []).reduce((sum, c) => sum + (c.power || 0), 0);
}

function encodeScalarFeatures(gameState, me, opp, mine, theirs) {
  const f = [];
  f.push(normalize(gameState.roundNumber || 0, 20));
  f.push(...encodeOneHot(PHASES.indexOf(gameState.phase || ''), PHASES.length));
  f.push(normalize(me.availableResources || 0, 15));
  f.push(normalize(getResourceCount(mine), 15));
  f.push(normalize(getExhaustedResourceCount(mine), 15));
  f.push(normalize(getResourceCount(theirs), 15));
  f.push(normalize(getExhaustedResourceCount(theirs), 15));
  f.push(normalize(getBaseHp(me), 30));
  f.push(normalize(getMaxBaseHp(me), 30));
  f.push(normalize(getBaseHp(opp), 30));
  f.push(normalize(getMaxBaseHp(opp), 30));
  f.push(normalize((mine.hand || []).length, 15));
  f.push(normalize((theirs.hand || []).length, 15));
  f.push(normalize(countCardsInDeck(me), 50));
  f.push(normalize((mine.discard || []).length, 50));
  f.push(normalize((theirs.discard || []).length, 50));
  f.push(normalize((mine.groundArena || []).length, 10));
  f.push(normalize((mine.spaceArena || []).length, 10));
  f.push(normalize((theirs.groundArena || []).length, 10));
  f.push(normalize((theirs.spaceArena || []).length, 10));
  f.push(+(gameState.initiativeClaimed || false));
  f.push(+(me.isActionPhaseActivePlayer || false));

  // Arena power totals
  f.push(normalize(totalPower(mine.groundArena), 20));
  f.push(normalize(totalPower(theirs.groundArena), 20));
  f.push(normalize(totalPower(mine.spaceArena), 20));
  f.push(normalize(totalPower(theirs.spaceArena), 20));

  // Selectable cards and play info
  const hand = mine.hand || [];
  f.push(normalize(hand.filter(c => c.selectable).length, 10));
  const totalRes = getResourceCount(mine);
  f.push(normalize(totalRes > 0 ? (me.availableResources || 0) / totalRes : 1, 1));
  f.push(normalize((mine.groundArena || []).length + (mine.spaceArena || []).length, 10));
  f.push(normalize((theirs.groundArena || []).length + (theirs.spaceArena || []).length, 10));

  const mode = (me?.promptState?.selectCardMode || 'none').toLowerCase();
  let found = false;
  for (const known of SELECT_CARD_MODES) {
    const match = mode.includes(known);
    f.push(+match);
    if (match) found = true;
  }
  f.push(+(!found && mode !== 'none'));
  f.push(normalize(me?.promptState?.promptType ?? 0, 10));

  while (f.length < NUM_SCALAR_FEATURES) f.push(0);
  return new Float64Array(f);
}

function encodeCardFeatures(mine, theirs) {
  const features = [];
  const zones = [
    mine.hand || [], theirs.hand ? maskHidden(theirs.hand) : [],
    mine.groundArena || [], theirs.groundArena || [],
    mine.spaceArena || [], theirs.spaceArena || [],
    mine.resources || [], theirs.resources ? maskHidden(theirs.resources) : [],
    mine.discard || [], theirs.discard || []
  ];
  for (const cards of zones) {
    features.push(...encodeCardList(cards));
  }
  return new Float64Array(features);
}

function encodeCardList(cards) {
  const result = [];
  const list = cards.slice(0, MAX_CARDS_IN_ZONE);
  for (const card of list) {
    result.push(hashCardId(card.id || ''));
    result.push(card.hp !== undefined ? normalize(card.hp, 15) : 0);
    result.push(card.power !== undefined ? normalize(card.power, 15) : 0);
    result.push(card.damage !== undefined ? normalize(card.damage, 15) : 0);
    result.push(card.exhausted ? 1 : 0);
    result.push(card.selectable ? 1 : 0);
    result.push(card.selected ? 1 : 0);
  }
  while (result.length < MAX_CARDS_IN_ZONE * 7) result.push(0);
  return result;
}

function maskHidden(cards) {
  return cards.map((c) => ({ ...c, hp: undefined, power: undefined, damage: undefined }));
}

function hashCardId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) { hash = ((hash << 5) - hash) + id.charCodeAt(i); hash |= 0; }
  return (hash % 1000) / 1000;
}

function normalize(val, max) { return max > 0 ? Math.min(val, max) / max : 0; }

function encodeOneHot(index, length) {
  const arr = new Float64Array(length);
  if (index >= 0 && index < length) arr[index] = 1;
  return arr;
}

function getResourceCount(pg) { return (pg.resources || []).length; }
function getExhaustedResourceCount(pg) { return (pg.resources || []).filter((r) => r.exhausted).length; }
function getBaseHp(ps) { return ps.base?.hp ?? 0; }
function getMaxBaseHp(ps) { return (ps.base?.hp ?? 0) + (ps.base?.damage ?? 0); }
function countCardsInDeck(ps) { return ps.numCardsInDeck ?? 0; }

const MENU_BUTTON_ARGS = [
  'pass', 'claimInitiative', 'done', 'mulligan', 'keep',
  'resource', 'play', 'attack', 'cancel', 'yes', 'no',
  'selectDefenders', 'setup', 'action', 'regroup'
];

function encodeActions(actions) {
  return actions.map((action) => {
    const f = [];
    f.push(+(action.type === 'pass'));
    f.push(+(action.type === 'cardClicked'));
    f.push(+(action.type === 'menuButton'));
    const arg = action.arg || '';
    const argIdx = MENU_BUTTON_ARGS.indexOf(arg);
    for (let i = 0; i < MENU_BUTTON_ARGS.length; i++) f.push(+(argIdx === i));
    f.push(+(argIdx === -1 && arg !== ''));
    f.push(+(arg === ''));
    f.push(action.cardId ? normalize(hashCardId(action.cardId), 1) : 0);
    while (f.length < ACTION_FEATURE_SIZE) f.push(0);
    const scaled = new Float64Array(ACTION_FEATURE_SIZE);
    for (let i = 0; i < ACTION_FEATURE_SIZE; i++) scaled[i] = f[i] * ACTION_GAIN;
    return scaled;
  });
}

class Layer {
  constructor(inSize, outSize, activation, outputScale) {
    this.w = new Float64Array(inSize * outSize);
    this.b = new Float64Array(outSize);
    this.inSize = inSize;
    this.outSize = outSize;
    this.activation = activation;
    this.outputScale = outputScale || 1;
    const scale = Math.sqrt(2.0 / inSize);
    for (let i = 0; i < this.w.length; i++) this.w[i] = (Math.random() * 2 - 1) * scale;
    for (let i = 0; i < this.b.length; i++) this.b[i] = 0;
  }

  forward(input) {
    const out = new Float64Array(this.outSize);
    for (let o = 0; o < this.outSize; o++) {
      let sum = this.b[o];
      for (let i = 0; i < this.inSize; i++) {
        sum += input[i] * this.w[o * this.inSize + i];
      }
      if (!isFinite(sum)) sum = 0;
      let val = this.activation === 'relu' ? Math.max(0, sum) : this.activation === 'sigmoid' ? 1 / (1 + Math.exp(-Math.min(Math.max(sum, -100), 100))) : sum;
      if (this.outputScale !== 1) val *= this.outputScale;
      out[o] = val;
    }
    return out;
  }

  getWeights() {
    return { w: Array.from(this.w), b: Array.from(this.b), inSize: this.inSize, outSize: this.outSize, activation: this.activation, outputScale: this.outputScale };
  }

  setWeights(data) {
    if (data.w && data.w.length === this.inSize * this.outSize) {
      this.w = new Float64Array(data.w);
      this.b = new Float64Array(data.b);
      if (data.outputScale != null) this.outputScale = data.outputScale;
    }
  }

  train(input, target, lr) {
    const z = new Float64Array(this.outSize);
    const a = new Float64Array(this.outSize);
    for (let o = 0; o < this.outSize; o++) {
      z[o] = this.b[o];
      for (let i = 0; i < this.inSize; i++) z[o] += input[i] * this.w[o * this.inSize + i];
      if (!isFinite(z[o])) z[o] = 0;
      let val = this.activation === 'relu' ? Math.max(0, z[o]) : this.activation === 'sigmoid' ? 1 / (1 + Math.exp(-Math.min(Math.max(z[o], -100), 100))) : z[o];
      if (this.outputScale !== 1) val *= this.outputScale;
      a[o] = val;
    }
    const dz = new Float64Array(this.outSize);
    for (let o = 0; o < this.outSize; o++) {
      if (this.activation === 'sigmoid') {
        dz[o] = a[o] - target[o];
      } else if (this.activation === 'relu') {
        dz[o] = target[o] * (z[o] > 0 ? 1 : 0);
      } else {
        dz[o] = target[o] * this.outputScale;
      }
      if (!isFinite(dz[o])) dz[o] = 0;
      dz[o] = Math.min(Math.max(dz[o], -5), 5);
    }
    const dw = new Float64Array(this.inSize * this.outSize);
    for (let o = 0; o < this.outSize; o++) {
      for (let i = 0; i < this.inSize; i++) {
        dw[o * this.inSize + i] = dz[o] * input[i];
        if (!isFinite(dw[o * this.inSize + i])) dw[o * this.inSize + i] = 0;
      }
    }
    for (let i = 0; i < this.w.length; i++) {
      this.w[i] -= lr * Math.min(Math.max(dw[i], -10), 10);
    }
    for (let i = 0; i < this.b.length; i++) {
      this.b[i] -= lr * Math.min(Math.max(dz[i], -10), 10);
    }
    const da_out = new Float64Array(this.inSize);
    for (let i = 0; i < this.inSize; i++) {
      let sum = 0;
      for (let o = 0; o < this.outSize; o++) sum += dz[o] * this.w[o * this.inSize + i];
      da_out[i] = isFinite(sum) ? sum : 0;
    }
    return da_out;
  }

  backward(input, target) {
    const z = new Float64Array(this.outSize);
    const a = new Float64Array(this.outSize);
    for (let o = 0; o < this.outSize; o++) {
      z[o] = this.b[o];
      for (let i = 0; i < this.inSize; i++) z[o] += input[i] * this.w[o * this.inSize + i];
      if (!isFinite(z[o])) z[o] = 0;
      let val = this.activation === 'relu' ? Math.max(0, z[o]) : this.activation === 'sigmoid' ? 1 / (1 + Math.exp(-Math.min(Math.max(z[o], -100), 100))) : z[o];
      if (this.outputScale !== 1) val *= this.outputScale;
      a[o] = val;
    }
    const dz = new Float64Array(this.outSize);
    for (let o = 0; o < this.outSize; o++) {
      if (this.activation === 'sigmoid') {
        dz[o] = a[o] - target[o];
      } else if (this.activation === 'relu') {
        dz[o] = target[o] * (z[o] > 0 ? 1 : 0);
      } else {
        dz[o] = target[o] * this.outputScale;
      }
      if (!isFinite(dz[o])) dz[o] = 0;
      dz[o] = Math.min(Math.max(dz[o], -5), 5);
    }
    const dw = new Float64Array(this.inSize * this.outSize);
    for (let o = 0; o < this.outSize; o++) {
      for (let i = 0; i < this.inSize; i++) {
        dw[o * this.inSize + i] = dz[o] * input[i];
        if (!isFinite(dw[o * this.inSize + i])) dw[o * this.inSize + i] = 0;
      }
    }
    const da_out = new Float64Array(this.inSize);
    for (let i = 0; i < this.inSize; i++) {
      let sum = 0;
      for (let o = 0; o < this.outSize; o++) sum += dz[o] * this.w[o * this.inSize + i];
      da_out[i] = isFinite(sum) ? sum : 0;
    }
    return { dw, dz, da_out };
  }

  applyGradients(dwAccum, dzAccum, lr, weightDecay) {
    weightDecay = weightDecay || 0;
    for (let i = 0; i < this.w.length; i++) {
      const decay = weightDecay * this.w[i];
      this.w[i] -= lr * (Math.min(Math.max(dwAccum[i], -10), 10) + decay);
    }
    for (let i = 0; i < this.b.length; i++) {
      this.b[i] -= lr * Math.min(Math.max(dzAccum[i], -10), 10);
    }
  }
}

class NeuralNet {
  constructor() {
    this.layers = [
      new Layer(STATE_SIZE + ACTION_FEATURE_SIZE, 128, 'relu'),
      new Layer(128, 64, 'relu'),
      new Layer(64, 1, 'linear', 5)
    ];
  }

  forward(state, action) {
    const combined = new Float64Array(STATE_SIZE + ACTION_FEATURE_SIZE);
    combined.set(state, 0);
    combined.set(action, STATE_SIZE);
    let x = combined;
    for (const layer of this.layers) x = layer.forward(x);
    return x[0];
  }

  scoreActionPair(state, action) {
    return this.forward(state, action);
  }

  trainStep(state, action, label, lr = 0.01) {
    const combined = new Float64Array(STATE_SIZE + ACTION_FEATURE_SIZE);
    combined.set(state, 0);
    combined.set(action, STATE_SIZE);
    const target = new Float64Array([label]);
    let da = null;
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layerInput = i === 0 ? combined : this.layers.slice(0, i).reduce((x, l) => l.forward(x), combined);
      if (i === this.layers.length - 1) {
        da = this.layers[i].train(layerInput, target, lr);
      } else {
        da = this.layers[i].train(layerInput, da, lr);
      }
    }
  }

  trainRankingStep(state, actionTensors, takenIndex, isWin, lr, margin, topK = 0, weightDecay = 0.01) {
    const combineds = actionTensors.map(af => {
      const c = new Float64Array(STATE_SIZE + ACTION_FEATURE_SIZE);
      c.set(state, 0);
      c.set(af, STATE_SIZE);
      return c;
    });

    const scores = combineds.map(c => {
      let x = c;
      for (const layer of this.layers) x = layer.forward(x);
      return x[0];
    });

    const grads = new Float64Array(actionTensors.length);
    if (topK > 0 && actionTensors.length > 2) {
      const nonTaken = [];
      for (let j = 0; j < actionTensors.length; j++) {
        if (j !== takenIndex) nonTaken.push(j);
      }
      nonTaken.sort((a, b) => scores[b] - scores[a]);
      const candidates = nonTaken.slice(0, Math.min(topK, nonTaken.length));
      for (const j of candidates) {
        if (isWin) {
          if (scores[j] + margin > scores[takenIndex]) {
            grads[takenIndex] -= 1;
            grads[j] += 1;
          }
        } else {
          if (scores[takenIndex] + margin > scores[j]) {
            grads[takenIndex] += 1;
            grads[j] -= 1;
          }
        }
      }
    } else {
      for (let j = 0; j < actionTensors.length; j++) {
        if (j === takenIndex) continue;
        if (isWin) {
          if (scores[j] + margin > scores[takenIndex]) {
            grads[takenIndex] -= 1;
            grads[j] += 1;
          }
        } else {
          if (scores[takenIndex] + margin > scores[j]) {
            grads[takenIndex] += 1;
            grads[j] -= 1;
          }
        }
      }
    }

    const accumDws = this.layers.map(l => new Float64Array(l.w.length));
    const accumDzs = this.layers.map(l => new Float64Array(l.b.length));
    let anyGrad = false;

    for (let j = 0; j < actionTensors.length; j++) {
      if (grads[j] === 0) continue;
      anyGrad = true;

      let da = null;
      for (let i = this.layers.length - 1; i >= 0; i--) {
        const layerInput = i === 0 ? combineds[j] : this.layers.slice(0, i).reduce((x, l) => l.forward(x), combineds[j]);
        const target = da !== null ? da : new Float64Array([grads[j]]);
        const result = this.layers[i].backward(layerInput, target);
        for (let k = 0; k < result.dw.length; k++) accumDws[i][k] += result.dw[k];
        for (let k = 0; k < result.dz.length; k++) accumDzs[i][k] += result.dz[k];
        da = result.da_out;
      }
    }

    if (anyGrad) {
      for (let i = 0; i < this.layers.length; i++) {
        this.layers[i].applyGradients(accumDws[i], accumDzs[i], lr, weightDecay);
      }
    }

    let violations = 0;
    for (let j = 0; j < grads.length; j++) violations += Math.abs(grads[j]);
    return violations;
  }

  save() {
    return { layers: this.layers.map((l) => l.getWeights()) };
  }

  load(data) {
    for (let i = 0; i < data.layers.length && i < this.layers.length; i++) {
      this.layers[i].setWeights(data.layers[i]);
    }
  }

  getWeights() {
    return { layers: this.layers.map((l) => l.getWeights()) };
  }

  setWeights(weights) {
    for (let i = 0; i < weights.layers.length && i < this.layers.length; i++) {
      this.layers[i].setWeights(weights.layers[i]);
    }
  }
}

function clearCachedModel() { cachedModel = null; }

async function loadModel() {
  if (cachedModel) return cachedModel;
  const model = new NeuralNet();
  try {
    const w = await loadModelWeights();
    if (w && w.layers) model.setWeights(w);
    else console.log('No saved weights, using fresh model');
  } catch (e) { console.warn('Model load failed, using fresh', e); }
  cachedModel = model;
  return model;
}

async function saveModelToDB(model) {
  await saveModelWeights(model.save());
}

function selectBestAction(model, stateTensor, actionFeatures, actionDescriptors) {
  if (actionDescriptors.length === 0) return null;
  if (actionDescriptors.length === 1) return actionDescriptors[0];
  const scores = actionFeatures.map((af) => model.forward(stateTensor, af));
  const bestScore = Math.max(...scores);
  const worstScore = Math.min(...scores);
  if (isNaN(bestScore) || !isFinite(bestScore) || bestScore - worstScore < 0.01) {
    return actionDescriptors[Math.floor(Math.random() * actionDescriptors.length)];
  }
  return actionDescriptors[scores.indexOf(bestScore)];
}

function selectTopActions(model, stateTensor, actionFeatures, actionDescriptors, n) {
  n = n || 3;
  const scored = actionFeatures.map((af, i) => ({ score: model.forward(stateTensor, af), action: actionDescriptors[i] }))
    .filter(s => isFinite(s.score));
  if (scored.length === 0) return (actionDescriptors || []).slice(0, n).map(a => ({ score: 0.5, action: a }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, Math.min(n, scored.length));

  // If scores are nearly identical, diversify to show a mix of action types
  if (top.length > 1) {
    const maxScore = top[0].score;
    const minScore = top[top.length - 1].score;
    if (maxScore - minScore < 0.01) {
      const diversified = [];
      const groups = {};
      for (const s of scored) {
        const key = s.action.type === 'cardClicked' ? 'card' : (s.action.arg === 'pass' ? 'pass' : 'menu');
        if (!groups[key]) groups[key] = [];
        groups[key].push(s);
      }
      for (const key of ['card', 'menu']) {
        if (diversified.length < n && groups[key]?.length > 0) {
          diversified.push(groups[key].shift());
        }
      }
      for (const s of scored) {
        if (diversified.length >= n) break;
        if (!diversified.includes(s)) diversified.push(s);
      }
      return diversified;
    }
  }
  return top;
}

async function trainModelRanking(model, games, params = {}) {
  const {
    lrStart = 0.003, lrEnd = 0.001,
    marginWinStart = 2.0, marginWinEnd = 1.0,
    marginLossStart = 0.6, marginLossEnd = 0.3,
    epochs = 5, topK = 3
  } = params;
  const prefAccs = [];
  for (let epoch = 0; epoch < epochs; epoch++) {
    const t = epochs > 1 ? epoch / (epochs - 1) : 0;
    const epochLr = lrStart + (lrEnd - lrStart) * t;
    const epochMarginWin = marginWinStart + (marginWinEnd - marginWinStart) * t;
    const epochMarginLoss = marginLossStart + (marginLossEnd - marginLossStart) * t;
    for (let i = games.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [games[i], games[j]] = [games[j], games[i]];
    }
    let totalViolations = 0;
    let totalStates = 0;
    let correctPref = 0;
    let totalPref = 0;
    for (const game of games) {
      const winners = Array.isArray(game.winner) ? game.winner : (game.winner ? [game.winner] : null);
      const botWon = winners && game.playerId ? winners.includes(game.playerId) : null;
      if (botWon === null) continue;
      for (let i = 0; i < game.states.length - 1; i++) {
        const stateObj = game.states[i]?.state;
        if (!stateObj || !stateObj.players) continue;
        const takenActions = game.actions.filter(a => a.stateIndex === i);
        if (takenActions.length === 0) continue;
        const allActions = getAvailableActions(stateObj);
        if (allActions.length < 2) continue;
        const stateTensor = encodeGameState(stateObj);
        const actionTensors = encodeActions(allActions);
        let takenIndex = -1;
        for (let j = 0; j < allActions.length; j++) {
          if (takenActions.some(ta => {
            const taType = ta.event === 'game' ? ta.args[0] : ta.event;
            const taArg = ta.event === 'game' ? ta.args[1] : ta.args[0];
            if (taType === 'menuButton' && allActions[j].type === 'menuButton')
              return String(taArg) === String(allActions[j].arg);
            if (taType === 'cardClicked' && allActions[j].type === 'cardClicked')
              return String(taArg) === String(allActions[j].cardId);
            return false;
          })) { takenIndex = j; break; }
        }
        if (takenIndex === -1) continue;
        const scores = allActions.map((_, j) => model.forward(stateTensor, actionTensors[j]));
        if (botWon) {
          const maxOther = Math.max(...scores.filter((_, idx) => idx !== takenIndex));
          if (scores[takenIndex] >= maxOther) correctPref++;
        } else {
          const minOther = Math.min(...scores.filter((_, idx) => idx !== takenIndex));
          if (scores[takenIndex] <= minOther) correctPref++;
        }
        totalPref++;
        const margin = botWon ? epochMarginWin : epochMarginLoss;
        totalViolations += model.trainRankingStep(stateTensor, actionTensors, takenIndex, botWon, epochLr, margin, topK);
        totalStates++;
      }
    }
    const prefAcc = totalPref > 0 ? correctPref / totalPref : 0;
    const avgViolations = totalStates > 0 ? totalViolations / totalStates : 0;
    console.log(`Epoch ${epoch + 1}: lr=${epochLr.toFixed(5)} mWin=${epochMarginWin.toFixed(3)} mLoss=${epochMarginLoss.toFixed(3)} topK=${topK} avg_violations=${avgViolations.toFixed(4)} pref_acc=${(prefAcc * 100).toFixed(2)}% (${correctPref}/${totalPref})`);
    prefAccs.push(prefAcc);
  }
  return { history: { pref_acc: prefAccs } };
}
