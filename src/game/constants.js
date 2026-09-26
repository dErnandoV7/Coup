const CHARACTERS = ['duke', 'assassin', 'captain', 'ambassador', 'contessa'];

// The two variants a room can be created with. Exactly 5 character types are
// ever in play at once (never both ambassador and inquisitor together), so
// the deck always stays at 5 x CARDS_PER_CHARACTER — the same real-life limit
// as the physical game, whichever variant is chosen.
const GAME_MODES = {
  classic: ['duke', 'assassin', 'captain', 'ambassador', 'contessa'],
  reformation: ['duke', 'assassin', 'captain', 'inquisitor', 'contessa'],
};
const DEFAULT_MODE = 'classic';

const CHARACTER_INFO = {
  duke: { name: 'Duque', description: 'Cobra 3 moedas (Taxar). Bloqueia Ajuda Externa.' },
  assassin: { name: 'Assassino', description: 'Paga 3 moedas para assassinar a influência de um alvo.' },
  captain: { name: 'Capitão', description: 'Rouba 2 moedas de um alvo. Bloqueia Extorsão.' },
  ambassador: { name: 'Embaixador', description: 'Troca cartas com o baralho. Bloqueia Extorsão.' },
  contessa: { name: 'Condessa', description: 'Bloqueia Assassinato.' },
  inquisitor: {
    name: 'Inquisidor',
    description: 'Troca 1 carta com o baralho, ou investiga a carta de um alvo (podendo forçar a troca dela). Bloqueia Extorsão.',
  },
};

const ACTIONS = {
  income: {
    name: 'income', label: 'Renda', cost: 0, coinGain: 1,
    requiresTarget: false, character: null, challengeable: false, blockable: false,
  },
  foreign_aid: {
    name: 'foreign_aid', label: 'Ajuda Externa', cost: 0, coinGain: 2,
    requiresTarget: false, character: null, challengeable: false, blockable: true, blockedBy: ['duke'],
  },
  coup: {
    name: 'coup', label: 'Golpe de Estado', cost: 7,
    requiresTarget: true, character: null, challengeable: false, blockable: false, forcesLoss: true,
  },
  tax: {
    name: 'tax', label: 'Taxar', cost: 0, coinGain: 3,
    requiresTarget: false, character: 'duke', challengeable: true, blockable: false,
  },
  assassinate: {
    name: 'assassinate', label: 'Assassinar', cost: 3,
    requiresTarget: true, character: 'assassin', challengeable: true, blockable: true, blockedBy: ['contessa'], forcesLoss: true,
  },
  steal: {
    name: 'steal', label: 'Extorquir', cost: 0,
    requiresTarget: true, character: 'captain', challengeable: true, blockable: true, blockedBy: ['captain', 'ambassador'],
  },
  exchange: {
    name: 'exchange', label: 'Trocar', cost: 0,
    requiresTarget: false, character: 'ambassador', challengeable: true, blockable: false,
  },
  examine: {
    name: 'examine', label: 'Inquirir', cost: 0,
    requiresTarget: true, character: 'inquisitor', challengeable: true, blockable: false,
  },
};

// `exchange`/`steal` are written above assuming the classic ambassador slot.
// In reformation mode, the inquisitor takes over that exact same slot (both
// the "trade with the deck" action and blocking a steal) — these two helpers
// are the single place that substitution happens, so GameEngine never needs
// to hardcode which of the two characters is active.
function exchangeCharacterForMode(mode) {
  return mode === 'reformation' ? 'inquisitor' : 'ambassador';
}

function blockedByForMode(actionName, mode) {
  const base = (ACTIONS[actionName] && ACTIONS[actionName].blockedBy) || [];
  return base.map((c) => (c === 'ambassador' ? exchangeCharacterForMode(mode) : c));
}

const MUST_COUP_AT_COINS = 10;
const CARDS_PER_CHARACTER = 3;
const STARTING_COINS = 2;
const STARTING_INFLUENCE = 2;

module.exports = {
  CHARACTERS,
  GAME_MODES,
  DEFAULT_MODE,
  CHARACTER_INFO,
  ACTIONS,
  MUST_COUP_AT_COINS,
  CARDS_PER_CHARACTER,
  STARTING_COINS,
  STARTING_INFLUENCE,
  exchangeCharacterForMode,
  blockedByForMode,
};
