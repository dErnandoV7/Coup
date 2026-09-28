const crypto = require('crypto');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./src/RoomManager');
const { MUST_COUP_AT_COINS } = require('./src/game/constants');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new RoomManager();
const DISCONNECT_GRACE_MS = 15000;
const MAX_PLAYERS = 6;
const MAX_JOIN_REQUESTS = 10;

// Static assets (client.js/style.css/index.html) must never be served from a
// stale browser cache — an old cached client talking to a freshly-updated
// server is exactly the kind of thing that can make two players see
// different things for the same game state.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

function broadcastLobby(room) {
  const state = room.publicLobbyState();
  const requests = room.joinRequests.map((r) => ({ id: r.id, name: r.name }));
  for (const p of room.players) {
    if (!p.socketId) continue;
    // Só o anfitrião vê (e decide) os pedidos de entrada.
    io.to(p.socketId).emit('lobby_state', {
      ...state,
      you: p.token,
      joinRequests: p.token === room.hostToken ? requests : [],
    });
  }
}

function broadcastGame(room) {
  for (const p of room.players) {
    if (p.socketId) {
      io.to(p.socketId).emit('game_state', {
        ...room.engine.getStateFor(p.token),
        you: p.token,
        hostToken: room.hostToken,
        chat: room.chat,
        respondBy: room.responseDeadline,
        rematch: room.rematch
          ? { deadline: room.rematch.deadline, votes: [...room.rematch.votes] }
          : null,
      });
    }
  }
}

function broadcast(room) {
  if (room.started) {
    // Must run before broadcastGame: it sets room.responseDeadline for the
    // *current* pending decision, which broadcastGame then reads to tell
    // clients when to stop counting down.
    scheduleResponseTimeout(room);
    scheduleTurnWatchdog(room);
    openRematchIfGameOver(room);
    broadcastGame(room);
  } else {
    broadcastLobby(room);
  }
}

// ---------- Rematch ----------

// Ao fim da partida, abre uma votação de REMATCH_WINDOW_MS para jogar de
// novo. Quem votar (se forem 2 ou mais) começa uma partida nova na mesma
// sala, com o mesmo modo e tempo; quem não votar volta para a tela inicial.
const REMATCH_WINDOW_MS = 10000;
const MIN_PLAYERS = 2;

function rematchCandidates(room) {
  return room.players.filter((p) => p.connected && !p.kicked);
}

function openRematchIfGameOver(room) {
  if (room.rematch || room.engine.phase !== 'game_over') return;
  room.rematch = {
    deadline: Date.now() + REMATCH_WINDOW_MS,
    votes: new Set(),
    timer: setTimeout(() => resolveRematch(room), REMATCH_WINDOW_MS),
  };
}

function resolveRematch(room) {
  const rematch = room.rematch;
  if (!rematch || rematch.resolved) return;
  rematch.resolved = true;
  clearTimeout(rematch.timer);
  if (rooms.getRoom(room.code) !== room) return; // sala já foi removida (todos saíram)

  const voters = room.players.filter((p) => rematch.votes.has(p.token) && p.connected && !p.kicked);
  const enough = voters.length >= MIN_PLAYERS;
  for (const p of room.players) {
    if (enough && voters.includes(p)) continue;
    if (!p.socketId) continue;
    const socket = io.sockets.sockets.get(p.socketId);
    if (socket) socket.leave(room.code);
    io.to(p.socketId).emit('rematch_closed', {
      message: rematch.votes.has(p.token) ? 'Não houve jogadores suficientes para uma nova partida.' : null,
    });
  }

  if (!enough) {
    clearPendingTimeout(room);
    rooms.rooms.delete(room.code);
    return;
  }

  room.players = voters;
  if (!voters.some((p) => p.token === room.hostToken)) room.hostToken = voters[0].token;
  clearPendingTimeout(room);
  room.rematch = null;
  room.engine = null;
  room.chat = [];
  rooms.startGame(room);
  broadcast(room);
}

// ---------- Response time limit ----------

const DECISION_PHASES = new Set([
  'challenge_action', 'block_window', 'challenge_block',
  'awaiting_loss', 'exchange_choice', 'examine_reveal', 'examine_decision',
]);

