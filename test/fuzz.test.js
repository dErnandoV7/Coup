// Joga milhares de partidas aleatórias contra o GameEngine, com todas as
// jogadas possíveis (ações, blefes, desafios, bloqueios, desistências,
// timeouts e desconexões), e checa a cada passo que o estado continua
// válido e que sempre existe alguém podendo jogar.
const test = require('node:test');
const assert = require('node:assert');
const GameEngine = require('../src/game/GameEngine');
const {
  ACTIONS, GAME_MODES, CARDS_PER_CHARACTER, MUST_COUP_AT_COINS, blockedByForMode,
} = require('../src/game/constants');

const GAMES = Number(process.env.FUZZ_GAMES || 3000);
const MAX_STEPS = 600;

// Gerador determinístico, para que uma falha possa ser reproduzida pela seed.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hidden = (p) => p.influence.filter((c) => !c.revealed).map((c) => c.character);

function eligibleResponders(g) {
  if (g.phase === 'block_window') return g._eligibleBlockers(g.pending);
  const claimant = g.phase === 'challenge_block' ? g.pending.blockerId : g.pending.actorId;
  return g._eligibleChallengers(claimant);
}

function combos(arr, k) {
  if (k === 0) return [[]];
  const out = [];
  arr.forEach((x, i) => combos(arr.slice(i + 1), k - 1).forEach((rest) => out.push([x, ...rest])));
  return out;
}

// Todas as jogadas que um jogador de verdade conseguiria fazer pela interface.
function legalMoves(g) {
  const moves = [];
  const p = g.pending;
  switch (g.phase) {
    case 'awaiting_action': {
      const actor = g.currentPlayer();
      for (const action of Object.values(ACTIONS)) {
        if (action.name === 'examine' && g.mode !== 'reformation') continue;
        if (actor.coins < action.cost) continue;
        if (actor.coins >= MUST_COUP_AT_COINS && action.name !== 'coup') continue;
        if (action.requiresTarget) {
          g.activePlayers().filter((t) => t.id !== actor.id)
            .forEach((t) => moves.push({ who: actor.id, fn: 'performAction', args: [actor.id, action.name, t.id] }));
        } else {
          moves.push({ who: actor.id, fn: 'performAction', args: [actor.id, action.name] });
        }
      }
      break;
    }
    case 'challenge_action':
    case 'block_window':
    case 'challenge_block':
      for (const id of eligibleResponders(g)) {
        if (p.respondedIds.has(id)) continue;
        moves.push({ who: id, fn: 'pass', args: [id] });
        if (g.phase === 'block_window') {
          blockedByForMode(p.action, g.mode).forEach((c) => moves.push({ who: id, fn: 'block', args: [id, c] }));
        } else {
          moves.push({ who: id, fn: 'challenge', args: [id] });
        }
      }
      break;
    case 'awaiting_loss': {
      const loser = g.getPlayer(p.awaitingLossPlayerId);
      hidden(loser).forEach((c) => moves.push({ who: loser.id, fn: 'loseInfluence', args: [loser.id, c] }));
      break;
    }
    case 'exchange_choice': {
      const keep = hidden(g.getPlayer(p.actorId)).length;
      combos(p.options, keep).forEach((k) => moves.push({ who: p.actorId, fn: 'exchangeChoice', args: [p.actorId, k] }));
      break;
    }
    case 'examine_reveal':
      hidden(g.getPlayer(p.targetId)).forEach((c) => moves.push({ who: p.targetId, fn: 'chooseExamineCard', args: [p.targetId, c] }));
      break;
    case 'examine_decision':
      moves.push({ who: p.actorId, fn: 'examineDecision', args: [p.actorId, true] });
      moves.push({ who: p.actorId, fn: 'examineDecision', args: [p.actorId, false] });
      break;
    default:
      break;
  }
  return moves;
}

// Muda sempre que o jogo avança, inclusive num "Passar" que não fecha a janela.
const signature = (g) => `${g.phase}|${g.logSeq}|${g.pending && g.pending.respondedIds ? g.pending.respondedIds.size : '-'}`;

