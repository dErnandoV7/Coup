const Deck = require('./Deck');
const {
  ACTIONS,
  CHARACTER_INFO,
  GAME_MODES,
  DEFAULT_MODE,
  MUST_COUP_AT_COINS,
  STARTING_COINS,
  STARTING_INFLUENCE,
  exchangeCharacterForMode,
  blockedByForMode,
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
  constructor(players, mode = DEFAULT_MODE) {
    this.mode = GAME_MODES[mode] ? mode : DEFAULT_MODE;
    this.deck = new Deck(GAME_MODES[this.mode]);
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      coins: STARTING_COINS,
      influence: this.deck.draw(STARTING_INFLUENCE).map((character) => ({ character, revealed: false })),
      connected: true,
    }));
    // Who goes first is random — the host isn't seated first just for
    // having created the room.
    this.turnIndex = Math.floor(Math.random() * this.players.length);
    this.phase = 'awaiting_action'; // awaiting_action | challenge_action | block_window | challenge_block | exchange_choice | awaiting_loss | examine_reveal | examine_decision | game_over
    this.pending = null;
    this.log = [];
    this.winnerId = null;
    this._checkStart();
  }

  // The character currently occupying the "trade with the deck" slot:
  // ambassador in classic mode, inquisitor in reformation mode. Also the
  // character that blocks stealing in place of ambassador.
  _exchangeCharacter() {
    return exchangeCharacterForMode(this.mode);
  }

  _blockedBy(actionName) {
    return blockedByForMode(actionName, this.mode);
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

  // Resolves whatever this player currently owes the table with a safe
  // default (pass / reveal the first available card / keep the first N
  // options / show the first available card / decline to swap) — shared by
  // both the disconnect grace-period path and the room's configured
  // response-time-limit path below, so there's exactly one definition of
  // "what a non-response defaults to" per phase.
  _forceDefaultForPlayer(playerId) {
    if (this.phase === 'game_over' || !this.pending) return;
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
      } else if (this.phase === 'examine_reveal' && this.pending.targetId === playerId) {
        const player = this.getPlayer(playerId);
        const remaining = player.influence.filter((c) => !c.revealed);
        if (remaining.length > 0) this.chooseExamineCard(playerId, remaining[0].character);
      } else if (this.phase === 'examine_decision' && this.pending.actorId === playerId) {
        this.examineDecision(playerId, false);
      }
    } catch (err) {
      // best-effort: never let a forced default crash the room
    }
  }

  // Called by the server after a grace period once a player has been
  // disconnected the whole time, if the game is waiting specifically on
  // their response. A quick refresh/reconnect never reaches this, since the
  // server only calls it if the player is still offline once the grace
  // period elapses.
  autoResolveForDisconnected(playerId) {
    const disconnectedPlayer = this.getPlayer(playerId);
    if (!disconnectedPlayer || disconnectedPlayer.connected) return;
    this._forceDefaultForPlayer(playerId);
  }

  // Called by the server when the room's configured response-time limit
  // elapses for the *current* pending decision. Unlike autoResolveForDisconnected,
  // this applies to anyone still owing a response — connected or not — since
  // it's a table-wide clock, not a per-player disconnect grace period.
  expireResponseWindow() {
    if (this.phase === 'game_over' || !this.pending) return;
    if (this.phase === 'challenge_action' || this.phase === 'block_window' || this.phase === 'challenge_block') {
      const eligible = this.phase === 'block_window'
        ? this._eligibleBlockers(this.pending)
        : this._eligibleChallengers(this.phase === 'challenge_block' ? this.pending.blockerId : this.pending.actorId);
      eligible
        .filter((id) => !this.pending.respondedIds.has(id))
        .forEach((id) => this._forceDefaultForPlayer(id));
    } else if (this.phase === 'awaiting_loss') {
      this._forceDefaultForPlayer(this.pending.awaitingLossPlayerId);
    } else if (this.phase === 'exchange_choice') {
      this._forceDefaultForPlayer(this.pending.actorId);
    } else if (this.phase === 'examine_reveal') {
      this._forceDefaultForPlayer(this.pending.targetId);
    } else if (this.phase === 'examine_decision') {
      this._forceDefaultForPlayer(this.pending.actorId);
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
    if (action.name === 'examine' && this.mode !== 'reformation') throw new Error('Ação inválida.');

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
      claimedCharacter: action.name === 'exchange' ? this._exchangeCharacter() : action.character,
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
    if (!this._blockedBy(this.pending.action).includes(character)) throw new Error('Esse personagem não bloqueia essa ação.');

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
    this._resumeAfterLoss(then);
  }

  _resumeAfterLoss(then) {
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
      case 'examine': {
        const hidden = target.influence.filter((c) => !c.revealed);
        const pendingBase = { action: 'examine', actorId: actor.id, targetId: target.id };
        if (hidden.length <= 1) {
          // Only one possible card: no real choice, skip straight to the
          // inquisitor's decision.
          this.phase = 'examine_decision';
          this.pending = { ...pendingBase, examinedCharacter: hidden[0] ? hidden[0].character : null };
        } else {
          this.phase = 'examine_reveal';
          this.pending = pendingBase;
        }
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

  // ---------- Inquisitor: examine ----------

  // The examined player picks which of their two hidden cards to show the
  // inquisitor (their own choice, same principle as choosing which card to
  // lose) — auto-resolved by _applyEffect already when they only have one.
  chooseExamineCard(playerId, character) {
    this._assertPhase('examine_reveal');
    if (this.pending.targetId !== playerId) throw new Error('Não é sua carta a ser examinada.');
    const player = this.getPlayer(playerId);
    const card = player.influence.find((c) => !c.revealed && c.character === character);
    if (!card) throw new Error('Carta inválida.');
    // Deliberately no public log of which character was shown — only the
    // inquisitor gets to see it, exactly like the physical card handoff.
    this.addLog(`${player.name} mostrou uma carta ao Inquisidor.`);
    this.phase = 'examine_decision';
    this.pending = { ...this.pending, examinedCharacter: character };
  }

  // The inquisitor decides whether to force the examined card to be swapped
  // for a random one from the deck (blind to both players beforehand).
  examineDecision(playerId, swap) {
    this._assertPhase('examine_decision');
    if (this.pending.actorId !== playerId) throw new Error('Não é sua decisão.');
    const inquisitor = this.getPlayer(playerId);
    const target = this.getPlayer(this.pending.targetId);
    const character = this.pending.examinedCharacter;
    const card = character ? target.influence.find((c) => !c.revealed && c.character === character) : null;

    if (swap && card) {
      this.deck.returnCards([card.character]);
      const [replacement] = this.deck.draw(1);
      target.influence = target.influence.filter((c) => c !== card);
      target.influence.push({ character: replacement, revealed: false });
      this.addLog(`${inquisitor.name} forçou ${target.name} a trocar uma carta com o baralho.`);
    } else {
      this.addLog(`${inquisitor.name} decidiu não trocar a carta de ${target.name}.`);
    }
    this._advanceTurn();
  }

  // ---------- Forfeit ----------

  // A player voluntarily leaves the table, exactly like conceding a
  // real-life game: their hand is flipped face-up right away (all
  // remaining influence revealed) and they're out for the rest of the
  // match. Whatever the table was in the middle of doing keeps going in
  // the most realistic way possible: a claim from someone who just quit
  // can't be defended, so it simply doesn't hold up.
  forfeit(playerId) {
    if (this.phase === 'game_over') throw new Error('A partida já terminou.');
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('Jogador não encontrado.');
    if (!this.isAlive(player)) throw new Error('Você já não está na partida.');

    const phase = this.phase;
    const pending = this.pending;
    const originalHidden = player.influence.filter((c) => !c.revealed).map((c) => c.character);

    player.influence.forEach((c) => { c.revealed = true; });
    this.addLog(`${player.name} desistiu da partida e revelou suas cartas.`);

    if (this._checkWin()) return;

    switch (phase) {
      case 'awaiting_action':
        if (!this.isAlive(this.currentPlayer())) this._advanceTurn();
        break;

      case 'challenge_action':
      case 'block_window': {
        if (pending.actorId === playerId || pending.targetId === playerId) {
          this.addLog('A ação foi cancelada.');
          this._advanceTurn();
        } else {
          const eligible = phase === 'block_window'
            ? this._eligibleBlockers(pending)
            : this._eligibleChallengers(pending.actorId);
          const remaining = eligible.filter((id) => !pending.respondedIds.has(id));
          if (remaining.length === 0) this._resolveWindowClear();
        }
        break;
      }

      case 'challenge_block': {
        if (pending.actorId === playerId) {
          this.addLog('A ação foi cancelada.');
          this._advanceTurn();
        } else if (pending.blockerId === playerId) {
          if (pending.targetId === playerId) {
            // Blocker was also the action's target (assassinate/steal) —
            // they're already eliminated, so there's no one left to act on.
            this.addLog('A ação foi cancelada: o alvo desistiu da partida.');
            this._advanceTurn();
          } else {
            // foreign_aid: nothing left to defend the claim, so it collapses.
            this.addLog('O bloqueio caiu, pois quem bloqueou desistiu da partida. A ação prossegue.');
            this._applyEffect(pending);
          }
        } else {
          const eligible = this._eligibleChallengers(pending.blockerId);
          const remaining = eligible.filter((id) => !pending.respondedIds.has(id));
          if (remaining.length === 0) this._resolveWindowClear();
        }
        break;
      }

      case 'awaiting_loss':
        if (pending.awaitingLossPlayerId === playerId) this._resumeAfterLoss(pending.lossThen);
        break;

      case 'exchange_choice':
        if (pending.actorId === playerId) {
          // Only the freshly drawn cards go back to the deck — the
          // player's original hand is already accounted for as revealed.
          const options = [...pending.options];
          for (const character of originalHidden) {
            const idx = options.indexOf(character);
            if (idx !== -1) options.splice(idx, 1);
          }
          this.deck.returnCards(options);
          this._advanceTurn();
        }
        break;

      case 'examine_reveal':
        if (pending.targetId === playerId || pending.actorId === playerId) {
          // Either the examined card is already fully public (target left,
          // everything they had just got revealed above) or there's no one
          // left to receive the private decision (inquisitor left) — either
          // way, nothing private remains to resolve.
          this.addLog('A ação foi cancelada.');
          this._advanceTurn();
        }
        break;

      case 'examine_decision':
        if (pending.actorId === playerId || pending.targetId === playerId) {
          // Inquisitor left before deciding, or the target's whole hand
          // (including the examined card) just became public above — in
          // both cases there's nothing meaningful left to swap.
          this.addLog('A decisão do Inquisidor foi cancelada. Nada foi trocado.');
          this._advanceTurn();
        }
        break;

      default:
        break;
    }
  }

  // ---------- Serialization ----------

  getStateFor(playerId) {
    return {
      phase: this.phase,
      mode: this.mode,
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
    if (this.phase === 'examine_decision' && p.actorId === playerId) {
      out.examinedCharacter = p.examinedCharacter;
    }
    return out;
  }
}

module.exports = GameEngine;
