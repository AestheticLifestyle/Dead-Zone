const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// Game rooms: Map<roomCode, roomState>
// ─────────────────────────────────────────────
const rooms = new Map();

function makeRoom(hostId, hostName) {
  return {
    host:      hostId,
    started:   false,
    selectedMap: 'farm',
    players: {
      [hostId]: { id: hostId, name: hostName, color: 0, ready: false,
                  pos: {x:0,y:0,z:0}, rot: 0, health: 100,
                  alive: true, downed: false, gun: 'pistol', knifeActive: false }
    }
  };
}

const COLORS = [0xff4444, 0x44aaff, 0xffcc00, 0x44ff88];
const SPAWNS = [
  {x:  4, y:0, z:  4},
  {x: -4, y:0, z:  4},
  {x:  4, y:0, z: -4},
  {x: -4, y:0, z: -4},
];

function roomPlayers(room) { return Object.values(room.players); }
function roomFull(room)    { return roomPlayers(room).length >= 4; }

// ─────────────────────────────────────────────
// Socket events
// ─────────────────────────────────────────────
io.on('connection', socket => {

  // ── Create room ──────────────────────────────
  socket.on('create_room', ({ name }, cb) => {
    const code = Math.random().toString(36).slice(2,6).toUpperCase();
    const room = makeRoom(socket.id, name);
    room.players[socket.id].color = 0;
    room.players[socket.id].spawnIdx = 0;
    rooms.set(code, room);
    socket.join(code);
    socket.data.room = code;
    socket.data.name = name;
    cb({ ok: true, code, players: roomPlayers(room), colorIdx: 0, spawnIdx: 0 });
  });

  // ── Join room ────────────────────────────────
  socket.on('join_room', ({ code, name }, cb) => {
    const room = rooms.get(code.toUpperCase());
    if (!room)          return cb({ ok: false, err: 'Room not found.' });
    if (room.started)   return cb({ ok: false, err: 'Game already started.' });
    if (roomFull(room)) return cb({ ok: false, err: 'Room is full (max 4 players).' });

    const idx = roomPlayers(room).length;
    room.players[socket.id] = {
      id: socket.id, name, color: idx, ready: false,
      pos: {...SPAWNS[idx]}, rot: 0, health: 100,
      alive: true, downed: false, gun: 'pistol', knifeActive: false,
      spawnIdx: idx
    };

    socket.join(code.toUpperCase());
    socket.data.room = code.toUpperCase();
    socket.data.name = name;

    // Tell everyone in room about the new player
    socket.to(code.toUpperCase()).emit('player_joined', room.players[socket.id]);

    cb({ ok: true, code: code.toUpperCase(), players: roomPlayers(room),
         colorIdx: idx, spawnIdx: idx, mapId: room.selectedMap });
  });

  // ── Host changes map ────────────────────────
  socket.on('set_map', ({ mapId }) => {
    const room = rooms.get(socket.data.room);
    if (!room || room.host !== socket.id) return;
    room.selectedMap = mapId;
    socket.to(socket.data.room).emit('map_changed', { mapId });
  });

  // ── Player ready toggle ──────────────────────
  socket.on('set_ready', ({ ready }) => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].ready = ready;
    io.to(socket.data.room).emit('lobby_update', roomPlayers(room));

    // Auto-start when ALL players ready (min 1)
    const all = roomPlayers(room);
    if (all.length >= 1 && all.every(p => p.ready)) {
      room.started = true;
      io.to(socket.data.room).emit('game_start', {
        players: roomPlayers(room),
        mapId: room.selectedMap
      });
    }
  });

  // ── Player state broadcast (position, health, gun) ──
  socket.on('player_update', data => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.players[socket.id]) return;
    Object.assign(room.players[socket.id], data);
    // Relay to everyone else in the room
    socket.to(socket.data.room).emit('player_update', { id: socket.id, ...data });
  });

  // ── Zombie state — host is authoritative ────
  socket.on('zombie_update', data => {
    const room = rooms.get(socket.data.room);
    if (!room || room.host !== socket.id) return;
    socket.to(socket.data.room).emit('zombie_update', data);
  });

  // ── Wave event from host ─────────────────────
  socket.on('wave_event', data => {
    const room = rooms.get(socket.data.room);
    if (!room || room.host !== socket.id) return;
    socket.to(socket.data.room).emit('wave_event', data);
  });

  // ── Bullet / hit events (broadcast to all) ───
  socket.on('bullet_hit', data => {
    socket.to(socket.data.room).emit('bullet_hit', { ...data, from: socket.id });
  });

  // ── Host tells a client they got hit by a zombie ──
  socket.on('zombie_melee_hit', ({ targetId, dmg }) => {
    const room = rooms.get(socket.data.room);
    if (!room || room.host !== socket.id) return; // only host can send this
    io.to(targetId).emit('zombie_melee_hit', { dmg });
  });

  // ── Client hit a zombie — relay to host for authoritative damage ──
  socket.on('client_zombie_hit', data => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    // Forward to host only
    io.to(room.host).emit('client_zombie_hit', { ...data, from: socket.id });
  });

  // ── Player downed (health reached 0 in multiplayer) ──
  socket.on('player_downed', () => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].downed = true;
    io.to(socket.data.room).emit('player_downed', { id: socket.id, name: socket.data.name });

    // Game over when ALL players are downed or dead
    if (roomPlayers(room).every(p => p.downed || !p.alive)) {
      io.to(socket.data.room).emit('game_over_all');
    }
  });

  // ── Player bled out (downed timer expired) ──
  socket.on('player_died', () => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].alive = false;
    room.players[socket.id].downed = false;
    io.to(socket.data.room).emit('player_died', { id: socket.id });

    // Game over when all dead or downed
    if (roomPlayers(room).every(p => p.downed || !p.alive)) {
      io.to(socket.data.room).emit('game_over_all');
    }
  });

  // ── Player revived by a teammate ──
  socket.on('player_revived', ({ targetId }) => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.players[targetId]) return;
    room.players[targetId].downed = false;
    room.players[targetId].alive = true;
    room.players[targetId].health = 30; // revive with 30 HP
    io.to(socket.data.room).emit('player_revived', {
      id: targetId,
      reviverId: socket.id,
      reviverName: socket.data.name,
      targetName: room.players[targetId].name
    });
  });

  // ── Chat / feed message ──────────────────────
  socket.on('feed_msg', ({ text }) => {
    io.to(socket.data.room).emit('feed_msg', { name: socket.data.name, text });
  });

  // ── Disconnect ───────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.room;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    delete room.players[socket.id];
    io.to(code).emit('player_left', { id: socket.id });
    if (Object.keys(room.players).length === 0) {
      rooms.delete(code);
    } else if (room.host === socket.id) {
      // Pass host to next player
      room.host = Object.keys(room.players)[0];
      io.to(code).emit('host_changed', { id: room.host });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Game server running on port ${PORT}`);
});

module.exports = server;
