const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./src/RoomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new RoomManager();

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
}

function sendError(socket, message) {
  socket.emit('error_message', message);
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ playerName }, ack) => {
    const room = rooms.createRoom();
    const player = rooms.addPlayer(room, playerName, socket.id);
    socket.join(room.code);
    ack && ack({ ok: true, roomCode: room.code, token: player.token });
    broadcast(room);
  });

  socket.on('join_room', ({ roomCode, playerName }, ack) => {
    const room = rooms.getRoom(roomCode);
    if (!room) return ack && ack({ ok: false, error: 'Sala não encontrada.' });
    if (room.started) return ack && ack({ ok: false, error: 'A partida já começou.' });
    if (room.players.length >= 6) return ack && ack({ ok: false, error: 'Sala cheia (máx. 6 jogadores).' });

    const player = rooms.addPlayer(room, playerName, socket.id);
    socket.join(room.code);
    ack && ack({ ok: true, roomCode: room.code, token: player.token });
    broadcast(room);
  });

  socket.on('rejoin', ({ roomCode, token }, ack) => {
    const room = rooms.getRoom(roomCode);
    if (!room) return ack && ack({ ok: false, error: 'Sala não encontrada.' });
    const player = rooms.findPlayerByToken(room, token);
    if (!player) return ack && ack({ ok: false, error: 'Jogador não encontrado nesta sala.' });

    player.socketId = socket.id;
    player.connected = true;
    if (room.started) room.engine.setConnected(player.token, true);
    socket.join(room.code);
    ack && ack({ ok: true, roomCode: room.code, token: player.token, started: room.started });
    broadcast(room);
  });

  socket.on('start_game', () => {
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
  });

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
    broadcast(room);
    rooms.removeRoomIfEmpty(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Coup server rodando na porta ${PORT}`);
});