function pendingFingerprint(room) {
  return `${room.engine.phase}:${room.engine.logSeq}`;
}

function clearPendingTimeout(room) {
  if (room.pendingTimeout) {
    clearTimeout(room.pendingTimeout.timer);
    room.pendingTimeout = null;
  }
  room.responseDeadline = null;
}

// If the host picked a response time limit, force-resolve whoever still owes
// a response once it elapses (same safe defaults used for a disconnected
// player), so nobody can stall the table forever. A running timer for the
// exact same pending decision is left alone — this only (re)schedules when
// the fingerprint actually changes (a genuinely new decision, or the window
// closed entirely).
function scheduleResponseTimeout(room) {
  if (!room.responseTimeoutMs || !DECISION_PHASES.has(room.engine.phase)) {
    clearPendingTimeout(room);
    return;
  }
  const fingerprint = pendingFingerprint(room);
  if (room.pendingTimeout && room.pendingTimeout.fingerprint === fingerprint) return;
  clearPendingTimeout(room);
  room.responseDeadline = Date.now() + room.responseTimeoutMs;
  const timer = setTimeout(() => {
    if (!room.started || pendingFingerprint(room) !== fingerprint) return;
    try {
      room.engine.expireResponseWindow();
    } catch (err) {
      // best-effort: never let the timeout crash the room
    }
    room.pendingTimeout = null;
    room.responseDeadline = null;
    broadcast(room);
  }, room.responseTimeoutMs);
  room.pendingTimeout = { fingerprint, timer };
}

// If it becomes a disconnected player's own turn, nobody else can act for
// them and the game would otherwise hang forever. After a grace period
// (long enough for a quick refresh to reconnect), auto-play the simplest
// legal action on their behalf so the game keeps moving.
function scheduleTurnWatchdog(room) {
  if (room.engine.phase !== 'awaiting_action') return;
  const turnPlayer = room.engine.currentPlayer();
  if (turnPlayer.connected) return;
  const expectedPlayerId = turnPlayer.id;
  setTimeout(() => {
    if (!room.started || room.engine.phase !== 'awaiting_action') return;
    const stillTurnPlayer = room.engine.currentPlayer();
    if (stillTurnPlayer.id !== expectedPlayerId || stillTurnPlayer.connected) return;
    try {
      if (stillTurnPlayer.coins >= MUST_COUP_AT_COINS) {
        const target = room.engine.activePlayers().find((p) => p.id !== expectedPlayerId);
        if (target) room.engine.performAction(expectedPlayerId, 'coup', target.id);
      } else {
        room.engine.performAction(expectedPlayerId, 'income');
      }
    } catch (err) {
      // best-effort: never let the watchdog crash the room
    }
    broadcast(room);
  }, DISCONNECT_GRACE_MS);
}

function sendError(socket, message) {
  socket.emit('error_message', message);
}

// Recusa todos os pedidos de entrada ainda pendentes (partida começou ou sala fechou).
function rejectAllJoinRequests(room, message) {
  for (const r of room.joinRequests) io.to(r.socketId).emit('join_rejected', { message });
  room.joinRequests = [];
}

function cancelJoinRequestsFrom(socketId) {
  for (const room of rooms.removeJoinRequestsBySocket(socketId)) broadcast(room);
}

