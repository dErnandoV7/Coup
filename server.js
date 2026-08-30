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

app.use(express.static(path.join(__dirname, 'public')));

function broadcastLobby(room) {
  const state = room.publicLobbyState();
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('lobby_state', { ...state, you: p.token });
  }
}

function broadcastGame(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('game_state', { ...room.engine.getStateFor(p.token), you: p.token, hostToken: room.hostToken });
  }
}

function broadcast(room) {
  if (room.started) broadcastGame(room);
  else broadcastLobby(room);
  if (room.started) scheduleTurnWatchdog(room);
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

  socket.on('create_room', safeLobbyHandler(({ playerName }, ack) => {
    const room = rooms.createRoom();
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
      if (!found || !found.room.started) return;
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
