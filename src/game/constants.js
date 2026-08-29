const CHARACTERS = ['duke', 'assassin', 'captain', 'ambassador', 'contessa'];

const CHARACTER_INFO = {
  duke: { name: 'Duque', description: 'Cobra 3 moedas (Taxar). Bloqueia Ajuda Externa.' },
  assassin: { name: 'Assassino', description: 'Paga 3 moedas para assassinar a influência de um alvo.' },
  captain: { name: 'Capitão', description: 'Rouba 2 moedas de um alvo. Bloqueia Extorsão.' },
  ambassador: { name: 'Embaixador', description: 'Troca cartas com o baralho. Bloqueia Extorsão.' },
  contessa: { name: 'Condessa', description: 'Bloqueia Assassinato.' },
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
};

const MUST_COUP_AT_COINS = 10;
const CARDS_PER_CHARACTER = 3;
const STARTING_COINS = 2;
const STARTING_INFLUENCE = 2;

module.exports = {
  CHARACTERS,
  CHARACTER_INFO,
  ACTIONS,
  MUST_COUP_AT_COINS,
  CARDS_PER_CHARACTER,
  STARTING_COINS,
  STARTING_INFLUENCE,
};
