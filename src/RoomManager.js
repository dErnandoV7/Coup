const crypto = require('crypto');
const GameEngine = require('./game/GameEngine');
const { GAME_MODES, DEFAULT_MODE } = require('./game/constants');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// Presets the host can pick for how long everyone has to respond to a
// pending decision (challenge/block/lose-influence/etc). null = no limit.
const RESPONSE_TIMEOUT_OPTIONS = [null, 15000, 30000, 60000];

function sanitizeMode(mode) {
  return GAME_MODES[mode] ? mode : DEFAULT_MODE;
}

function sanitizeResponseTimeout(ms) {
  const n = ms === null || ms === undefined ? null : Number(ms);
  return RESPONSE_TIMEOUT_OPTIONS.includes(n) ? n : null;
}

function randomCode(length = 4) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

class Room {
  constructor(code, mode, responseTimeoutMs) {
    this.code = code;
    this.players = []; // { token, name, socketId, connected }
    this.hostToken = null;
    this.engine = null;
    this.mode = sanitizeMode(mode);
    this.responseTimeoutMs = sanitizeResponseTimeout(responseTimeoutMs);
    this.chat = []; // { name, text, ts }, only used once the game has started
    this.pendingTimeout = null; // { fingerprint, timer } — see server.js scheduleResponseTimeout
    this.responseDeadline = null; // epoch ms, sent to clients for a countdown display
    this.joinRequests = []; // { id, name, socketId } — aguardando o anfitrião aceitar
  }

  get started() {
    return this.engine !== null;
  }

  publicLobbyState() {
    return {
      code: this.code,
      hostToken: this.hostToken,
      started: this.started,
      mode: this.mode,
      responseTimeoutMs: this.responseTimeoutMs,
      players: this.players.map((p) => ({ token: p.token, name: p.name, connected: p.connected })),
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(mode, responseTimeoutMs) {
    let code;
    do {
      code = randomCode();
    } while (this.rooms.has(code));
    const room = new Room(code, mode, responseTimeoutMs);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(String(code || '').toUpperCase());
  }

  addPlayer(room, name, socketId) {
    const token = crypto.randomUUID();
    let safeName = (typeof name === 'string' ? name : '').trim().slice(0, 20) || 'Jogador';
    const existingNames = new Set(room.players.map((p) => p.name.toLowerCase()));
    if (existingNames.has(safeName.toLowerCase())) {
      let n = 2;
      while (existingNames.has(`${safeName} (${n})`.toLowerCase())) n++;
      safeName = `${safeName} (${n})`;
    }
    const player = { token, name: safeName, socketId, connected: true };
    room.players.push(player);
    if (!room.hostToken) room.hostToken = token;
    return player;
  }

  // Remove os pedidos de entrada feitos por este socket (desistiu, caiu ou
  // pediu para outra sala). Devolve as salas afetadas, para atualizar o anfitrião.
  removeJoinRequestsBySocket(socketId) {
    const affected = [];
    for (const room of this.rooms.values()) {
      const before = room.joinRequests.length;
      room.joinRequests = room.joinRequests.filter((r) => r.socketId !== socketId);
      if (room.joinRequests.length !== before) affected.push(room);
    }
    return affected;
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

  // Removes a player from a room that hasn't started yet (used when the
  // host kicks someone from the waiting room). Games already in progress
  // never remove a player from the roster — see GameEngine.forfeit, reused
  // for an in-game kick instead.
  removePlayer(room, token) {
    if (room.started) return null;
    const idx = room.players.findIndex((p) => p.token === token);
    if (idx === -1) return null;
    const [removed] = room.players.splice(idx, 1);
    this.reassignHostIfNeeded(room);
    return removed;
  }

  reassignHostIfNeeded(room) {
    if (room.started) return;
    const currentHost = room.players.find((p) => p.token === room.hostToken);
    if (currentHost && currentHost.connected) return;
    const nextHost = room.players.find((p) => p.connected);
    room.hostToken = nextHost ? nextHost.token : room.hostToken;
  }

  startGame(room) {
    if (room.started) return room.engine;
    if (room.players.length < 2) throw new Error('É preciso pelo menos 2 jogadores.');
    room.engine = new GameEngine(room.players.map((p) => ({ id: p.token, name: p.name })), room.mode);
    return room.engine;
  }

  // Devolve true se a sala foi removida.
  removeRoomIfEmpty(room) {
    const anyConnected = room.players.some((p) => p.connected);
    if (!anyConnected) this.rooms.delete(room.code);
    return !anyConnected;
  }
}

module.exports = { RoomManager, Room, RESPONSE_TIMEOUT_OPTIONS };