function checkInvariants(g, prevHidden, prevSig) {
  const totalCards = GAME_MODES[g.mode].length * CARDS_PER_CHARACTER;
  // Durante a troca, as cartas compradas estão só em pending.options.
  const drawnForExchange = g.phase === 'exchange_choice'
    ? g.pending.options.length - hidden(g.getPlayer(g.pending.actorId)).length
    : 0;
  const inPlay = g.deck.cards.length + drawnForExchange
    + g.players.reduce((n, pl) => n + pl.influence.length, 0);
  // Com a partida encerrada o baralho não importa mais (ex.: fim durante uma troca).
  if (g.phase !== 'game_over') assert.strictEqual(inPlay, totalCards, 'cartas criadas ou perdidas');

  g.players.forEach((pl, i) => {
    assert.ok(pl.coins >= 0, `${pl.name} com moedas negativas`);
    assert.strictEqual(pl.influence.length, 2, `${pl.name} com ${pl.influence.length} cartas`);
    assert.ok(hidden(pl).length <= prevHidden[i], `${pl.name} recuperou influência`);
  });
  assert.notStrictEqual(signature(g), prevSig, 'jogada aceita mas o estado não mudou');

  if (g.phase === 'game_over') {
    assert.ok(g.activePlayers().length <= 1, 'fim de jogo com mais de 1 vivo');
    if (g.winnerId) assert.ok(g.isAlive(g.getPlayer(g.winnerId)), 'vencedor morto');
    return;
  }

  assert.ok(g.activePlayers().length >= 2, 'jogo continua com menos de 2 vivos');
  const alive = (id, what) => assert.ok(g.isAlive(g.getPlayer(id)), `${what} está eliminado (fase ${g.phase})`);
  const p = g.pending;

  switch (g.phase) {
    case 'awaiting_action':
      alive(g.currentPlayer().id, 'jogador da vez');
      assert.strictEqual(p, null);
      break;
    case 'challenge_action':
    case 'block_window':
    case 'challenge_block': {
      alive(p.actorId, 'autor da ação');
      if (p.targetId) alive(p.targetId, 'alvo da ação');
      if (g.phase === 'challenge_block') alive(p.blockerId, 'quem bloqueou');
      const eligible = eligibleResponders(g);
      assert.ok(eligible.length > 0, 'janela de resposta sem ninguém elegível');
      eligible.forEach((id) => alive(id, 'jogador elegível'));
      assert.ok(eligible.some((id) => !p.respondedIds.has(id)), 'janela aberta mas todos já responderam');
      break;
    }
    case 'awaiting_loss': {
      const loser = g.getPlayer(p.awaitingLossPlayerId);
      assert.ok(hidden(loser).length >= 2, `pedindo carta de ${loser.name}, que tem ${hidden(loser).length}`);
      break;
    }
    case 'exchange_choice':
      alive(p.actorId, 'quem troca');
      assert.ok(p.options.length >= hidden(g.getPlayer(p.actorId)).length);
      break;
    case 'examine_reveal':
    case 'examine_decision':
      alive(p.actorId, 'Inquisidor');
      alive(p.targetId, 'alvo do Inquisidor');
      break;
    default:
      assert.fail(`fase desconhecida: ${g.phase}`);
  }

  assert.ok(legalMoves(g).length > 0, `jogo travado: nenhuma jogada possível na fase ${g.phase}`);
}

function playGame(seed) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const originalRandom = Math.random;
  Math.random = rand; // embaralhamento e primeiro jogador também reproduzíveis
  const trace = [];
  try {
    const nPlayers = 2 + Math.floor(rand() * 5);
    const mode = rand() < 0.5 ? 'classic' : 'reformation';
    const g = new GameEngine(
      Array.from({ length: nPlayers }, (_, i) => ({ id: `p${i}`, name: `P${i}` })),
      mode,
    );
    trace.push(`modo=${mode} jogadores=${nPlayers}`);
    for (let step = 0; step < MAX_STEPS && g.phase !== 'game_over'; step++) {
      const prevHidden = g.players.map((pl) => hidden(pl).length);
      const prevSig = signature(g);
      const r = rand();
      if (r < 0.01) {
        const quitter = pick(g.activePlayers());
        trace.push(`forfeit(${quitter.id}) na fase ${g.phase}`);
        g.forfeit(quitter.id);
      } else if (r < 0.04) {
        trace.push(`timeout na fase ${g.phase}`);
        g.expireResponseWindow();
        if (signature(g) === prevSig) continue; // nada pendente para expirar
      } else if (r < 0.06) {
        const who = pick(g.players);
        trace.push(`desconexao(${who.id}) na fase ${g.phase}`);
        g.setConnected(who.id, false);
        g.autoResolveForDisconnected(who.id);
        g.setConnected(who.id, true);
        if (signature(g) === prevSig) continue; // não devia nada à mesa
      } else {
        const move = pick(legalMoves(g));
        trace.push(`${move.fn}(${move.args.map((a) => JSON.stringify(a)).join(', ')})`);
        g[move.fn](...move.args); // jogada legal nunca pode ser recusada
      }
      checkInvariants(g, prevHidden, prevSig);
    }
  } catch (err) {
    throw new Error(`seed ${seed}: ${err.message}\nÚltimas jogadas:\n  ${trace.slice(-12).join('\n  ')}`, { cause: err });
  } finally {
    Math.random = originalRandom;
  }
}

test(`fuzz: ${GAMES} partidas aleatórias sem travar nem quebrar regras`, () => {
  for (let seed = 1; seed <= GAMES; seed++) playGame(seed);
});
