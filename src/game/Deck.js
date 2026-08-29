const { CHARACTERS, CARDS_PER_CHARACTER } = require('./constants');

class Deck {
  constructor() {
    this.cards = [];
    for (const character of CHARACTERS) {
      for (let i = 0; i < CARDS_PER_CHARACTER; i++) {
        this.cards.push(character);
      }
    }
    this.shuffle();
  }

  shuffle() {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  draw(count = 1) {
    return this.cards.splice(0, count);
  }

  returnCards(characters) {
    this.cards.push(...characters);
    this.shuffle();
  }
}

module.exports = Deck;