io.on('connection', (socket) => {
  // Wraps a lobby-phase handler so a malformed/unexpected payload from any
  // one client can never throw uncaught and take the whole server down for
  // every room. Always resolves the ack (if any) so the client never hangs.
  function safeLobbyHandler(handler) {
    return (payload, ack) => {
      try {
        handler(payload && typeof payload === 'object' ? payload : {}, typeof ack === 'function' ? ack : null);
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Ocorreu um erro. Tente novamente.' });
      }
    };
  }

  socket.on('create_room', safeLobbyHandler(({ playerName, mode, responseTimeout }, ack) => {
    const timeoutMs = responseTimeout ? Number(responseTimeout) * 1000 : null;
    const room = rooms.createRoom(mode, timeoutMs);
    const player = rooms.addPlayer(room, playerName, socket.id);
    socket.join(room.code);
    ack && ack({ ok: true, roomCode: room.code, token: player.token });
    broadcast(room);
  }));

  socket.on('join_room', safeLobbyHandler(({ roomCode, playerName }, ack) => {
    const room = rooms.getRoom(roomCode);
    if (!room) return ack && ack({ ok: false, error: 'Sala não encontrada.' });
    if (room.started) return ack && ack({ ok: false, error: 'A partida já começou.' });
    if (room.players.length >= MAX_PLAYERS) return ack && ack({ ok: false, error: 'Sala cheia (máx. 6 jogadores).' });

    // Não entra direto: o pedido vai para o anfitrião aceitar ou recusar.
    cancelJoinRequestsFrom(socket.id);
    if (room.joinRequests.length >= MAX_JOIN_REQUESTS) {
      return ack && ack({ ok: false, error: 'Muitos pedidos pendentes nesta sala. Tente de novo em instantes.' });
    }
    const name = (typeof playerName === 'string' ? playerName : '').trim().slice(0, 20) || 'Jogador';
    room.joinRequests.push({ id: crypto.randomUUID(), name, socketId: socket.id });
    ack && ack({ ok: true, pending: true, roomCode: room.code });
    broadcast(room);
  }));

  socket.on('cancel_join', safeLobbyHandler(() => {
    cancelJoinRequestsFrom(socket.id);
  }));

  socket.on('respond_join', safeLobbyHandler(({ requestId, accept }) => {
    const found = rooms.findBySocketId(socket.id);
    if (!found) return;
    const { room, player } = found;
    if (room.hostToken !== player.token) return sendError(socket, 'Só o anfitrião pode aceitar jogadores.');
    const request = room.joinRequests.find((r) => r.id === requestId);
    if (!request) return; // quem pediu já desistiu ou caiu
    room.joinRequests = room.joinRequests.filter((r) => r !== request);

    const requester = io.sockets.sockets.get(request.socketId);
    if (!requester) return broadcast(room);
    let refusal = null;
    if (!accept) refusal = 'O anfitrião recusou sua entrada na sala.';
    else if (room.started) refusal = 'A partida já começou.';
    else if (room.players.length >= MAX_PLAYERS) refusal = 'Sala cheia (máx. 6 jogadores).';
    if (refusal) {
      requester.emit('join_rejected', { message: refusal });
      return broadcast(room);
    }

    const newPlayer = rooms.addPlayer(room, request.name, request.socketId);
    requester.join(room.code);
    requester.emit('join_accepted', { roomCode: room.code, token: newPlayer.token });
    broadcast(room);
  }));

  socket.on('rejoin', safeLobbyHandler(({ roomCode, token }, ack) => {
    const room = rooms.getRoom(roomCode);
    if (!room) return ack && ack({ ok: false, error: 'Sala não encontrada.' });
    const player = rooms.findPlayerByToken(room, token);
    if (!player) return ack && ack({ ok: false, error: 'Jogador não encontrado nesta sala.' });

    player.socketId = socket.id;
    player.connected = true;
    if (room.started) room.engine.setConnected(player.token, true);
    else rooms.reassignHostIfNeeded(room);
    socket.join(room.code);
    ack && ack({ ok: true, roomCode: room.code, token: player.token, started: room.started });
    broadcast(room);
  }));

  socket.on('start_game', safeLobbyHandler(() => {
    const found = rooms.findBySocketId(socket.id);
    if (!found) return;
    const { room, player } = found;
    if (room.hostToken !== player.token) return sendError(socket, 'Só o anfitrião pode iniciar.');
    try {
      rooms.startGame(room);
      rejectAllJoinRequests(room, 'A partida já começou.');
      broadcast(room);
    } catch (err) {
      sendError(socket, err.message);
    }
  }));

  function withGame(handler) {
    return (payload = {}) => {
      const found = rooms.findBySocketId(socket.id);
      if (!found || !found.room.started) {
        return sendError(socket, 'Você não está mais em uma partida ativa. Recarregue a página.');
      }
      const { room, player } = found;
      try {
        handler(room, player, payload);
        broadcast(room);
        if (room.engine.phase === 'game_over') {
          // final state already broadcast above
        }
      } catch (err) {
        sendError(socket, err.message);
      }
    };
  }

  socket.on('action', withGame((room, player, { action, targetId }) => {
    room.engine.performAction(player.token, action, targetId);
  }));

  socket.on('challenge', withGame((room, player) => {
    room.engine.challenge(player.token);
  }));

  socket.on('block', withGame((room, player, { character }) => {
    room.engine.block(player.token, character);
  }));

  socket.on('pass', withGame((room, player) => {
    room.engine.pass(player.token);
  }));

  socket.on('lose_influence', withGame((room, player, { character }) => {
    room.engine.loseInfluence(player.token, character);
  }));

  socket.on('exchange_choice', withGame((room, player, { keep }) => {
    room.engine.exchangeChoice(player.token, keep);
  }));

  socket.on('forfeit', withGame((room, player) => {
    room.engine.forfeit(player.token);
  }));

  socket.on('choose_examine_card', withGame((room, player, { character }) => {
    room.engine.chooseExamineCard(player.token, character);
  }));

  socket.on('examine_decision', withGame((room, player, { swap }) => {
    room.engine.examineDecision(player.token, !!swap);
  }));

  socket.on('chat_message', withGame((room, player, { text }) => {
    const trimmed = typeof text === 'string' ? text.trim().slice(0, 300) : '';
    if (!trimmed) return;
    room.chat.push({ name: player.name, token: player.token, text: trimmed, ts: Date.now() });
    if (room.chat.length > 50) room.chat.shift();
  }));

  socket.on('rematch_vote', safeLobbyHandler(() => {
    const found = rooms.findBySocketId(socket.id);
    if (!found) return;
    const { room, player } = found;
    const rematch = room.rematch;
    if (!rematch || rematch.resolved || player.kicked) return;
    rematch.votes.add(player.token);
    const everyoneVoted = rematchCandidates(room).every((p) => rematch.votes.has(p.token));
    if (everyoneVoted) resolveRematch(room);
    else broadcast(room);
  }));

  socket.on('kick_player', safeLobbyHandler(({ targetToken }, ack) => {
    const found = rooms.findBySocketId(socket.id);
    if (!found) return;
    const { room, player } = found;
    if (room.hostToken !== player.token) return sendError(socket, 'Só o anfitrião pode remover jogadores.');
    if (targetToken === player.token) return sendError(socket, 'Você não pode remover a si mesmo.');
    const target = rooms.findPlayerByToken(room, targetToken);
    if (!target) return;

    if (room.started) {
      try {
        room.engine.forfeit(targetToken);
      } catch (err) {
        return sendError(socket, err.message);
      }
      target.kicked = true; // continua no elenco da partida, mas não entra na revanche
    } else {
      rooms.removePlayer(room, targetToken);
    }

    if (target.socketId) io.to(target.socketId).emit('kicked');
    broadcast(room);
    if (!room.started && rooms.removeRoomIfEmpty(room)) rejectAllJoinRequests(room, 'A sala foi encerrada.');
  }));

  socket.on('disconnect', () => {
    cancelJoinRequestsFrom(socket.id);
    const found = rooms.findBySocketId(socket.id);
    if (!found) return;
    const { room, player } = found;
    player.connected = false;
    player.socketId = null;
    if (room.started) room.engine.setConnected(player.token, false);
    else rooms.reassignHostIfNeeded(room);
    broadcast(room);
    if (rooms.removeRoomIfEmpty(room)) rejectAllJoinRequests(room, 'A sala foi encerrada.');

    // Give a quick refresh/reconnect a fair chance before treating this as
    // an abandonment: only auto-resolve a pending decision on this player's
    // behalf if they are still disconnected once the grace period elapses.
    if (room.started) {
      const token = player.token;
      setTimeout(() => {
        const stillThere = rooms.findPlayerByToken(room, token);
        if (!stillThere || stillThere.connected || !room.started) return;
        room.engine.autoResolveForDisconnected(token);
        broadcast(room);
      }, DISCONNECT_GRACE_MS);
    }
  });
});

// Last-resort safety net: a single unexpected error from one client/room
// should never take the whole server (and every other room) down with it.
process.on('uncaughtException', (err) => {
  console.error('Erro não tratado (servidor continua rodando):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Rejeição de promise não tratada (servidor continua rodando):', err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Coup server rodando na porta ${PORT}`);
});
