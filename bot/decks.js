const CAD_BANE_DECK = {
  leader: { id: 'ASH_011', count: 1 },
  base: { id: 'ASH_020', count: 1 },
  cards: [
    { id: 'SOR_020', count: 3 }, { id: 'SOR_021', count: 3 }, { id: 'SOR_022', count: 3 },
    { id: 'SOR_023', count: 3 }, { id: 'SOR_024', count: 3 }, { id: 'SOR_025', count: 3 },
    { id: 'SOR_026', count: 3 }, { id: 'SOR_027', count: 3 }, { id: 'SOR_028', count: 3 },
    { id: 'SOR_029', count: 3 }, { id: 'SOR_030', count: 3 }, { id: 'SOR_031', count: 3 },
    { id: 'SOR_032', count: 3 }, { id: 'SOR_033', count: 3 }, { id: 'SOR_034', count: 3 },
    { id: 'SOR_035', count: 3 }, { id: 'SOR_036', count: 2 }
  ]
};

const DECKS = {
  'cad-bane': CAD_BANE_DECK
};

function getDeck(name) {
  return DECKS[name] || CAD_BANE_DECK;
}

module.exports = { DECKS, getDeck, CAD_BANE_DECK };
