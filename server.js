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
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('lobby_state', { ...state, you: p.token });
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
    broadcastGame(room);
  } else {
    broadcastLobby(room);
  }
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
    if (room.players.length >= 6) return ack && ack({ ok: false, error: 'Sala cheia (máx. 6 jogadores).' });

    const player = rooms.addPlayer(room, playerName, socket.id);
    socket.join(room.code);
    ack && ack({ ok: true, roomCode: room.code, token: player.token });
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
    } else {
      rooms.removePlayer(room, targetToken);
    }

    if (target.socketId) io.to(target.socketId).emit('kicked');
    broadcast(room);
    if (!room.started) rooms.removeRoomIfEmpty(room);
  }));

  socket.on('disconnect', () => {
    const found = rooms.findBySocketId(socket.id);
    if (!found) return;
    const { room, player } = found;
    player.connected = false;
    player.socketId = null;
    if (room.started) room.engine.setConnected(player.token, false);
    else rooms.reassignHostIfNeeded(room);
    broadcast(room);
    rooms.removeRoomIfEmpty(room);

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
