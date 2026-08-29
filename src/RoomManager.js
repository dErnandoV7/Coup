const crypto = require('crypto');
const GameEngine = require('./game/GameEngine');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomCode(length = 4) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = []; // { token, name, socketId, connected }
    this.hostToken = null;
    this.engine = null;
  }

  get started() {
    return this.engine !== null;
  }

  publicLobbyState() {
    return {
      code: this.code,
      hostToken: this.hostToken,
      started: this.started,
      players: this.players.map((p) => ({ token: p.token, name: p.name, connected: p.connected })),
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom() {
    let code;
    do {
      code = randomCode();
    } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  addPlayer(room, name, socketId) {
    const token = crypto.randomUUID();
    const player = { token, name: name.slice(0, 20) || 'Jogador', socketId, connected: true };
    room.players.push(player);
    if (!room.hostToken) room.hostToken = token;
    return player;
  }

  findPlayerByToken(room, token) {
    return room.players.find((p) => p.token === token);
  }

  findBySocketId(socketId) {
    for (const room of this.rooms.values()) {
      const player = room.players.find((p) => p.socketId === socketId);
      if (player) return { room, player };
    }
    return null;
  }

  startGame(room) {
    if (room.players.length < 2) throw new Error('É preciso pelo menos 2 jogadores.');
    room.engine = new GameEngine(room.players.map((p) => ({ id: p.token, name: p.name })));
    return room.engine;
  }

  removeRoomIfEmpty(room) {
    const anyConnected = room.players.some((p) => p.connected);
    if (!anyConnected) this.rooms.delete(room.code);
  }
}

module.exports = { RoomManager, Room };
