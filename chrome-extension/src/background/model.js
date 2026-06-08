const MAX_CARDS_IN_ZONE = 5;
const NUM_SCALAR_FEATURES = 32;
const CARD_FEATURE_COUNT = 10 * MAX_CARDS_IN_ZONE * 7;
const STATE_SIZE = NUM_SCALAR_FEATURES + CARD_FEATURE_COUNT;
const ACTION_FEATURE_SIZE = 64;
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

function findActivePlayerId(gameState) {
  const players = gameState.players || {};
  for (const [id, p] of Object.entries(players)) {
    const ps = p.promptState;
    if (ps && ps.promptType !== undefined && ps.promptType !== null && ps.promptType !== '' && ps.promptType !== false && ps.promptType !== 0) return id;
  }
  return Object.keys(players)[0];
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
    return new Float64Array(f);
  });
}

class Layer {
  constructor(inSize, outSize, activation) {
    this.w = new Float64Array(inSize * outSize);
    this.b = new Float64Array(outSize);
    this.inSize = inSize;
    this.outSize = outSize;
    this.activation = activation;
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
      out[o] = this.activation === 'relu' ? Math.max(0, sum) : this.activation === 'sigmoid' ? 1 / (1 + Math.exp(-sum)) : sum;
    }
    return out;
  }

  getWeights() {
    return { w: Array.from(this.w), b: Array.from(this.b), inSize: this.inSize, outSize: this.outSize, activation: this.activation };
  }

  setWeights(data) {
    if (data.w && data.w.length === this.inSize * this.outSize) {
      this.w = new Float64Array(data.w);
      this.b = new Float64Array(data.b);
    }
  }

  train(input, target, lr) {
    const z = new Float64Array(this.outSize);
    const a = new Float64Array(this.outSize);
    for (let o = 0; o < this.outSize; o++) {
      z[o] = this.b[o];
      for (let i = 0; i < this.inSize; i++) z[o] += input[i] * this.w[o * this.inSize + i];
      a[o] = this.activation === 'relu' ? Math.max(0, z[o]) : this.activation === 'sigmoid' ? 1 / (1 + Math.exp(-z[o])) : z[o];
    }
    const dz = new Float64Array(this.outSize);
    for (let o = 0; o < this.outSize; o++) {
      const da = a[o] - target[o];
      if (this.activation === 'sigmoid') dz[o] = da * a[o] * (1 - a[o]);
      else if (this.activation === 'relu') dz[o] = da * (z[o] > 0 ? 1 : 0);
      else dz[o] = da;
    }
    const dw = new Float64Array(this.inSize * this.outSize);
    for (let o = 0; o < this.outSize; o++) {
      for (let i = 0; i < this.inSize; i++) {
        dw[o * this.inSize + i] = dz[o] * input[i];
      }
    }
    for (let i = 0; i < this.w.length; i++) this.w[i] -= lr * dw[i];
    for (let i = 0; i < this.b.length; i++) this.b[i] -= lr * dz[i];
    const da_out = new Float64Array(this.inSize);
    for (let i = 0; i < this.inSize; i++) {
      let sum = 0;
      for (let o = 0; o < this.outSize; o++) sum += dz[o] * this.w[o * this.inSize + i];
      da_out[i] = sum;
    }
    return da_out;
  }
}

class NeuralNet {
  constructor() {
    this.layers = [
      new Layer(STATE_SIZE + ACTION_FEATURE_SIZE, 128, 'relu'),
      new Layer(128, 64, 'relu'),
      new Layer(64, 1, 'sigmoid')
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
  return actionDescriptors[scores.indexOf(Math.max(...scores))];
}

function selectTopActions(model, stateTensor, actionFeatures, actionDescriptors, n) {
  n = n || 3;
  const scored = actionFeatures.map((af, i) => ({ score: model.forward(stateTensor, af), action: actionDescriptors[i] }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(n, scored.length));
}

async function trainModel(model, stateBuffer, actionBuffer, labelBuffer, epochs = 5) {
  const lr = 0.005;
  const losses = [];
  const accs = [];
  for (let epoch = 0; epoch < epochs; epoch++) {
    const indices = Array.from({ length: stateBuffer.length }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [indices[i], indices[j]] = [indices[j], indices[i]]; }
    let epochLoss = 0;
    let correct = 0;
    const valCount = Math.max(1, Math.floor(stateBuffer.length * 0.1));
    for (let k = 0; k < stateBuffer.length - valCount; k++) {
      const idx = indices[k];
      const pred = model.forward(new Float64Array(stateBuffer[idx]), new Float64Array(actionBuffer[idx]));
      const target = labelBuffer[idx];
      const loss = -(target * Math.log(Math.max(pred, 1e-10)) + (1 - target) * Math.log(Math.max(1 - pred, 1e-10)));
      epochLoss += loss;
      if ((pred >= 0.5 && target >= 0.5) || (pred < 0.5 && target < 0.5)) correct++;
      model.trainStep(new Float64Array(stateBuffer[idx]), new Float64Array(actionBuffer[idx]), target, lr);
    }
    let valLoss = 0;
    let valCorrect = 0;
    for (let k = stateBuffer.length - valCount; k < stateBuffer.length; k++) {
      const idx = indices[k];
      const pred = model.forward(new Float64Array(stateBuffer[idx]), new Float64Array(actionBuffer[idx]));
      const target = labelBuffer[idx];
      valLoss += -(target * Math.log(Math.max(pred, 1e-10)) + (1 - target) * Math.log(Math.max(1 - pred, 1e-10)));
      if ((pred >= 0.5 && target >= 0.5) || (pred < 0.5 && target < 0.5)) valCorrect++;
    }
    const trainLoss = epochLoss / (stateBuffer.length - valCount);
    const trainAcc = correct / (stateBuffer.length - valCount);
    const vLoss = valLoss / valCount;
    const vAcc = valCorrect / valCount;
    console.log(`Epoch ${epoch + 1}: loss=${trainLoss.toFixed(4)}, acc=${trainAcc.toFixed(4)}, val_loss=${vLoss.toFixed(4)}, val_acc=${vAcc.toFixed(4)}`);
    losses.push(trainLoss);
    accs.push(trainAcc);
  }
  return { history: { loss: losses, acc: accs, val_loss: losses, val_acc: accs } };
}
