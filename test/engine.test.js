// Cenários específicos do motor, incluindo os bugs já encontrados em partidas.
const test = require('node:test');
const assert = require('node:assert');
const GameEngine = require('../src/game/GameEngine');

const card = (character, revealed = false) => ({ character, revealed });

// Alice joga primeiro, com 3 moedas e [Assassino, Duque].
function setup({ players = ['Alice', 'Bob', 'Carol'], bob } = {}) {
  const g = new GameEngine(players.map((name) => ({ id: name[0], name })));
  g.turnIndex = 0;
  g.players[0].coins = 3;
  g.players[0].influence = [card('assassin'), card('duke')];
  if (bob) g.players[1].influence = bob;
  return g;
}

test('desafiar o Assassino com 1 carta e perder elimina o alvo sem oferecer Condessa', () => {
  const g = setup({ bob: [card('captain', true), card('duke')] });
  g.performAction('A', 'assassinate', 'B');
  g.challenge('B');
  assert.strictEqual(g.isAlive(g.getPlayer('B')), false);
  assert.strictEqual(g.phase, 'awaiting_action');
  assert.strictEqual(g.currentPlayer().id, 'C');
});

test('desafiar o Assassino com 2 cartas e perder ainda permite bloquear com Condessa', () => {
  const g = setup({ bob: [card('captain'), card('duke')] });
  g.performAction('A', 'assassinate', 'B');
  g.challenge('B');
  assert.strictEqual(g.phase, 'awaiting_loss');
  g.loseInfluence('B', 'captain');
  assert.strictEqual(g.phase, 'block_window');
  assert.deepStrictEqual(g._eligibleBlockers(g.pending), ['B']);
  g.pass('B');
  assert.strictEqual(g.isAlive(g.getPlayer('B')), false);
  assert.strictEqual(g.phase, 'awaiting_action');
});

test('blefar Condessa com a última carta e ser desafiado não trava o jogo', () => {
  const g = setup({ bob: [card('captain', true), card('duke')] });
  g.performAction('A', 'assassinate', 'B');
  g.pass('B');
  g.pass('C');
  g.block('B', 'contessa');
  g.challenge('A');
  assert.strictEqual(g.isAlive(g.getPlayer('B')), false);
  assert.strictEqual(g.phase, 'awaiting_action');
  assert.strictEqual(g.currentPlayer().id, 'C');
});

test('assassino que desiste enquanto o alvo escolhe a carta perdida cancela a ação', () => {
  const g = setup({ bob: [card('captain'), card('duke')] });
  g.performAction('A', 'assassinate', 'B');
  g.challenge('B');
  g.forfeit('A');
  g.loseInfluence('B', 'captain');
  assert.strictEqual(g.phase, 'awaiting_action');
  assert.strictEqual(g.aliveCount(g.getPlayer('B')), 1);
});

test('Assassino blefando e desafiado: ação cancelada, alvo intacto', () => {
  const g = setup({ bob: [card('captain'), card('duke')] });
  g.players[0].influence = [card('duke'), card('captain')];
  g.performAction('A', 'assassinate', 'B');
  g.challenge('B');
  g.loseInfluence('A', 'duke');
  assert.strictEqual(g.phase, 'awaiting_action');
  assert.ok(g.getPlayer('B').influence.every((c) => !c.revealed));
});

test('com 2 jogadores, eliminar o alvo no desafio encerra a partida', () => {
  const g = setup({ players: ['Alice', 'Bob'], bob: [card('captain', true), card('duke')] });
  g.performAction('A', 'assassinate', 'B');
  g.challenge('B');
  assert.strictEqual(g.phase, 'game_over');
  assert.strictEqual(g.winnerId, 'A');
});

test('nunca pede carta de quem já foi eliminado', () => {
  const g = setup({ bob: [card('captain', true), card('duke', true)] });
  g._applyEffect({ action: 'assassinate', actorId: 'A', targetId: 'B' });
  assert.strictEqual(g.phase, 'awaiting_action');
});

test('passar mantém a janela aberta até todos responderem', () => {
  const g = setup();
  g.performAction('A', 'tax');
  g.pass('B');
  assert.strictEqual(g.phase, 'challenge_action');
  g.pass('C');
  assert.strictEqual(g.phase, 'awaiting_action');
  assert.strictEqual(g.getPlayer('A').coins, 6);
});

test('logSeq sempre cresce, mesmo com o histórico cortado', () => {
  const g = setup();
  for (let i = 0; i < 300; i++) g.addLog('x');
  assert.strictEqual(g.log.length, 200);
  assert.ok(g.logSeq > 300);
  assert.strictEqual(g.getStateFor('A').logSeq, g.logSeq);
});
