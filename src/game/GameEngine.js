const Deck = require('./Deck');
const {
  ACTIONS,
  CHARACTER_INFO,
  MUST_COUP_AT_COINS,
  STARTING_COINS,
  STARTING_INFLUENCE,
} = require('./constants');

function charName(character) {
  return (CHARACTER_INFO[character] && CHARACTER_INFO[character].name) || character;
}

/**
 * Pure game-state machine for Coup. Knows nothing about sockets/rooms.
 * `players` is an array of {id, name} in turn order, id being the stable
 * player token (not the socket id, so refresh/reconnect keeps identity).
 */
class GameEngine {
  constructor(players) {
    this.deck = new Deck();
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      coins: STARTING_COINS,
      influence: this.deck.draw(STARTING_INFLUENCE).map((character) => ({ character, revealed: false })),
      connected: true,
    }));
    this.turnIndex = 0;
    this.phase = 'awaiting_action'; // awaiting_action | challenge_action | block_window | challenge_block | exchange_choice | awaiting_loss | game_over
    this.pending = null;
    this.log = [];
    this.winnerId = null;
    this._checkStart();
  }

  _checkStart() {
    this.addLog(`${this.currentPlayer().name} começa a partida.`);
  }

  addLog(text) {
    this.log.push({ text, ts: Date.now() });
    if (this.log.length > 200) this.log.shift();
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  setConnected(id, connected) {
    const player = this.getPlayer(id);
    if (player) player.connected = connected;
  }

  // Called by the server after a grace period once a player has been
  // disconnected the whole time, if the game is waiting specifically on
  // their response (challenge/block window, or a decision only they can
  // make). Resolves it on their behalf so the round doesn't hang forever
  // waiting for someone who left. A quick refresh/reconnect never reaches
  // this, since the server only calls it if the player is still offline
  // once the grace period elapses.
  autoResolveForDisconnected(playerId) {
    if (this.phase === 'game_over' || !this.pending) return;
    const disconnectedPlayer = this.getPlayer(playerId);
    if (!disconnectedPlayer || disconnectedPlayer.connected) return;
    try {
      if (this.phase === 'challenge_action' || this.phase === 'block_window' || this.phase === 'challenge_block') {
        const eligible = this.phase === 'block_window'
          ? this._eligibleBlockers(this.pending)
          : this._eligibleChallengers(this.phase === 'challenge_block' ? this.pending.blockerId : this.pending.actorId);
        if (eligible.includes(playerId) && !this.pending.respondedIds.has(playerId)) {
          this.pass(playerId);
        }
      } else if (this.phase === 'awaiting_loss' && this.pending.awaitingLossPlayerId === playerId) {
        const player = this.getPlayer(playerId);
        const remaining = player.influence.filter((c) => !c.revealed);
        if (remaining.length > 0) this.loseInfluence(playerId, remaining[0].character);
      } else if (this.phase === 'exchange_choice' && this.pending.actorId === playerId) {
        const keepCount = this.getPlayer(playerId).influence.filter((c) => !c.revealed).length;
        this.exchangeChoice(playerId, this.pending.options.slice(0, keepCount));
      }
    } catch (err) {
      // best-effort: never let cleanup on disconnect crash the room
    }
  }

  currentPlayer() {
    return this.players[this.turnIndex];
  }

  activePlayers() {
    return this.players.filter((p) => this.aliveCount(p) > 0);
  }

  aliveCount(player) {
    return player.influence.filter((c) => !c.revealed).length;
  }

  isAlive(player) {
    return this.aliveCount(player) > 0;
  }

  // ---------- Turn management ----------

  _advanceTurn() {
    if (this._checkWin()) return;
    do {
      this.turnIndex = (this.turnIndex + 1) % this.players.length;
    } while (!this.isAlive(this.players[this.turnIndex]));
    this.phase = 'awaiting_action';
    this.pending = null;
    this.addLog(`Vez de ${this.currentPlayer().name}.`);
  }

  _checkWin() {
    const alive = this.activePlayers();
    if (alive.length <= 1) {
      this.phase = 'game_over';
      this.winnerId = alive[0] ? alive[0].id : null;
      this.pending = null;
      if (this.winnerId) {
        this.addLog(`${this.getPlayer(this.winnerId).name} venceu a partida!`);
      }
      return true;
    }
    return false;
  }

  // ---------- Action declaration ----------

  performAction(actorId, actionName, targetId) {
    this._assertPhase('awaiting_action');
    const actor = this.currentPlayer();
    if (actor.id !== actorId) throw new Error('Não é sua vez.');

    const action = ACTIONS[actionName];
    if (!action) throw new Error('Ação inválida.');

    if (actor.coins >= MUST_COUP_AT_COINS && action.name !== 'coup') {
      throw new Error('Com 10 ou mais moedas você é obrigado a dar Golpe de Estado.');
    }
    if (actor.coins < action.cost) throw new Error('Moedas insuficientes.');

    let target = null;
    if (action.requiresTarget) {
      target = this.getPlayer(targetId);
      if (!target || !this.isAlive(target) || target.id === actor.id) {
        throw new Error('Alvo inválido.');
      }
    }

    actor.coins -= action.cost;

    const base = {
      action: action.name,
      actorId: actor.id,
      targetId: target ? target.id : null,
      claimedCharacter: action.character,
    };

    const targetLabel = target ? ` em ${target.name}` : '';
    this.addLog(`${actor.name} usou ${action.label}${targetLabel}.`);

    if (action.challengeable) {
      this._openWindow('challenge_action', { ...base, respondedIds: new Set() });
    } else if (action.blockable) {
      this._openBlockWindow(base);
    } else {
      this._applyEffect(base);
    }
  }

  _eligibleChallengers(claimantId) {
    return this.activePlayers().filter((p) => p.id !== claimantId).map((p) => p.id);
  }

  _eligibleBlockers(base) {
    const action = ACTIONS[base.action];
    if (action.name === 'foreign_aid') {
      return this.activePlayers().filter((p) => p.id !== base.actorId).map((p) => p.id);
    }
    return [base.targetId];
  }

  _openWindow(phase, pending) {
    this.phase = phase;
    this.pending = pending;
  }

  _openBlockWindow(base) {
    this._openWindow('block_window', { ...base, respondedIds: new Set() });
  }

  _assertPhase(...phases) {
    if (!phases.includes(this.phase)) throw new Error('Ação não permitida neste momento.');
  }

  // ---------- Responses: pass / challenge / block ----------

  pass(playerId) {
    this._assertPhase('challenge_action', 'block_window', 'challenge_block');
    const eligible = this.phase === 'block_window'
      ? this._eligibleBlockers(this.pending)
      : this._eligibleChallengers(this.phase === 'challenge_block' ? this.pending.blockerId : this.pending.actorId);

    if (!eligible.includes(playerId)) throw new Error('Você não pode responder agora.');
    this.pending.respondedIds.add(playerId);

    const remaining = eligible.filter((id) => !this.pending.respondedIds.has(id));
    if (remaining.length === 0) {
      this._resolveWindowClear();
    }
  }

  _resolveWindowClear() {
    if (this.phase === 'challenge_action') {
      const action = ACTIONS[this.pending.action];
      if (action.blockable) {
        this._openBlockWindow(this.pending);
      } else {
        this._applyEffect(this.pending);
      }
    } else if (this.phase === 'block_window') {
      this.addLog('Ninguém bloqueou. A ação prossegue.');
      this._applyEffect(this.pending);
    } else if (this.phase === 'challenge_block') {
      const blocker = this.getPlayer(this.pending.blockerId);
      this.addLog(`Ninguém desafiou o bloqueio de ${blocker.name}. A ação foi bloqueada.`);
      this._advanceTurn();
    }
  }

  block(playerId, character) {
    this._assertPhase('block_window');
    const eligible = this._eligibleBlockers(this.pending);
    if (!eligible.includes(playerId)) throw new Error('Você não pode bloquear esta ação.');
    const action = ACTIONS[this.pending.action];
    if (!action.blockedBy.includes(character)) throw new Error('Esse personagem não bloqueia essa ação.');

    const blocker = this.getPlayer(playerId);
    this.addLog(`${blocker.name} bloqueou alegando ser ${charName(character)}.`);

    this.pending = {
      ...this.pending,
      blockerId: playerId,
      blockCharacter: character,
      respondedIds: new Set(),
    };
    this.phase = 'challenge_block';
  }

  challenge(challengerId) {
    this._assertPhase('challenge_action', 'challenge_block');
    const isBlockChallenge = this.phase === 'challenge_block';
    const claimantId = isBlockChallenge ? this.pending.blockerId : this.pending.actorId;
    const claimedCharacter = isBlockChallenge ? this.pending.blockCharacter : this.pending.claimedCharacter;

    if (challengerId === claimantId) throw new Error('Você não pode desafiar a si mesmo.');
    const eligible = this._eligibleChallengers(claimantId);
    if (!eligible.includes(challengerId)) throw new Error('Você não pode desafiar agora.');

    const claimant = this.getPlayer(claimantId);
    const challenger = this.getPlayer(challengerId);
    const hasCard = claimant.influence.some((c) => !c.revealed && c.character === claimedCharacter);

    this.addLog(`${challenger.name} desafiou ${claimant.name} (alegava ${charName(claimedCharacter)}).`);

    if (hasCard) {
      // Claimant proven honest: reveal+replace that card, challenger loses influence.
      const card = claimant.influence.find((c) => !c.revealed && c.character === claimedCharacter);
      card.revealed = true;
      this.deck.returnCards([card.character]);
      const [replacement] = this.deck.draw(1);
      claimant.influence = claimant.influence.filter((c) => c !== card);
      claimant.influence.push({ character: replacement, revealed: false });
      // un-reveal conceptually: claimant keeps same influence count, card swapped for a hidden one
      claimant.influence[claimant.influence.length - 1].revealed = false;

      this.addLog(`${claimant.name} realmente tinha ${charName(claimedCharacter)}. Carta trocada no baralho.`);
      this._queueLoss(challengerId, isBlockChallenge
        ? { type: 'block_stands' }
        : { type: 'action_challenge_survived' });
    } else {
      this.addLog(`${claimant.name} estava blefando!`);
      this._queueLoss(claimantId, isBlockChallenge
        ? { type: 'block_fails' }
        : { type: 'action_fails' });
    }
  }

  // ---------- Influence loss ----------

  _queueLoss(playerId, then) {
    const player = this.getPlayer(playerId);
    const remaining = player.influence.filter((c) => !c.revealed);
    if (remaining.length === 1) {
      // Only one possible card: auto-resolve, no need to ask the player.
      this._continueAfterLoss(playerId, remaining[0].character, then);
      return;
    }
    this.phase = 'awaiting_loss';
    this.pending = { ...this.pending, awaitingLossPlayerId: playerId, lossThen: then };
  }

  loseInfluence(playerId, character) {
    this._assertPhase('awaiting_loss');
    if (this.pending.awaitingLossPlayerId !== playerId) throw new Error('Não é sua perda de influência.');
    const player = this.getPlayer(playerId);
    const card = player.influence.find((c) => !c.revealed && c.character === character);
    if (!card) throw new Error('Carta inválida.');
    const then = this.pending.lossThen;
    this._continueAfterLoss(playerId, character, then);
  }

  _continueAfterLoss(playerId, character, then) {
    const player = this.getPlayer(playerId);
    const card = player.influence.find((c) => !c.revealed && c.character === character);
    card.revealed = true;
    this.addLog(`${player.name} perdeu a influência: ${charName(character)}.`);

    if (this._checkWin()) return;

    switch (then.type) {
      case 'target_hit':
        this._advanceTurn();
        break;
      case 'action_challenge_survived': {
        const action = ACTIONS[this.pending.action];
        if (action.blockable) {
          this._openBlockWindow(this.pending);
        } else {
          this._applyEffect(this.pending);
        }
        break;
      }
      case 'action_fails':
        this.addLog('A ação foi cancelada.');
        this._advanceTurn();
        break;
      case 'block_stands':
        this.addLog('O bloqueio se mantém. A ação foi cancelada.');
        this._advanceTurn();
        break;
      case 'block_fails':
        this.addLog('O bloqueio falhou. A ação prossegue.');
        this._applyEffect(this.pending);
        break;
      default:
        this._advanceTurn();
    }
  }

  // ---------- Effects ----------

  _applyEffect(base) {
    const action = ACTIONS[base.action];
    const actor = this.getPlayer(base.actorId);
    const target = base.targetId ? this.getPlayer(base.targetId) : null;

    switch (action.name) {
      case 'income':
      case 'foreign_aid':
      case 'tax':
        actor.coins += action.coinGain;
        this._advanceTurn();
        break;
      case 'steal': {
        const amount = Math.min(2, target.coins);
        target.coins -= amount;
        actor.coins += amount;
        this.addLog(`${actor.name} roubou ${amount} moeda(s) de ${target.name}.`);
        this._advanceTurn();
        break;
      }
      case 'coup':
      case 'assassinate':
        this._queueLoss(target.id, { type: 'target_hit' });
        break;
      case 'exchange': {
        const drawn = this.deck.draw(2);
        this.phase = 'exchange_choice';
        this.pending = {
          action: 'exchange',
          actorId: actor.id,
          options: [...actor.influence.filter((c) => !c.revealed).map((c) => c.character), ...drawn],
        };
        break;
      }
      default:
        this._advanceTurn();
    }
  }

  exchangeChoice(playerId, keepCharacters) {
    this._assertPhase('exchange_choice');
    if (this.pending.actorId !== playerId) throw new Error('Não é sua troca.');
    const actor = this.getPlayer(playerId);
    const keepCount = actor.influence.filter((c) => !c.revealed).length;
    if (keepCharacters.length !== keepCount) throw new Error('Quantidade de cartas inválida.');

    const options = [...this.pending.options];
    for (const character of keepCharacters) {
      const idx = options.indexOf(character);
      if (idx === -1) throw new Error('Carta escolhida não disponível.');
      options.splice(idx, 1);
    }
    // options now holds the leftover cards to return to the deck.
    this.deck.returnCards(options);

    const revealed = actor.influence.filter((c) => c.revealed);
    actor.influence = [
      ...revealed,
      ...keepCharacters.map((character) => ({ character, revealed: false })),
    ];

    this.addLog(`${actor.name} trocou cartas com o baralho.`);
    this._advanceTurn();
  }

  // ---------- Serialization ----------

  getStateFor(playerId) {
    return {
      phase: this.phase,
      turnPlayerId: this.currentPlayer().id,
      winnerId: this.winnerId,
      log: this.log.slice(-40),
      pending: this._publicPending(playerId),
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        coins: p.coins,
        connected: p.connected,
        alive: this.isAlive(p),
        influenceCount: this.aliveCount(p),
        revealedCards: p.influence.filter((c) => c.revealed).map((c) => c.character),
        cards: p.id === playerId
          ? p.influence.map((c) => ({ character: c.character, revealed: c.revealed }))
          : undefined,
      })),
    };
  }

  _publicPending(playerId) {
    if (!this.pending) return null;
    const p = this.pending;
    const out = {
      action: p.action,
      actorId: p.actorId,
      targetId: p.targetId ?? null,
      claimedCharacter: p.claimedCharacter,
      blockerId: p.blockerId ?? null,
      blockCharacter: p.blockCharacter ?? null,
    };
    if (this.phase === 'challenge_action' || this.phase === 'block_window' || this.phase === 'challenge_block') {
      out.respondedIds = Array.from(p.respondedIds || []);
      out.eligibleIds = this.phase === 'block_window'
        ? this._eligibleBlockers(p)
        : this._eligibleChallengers(this.phase === 'challenge_block' ? p.blockerId : p.actorId);
    }
    if (this.phase === 'awaiting_loss') {
      out.awaitingLossPlayerId = p.awaitingLossPlayerId;
    }
    if (this.phase === 'exchange_choice' && p.actorId === playerId) {
      out.options = p.options;
      out.keepCount = this.getPlayer(playerId).influence.filter((c) => !c.revealed).length;
    }
    return out;
  }
}

module.exports = GameEngine;
