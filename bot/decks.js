const fs = require('fs');
const path = require('path');

const CAD_BANE_DECK = {
  metadata: { name: "Cad Blue", author: "AlmostScorpio" },
  leader: { id: 'ASH_011', count: 1 },
  base: { id: 'ASH_020', count: 1 },
  cards: [
    { id: 'ASH_052', count: 3 },
    { id: 'JTL_043', count: 3 },
    { id: 'ASH_147', count: 2 },
    { id: 'JTL_140', count: 3 },
    { id: 'ASH_030', count: 3 },
    { id: 'ASH_079', count: 2 },
    { id: 'ASH_071', count: 3 },
    { id: 'JTL_143', count: 1 },
    { id: 'SEC_133', count: 3 },
    { id: 'JTL_239', count: 3 },
    { id: 'ASH_148', count: 3 },
    { id: 'LAW_132', count: 1 },
    { id: 'LAW_173', count: 3 },
    { id: 'ASH_146', count: 3 },
    { id: 'ASH_048', count: 2 },
    { id: 'LOF_063', count: 2 },
    { id: 'LAW_133', count: 1 },
    { id: 'LOF_130', count: 3 },
    { id: 'LAW_174', count: 3 },
    { id: 'ASH_053', count: 3 }
  ],
  sideboard: [
    { id: 'ASH_241', count: 2 },
    { id: 'ASH_079', count: 1 },
    { id: 'JTL_143', count: 2 },
    { id: 'LAW_132', count: 2 },
    { id: 'LAW_208', count: 3 },
    { id: 'JTL_181', count: 3 },
    { id: 'LAW_133', count: 1 }
  ]
};

const DECKS = {
  'cad-bane': CAD_BANE_DECK
};

const dataDir = path.join(__dirname, '..', 'server', 'data');
const decksFile = path.join(dataDir, 'decks.json');

function loadCustomDecks() {
  try {
    const raw = fs.readFileSync(decksFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function findDeckByName(name) {
  const custom = loadCustomDecks();
  return custom.find(d => d.name === name);
}

function getDeck(name) {
  if (!name) return CAD_BANE_DECK;
  const custom = findDeckByName(name);
  if (custom) {
    return {
      metadata: { name: custom.name, author: 'custom' },
      leader: custom.leader,
      base: custom.base,
      cards: custom.cards,
      sideboard: custom.sideboard || []
    };
  }
  return DECKS[name] || CAD_BANE_DECK;
}

function getDeckNames() {
  const builtin = Object.keys(DECKS);
  const custom = loadCustomDecks().map(d => d.name);
  return [...builtin, ...custom];
}

module.exports = { DECKS, getDeck, getDeckNames, CAD_BANE_DECK };
