// backend/server.js
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// ===== JWT & Password hashing =====
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ===== Config =====
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const FRONT_DIR = path.join(__dirname, '..', 'frontend');
const HISTORY_FILE = path.join(__dirname, 'messages.json');
const JWT_SECRET = process.env.JWT_SECRET || 'CLASE_SUPER_SECRETA_123'; 
const ROOM_HISTORY_LIMIT = 500;

// ===== Middlewares HTTP =====
app.use(express.static(FRONT_DIR));
app.use(express.json());

// ===== Persistencia de mensajes por sala =====
let historyByRoom = {};
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      historyByRoom = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || {};
    }
  } catch (e) {
    console.error('[HIST] Error al leer messages.json:', e.message);
    historyByRoom = {};
  }
}
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyByRoom, null, 2), 'utf8');
  } catch (e) {
    console.error('[HIST] Error al escribir messages.json:', e.message);
  }
}
function appendMessage(room, msg) {
  if (!historyByRoom[room]) historyByRoom[room] = [];
  historyByRoom[room].push(msg);
  if (historyByRoom[room].length > ROOM_HISTORY_LIMIT) {
    historyByRoom[room] = historyByRoom[room].slice(-ROOM_HISTORY_LIMIT);
  }
  saveHistory();
}
function replayHistoryToSocket(room, socket) {
  (historyByRoom[room] || []).forEach(m => socket.emit('chat message', m));
}
loadHistory();

// ===== “BD” de usuarios (memoria) para la demo =====
const users = new Map(); 

function signToken(payload, opts = {}) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h', ...opts });
}
function authHttp(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'no-token' });
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'token-invalido' });
  }
}

// ===== Endpoints de autenticación =====

// Registro: { username, password }
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!u || !p) return res.status(400).json({ ok: false, error: 'username/password requeridos' });
  if (u.length > 24) return res.status(400).json({ ok: false, error: 'username demasiado largo' });
  if (users.has(u)) return res.status(409).json({ ok: false, error: 'usuario ya existe' });

  const passHash = await bcrypt.hash(p, 10);
  users.set(u, { username: u, passHash });

  const token = signToken({ username: u });
  res.json({ ok: true, token, username: u });
});

// Login: { username, password }
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = String(username || '').trim();
  const p = String(password || '');
  const record = users.get(u);
  if (!record) return res.status(401).json({ ok: false, error: 'credenciales inválidas' });

  const valid = await bcrypt.compare(p, record.passHash);
  if (!valid) return res.status(401).json({ ok: false, error: 'credenciales inválidas' });

  const token = signToken({ username: u });
  res.json({ ok: true, token, username: u });
});

// Ruta protegida de ejemplo
app.get('/api/me', authHttp, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// Sirve el index
app.get('/', (_req, res) => res.sendFile(path.join(FRONT_DIR, 'index.html')));

// ===== Helpers de usuarios/rooms/colores =====
function getUserCount() { return io.of('/').sockets.size; }
function broadcastUserCount() { io.emit('UserCount', getUserCount()); }

function getRoomCount(room) {
  const r = io.sockets.adapter.rooms.get(room);
  return r ? r.size : 0;
}
function emitRoomCount(room) {
  io.to(room).emit('RoomUserCount', { room, count: getRoomCount(room) });
}

function pickColor(raw) {
  const palette = [
    '#e91e63','#9c27b0','#3f51b5','#2196f3','#009688',
    '#4caf50','#ff9800','#795548','#607d8b','#f44336',
    '#673ab7','#03a9f4','#8bc34a','#ffc107','#ff5722'
  ];
  const v = String(raw || '').trim();
  return v || palette[Math.floor(Math.random() * palette.length)];
}

// ===== Autenticación opcional en Socket.IO (JWT en handshake) =====
// Si el cliente conecta con: io({ auth: { token } }), validamos y precargamos username.
// Si no envía token, no rechazamos: tu flujo de 'set username' sigue funcionando.
io.use((socket, next) => {
  try {
    const token = socket.handshake?.auth?.token;
    if (!token) return next(); 
    const payload = jwt.verify(token, JWT_SECRET);
    socket.data.username = payload.username;
    return next();
  } catch (e) {
    return next(new Error('unauthorized: invalid-token'));
  }
});

// ===== Socket.IO =====
io.on('connection', (socket) => {
  socket.data.color = null;
  socket.data.room = null;

  // Conteo global
  socket.emit('UserCount', getUserCount());
  broadcastUserCount();

  // Permitir que el cliente elija nombre si no usó JWT
  socket.on('set username', (rawName, ack) => {
    let name = String(rawName || '').trim();
    if (!name) return ack && ack({ ok: false, error: 'empty' });
    if (name.length > 24) name = name.slice(0, 24);
    socket.data.username = name;
    ack && ack({ ok: true, username: name });
    // (el aviso de sistema se emite cuando entra a una sala)
  });

  // Color
  socket.on('set color', (rawColor, ack) => {
    const chosen = pickColor(rawColor);
    socket.data.color = chosen;
    ack && ack({ ok: true, color: chosen });
  });

  // Join/leave rooms
  function joinRoom(newRoom) {
    const username = socket.data.username || 'Usuario';
    const prev = socket.data.room;

    if (prev && prev !== newRoom) {
      socket.leave(prev);
      socket.to(prev).emit('system', { text: `${username} ha salido de #${prev}` });
      emitRoomCount(prev);
    }

    if (!prev || prev !== newRoom) {
      socket.join(newRoom);
      socket.data.room = newRoom;
      socket.to(newRoom).emit('system', { text: `${username} se ha unido a #${newRoom}` });
      socket.emit('RoomJoined', { room: newRoom });
      emitRoomCount(newRoom);
      replayHistoryToSocket(newRoom, socket); 
    }
  }

  socket.on('join room', (roomName = 'General', ack) => {
    const name = String(roomName || 'General').trim() || 'General';
    joinRoom(name);
    ack && ack({ ok: true, room: name });
  });

  // Chat + persistencia
  socket.on('chat message', (text, ack) => {
    const username = socket.data.username;
    if (!username) return ack && ack({ ok: false, error: 'no-username' });

    const room = socket.data.room || 'General';
    const msg = {
      id: Date.now() + Math.random(),
      user: username,
      text: String(text || '').slice(0, 2000),
      ts: Date.now(),
      color: socket.data.color || '#3f51b5',
      room
    };
    io.to(room).emit('chat message', msg);
    appendMessage(room, msg);
    ack && ack({ ok: true });
  });

  // Typing en sala
  socket.on('typing', () => {
    const username = socket.data.username;
    if (!username) return;
    const room = socket.data.room || 'General';
    socket.to(room).emit('typing', { user: username, room });
  });
  socket.on('stop typing', () => {
    const username = socket.data.username;
    if (!username) return;
    const room = socket.data.room || 'General';
    socket.to(room).emit('stop typing', { user: username, room });
  });

  // Desconexión
  socket.on('disconnect', () => {
    const username = socket.data.username;
    const room = socket.data.room;
    if (username && room) {
      socket.to(room).emit('system', { text: `${username} salió de #${room}` });
      emitRoomCount(room);
    }
    broadcastUserCount();
  });
});

// ===== Start =====
server.listen(3000, () => {
  console.log('✅ Backend listo en http://localhost:3000');
});
