const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const io = new Server(server);

// ---------- Persistencia en archivo ----------
const HISTORY_FILE = path.join(__dirname, 'messages.json');
// Estructura en memoria: { [room]: Array<msg> }
let historyByRoom = {};

// Carga historia desde disco
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Asegura estructura
      if (parsed && typeof parsed === 'object') {
        historyByRoom = parsed;
      } else {
        historyByRoom = {};
      }
    } else {
      historyByRoom = {};
    }
  } catch (e) {
    console.error('[HIST] Error leyendo messages.json, iniciando vacío:', e.message);
    historyByRoom = {};
  }
}

// Guarda historia a disco (sincrónico como pide la pista)
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyByRoom, null, 2), 'utf8');
  } catch (e) {
    console.error('[HIST] Error escribiendo messages.json:', e.message);
  }
}

// Añade un mensaje a la sala y persiste (con límite por sala)
const ROOM_HISTORY_LIMIT = 500; // ajusta si quieres
function appendMessage(room, msg) {
  if (!historyByRoom[room]) historyByRoom[room] = [];
  historyByRoom[room].push(msg);
  // recorta para no crecer infinito
  if (historyByRoom[room].length > ROOM_HISTORY_LIMIT) {
    historyByRoom[room] = historyByRoom[room].slice(-ROOM_HISTORY_LIMIT);
  }
  saveHistory();
}

// Reproduce el historial a un socket que se une (sin tocar el cliente)
function replayHistoryToSocket(room, socket) {
  const arr = historyByRoom[room] || [];
  for (const msg of arr) {
    socket.emit('chat message', msg);
  }
}

// Inicializa historial al arrancar
loadHistory();

// ---------- Resto de tu servidor ----------

// Sirve el index
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Helpers de usuarios conectados (global)
function getUserCount() {
  return io.of('/').sockets.size;
}
function broadcastUserCount() {
  io.emit('UserCount', getUserCount());
}

// ---- Utilidad para elegir color ----
function pickColor(raw) {
  const palette = [
    '#e91e63','#9c27b0','#3f51b5','#2196f3','#009688',
    '#4caf50','#ff9800','#795548','#607d8b','#f44336',
    '#673ab7','#03a9f4','#8bc34a','#ffc107','#ff5722'
  ];
  const v = String(raw || '').trim();
  if (!v) return palette[Math.floor(Math.random() * palette.length)];
  return v; // aceptamos hex o nombre CSS; el cliente lo aplicará
}

// --- Helpers de rooms ---
function getRoomCount(room) {
  const r = io.sockets.adapter.rooms.get(room);
  return r ? r.size : 0;
}
function emitRoomCount(room) {
  io.to(room).emit('RoomUserCount', { room, count: getRoomCount(room) });
}

io.on('connection', (socket) => {
  // Estado por socket
  socket.data.username = null;
  socket.data.color = null;
  socket.data.room = null; // se asignará al unirse

  // Conteo global inicial
  socket.emit('UserCount', getUserCount());
  broadcastUserCount();

  // Nombre
  socket.on('set username', (rawName, ack) => {
    let name = String(rawName || '').trim();
    if (!name) return ack && ack({ ok: false, error: 'empty' });
    if (name.length > 24) name = name.slice(0, 24);
    socket.data.username = name;
    ack && ack({ ok: true, username: name });
    // (no avisamos aún de sistema hasta que entre a una sala)
  });

  // Color
  socket.on('set color', (rawColor, ack) => {
    const chosen = pickColor(rawColor);
    socket.data.color = chosen;
    ack && ack({ ok: true, color: chosen });
  });

  // --- ROOMS ---
  function joinRoom(newRoom) {
    const username = socket.data.username || 'Usuario';
    const prev = socket.data.room;

    if (prev && prev !== newRoom) {
      socket.leave(prev);
      // Aviso de salida a la sala anterior (no al propio)
      socket.to(prev).emit('system', { text: `${username} ha salido de #${prev}` });
      emitRoomCount(prev);
    }

    if (!prev || prev !== newRoom) {
      socket.join(newRoom);
      socket.data.room = newRoom;
      // Aviso de entrada a la nueva sala (no al propio)
      socket.to(newRoom).emit('system', { text: `${username} se ha unido a #${newRoom}` });
      // Confirma al propio usuario la unión
      socket.emit('RoomJoined', { room: newRoom });
      emitRoomCount(newRoom);

      // 🔁 Reproducir historial de esa sala solo a este socket
      replayHistoryToSocket(newRoom, socket);
    }
  }

  // Cliente pide unirse a sala
  socket.on('join room', (roomName = 'General', ack) => {
    const name = String(roomName || 'General').trim() || 'General';
    joinRoom(name);
    ack && ack({ ok: true, room: name });
  });

  // Mensajes de chat (solo a la sala actual) + persistencia
  socket.on('chat message', (text, ack) => {
    if (!socket.data.username) {
      return ack && ack({ ok: false, error: 'no-username' });
    }
    const room = socket.data.room || 'General';
    const msg = {
      id: Date.now() + Math.random(),
      user: socket.data.username,
      text: String(text || '').slice(0, 2000),
      ts: Date.now(),
      color: socket.data.color || '#3f51b5',
      room,
    };

    // 1) Emite a la sala
    io.to(room).emit('chat message', msg);
    // 2) Guarda en historial persistente
    appendMessage(room, msg);

    ack && ack({ ok: true });
  });

  // --- Usuario escribiendo: solo a la sala actual ---
  socket.on('typing', () => {
    if (!socket.data.username) return;
    const room = socket.data.room || 'General';
    socket.to(room).emit('typing', { user: socket.data.username, room });
  });
  socket.on('stop typing', () => {
    if (!socket.data.username) return;
    const room = socket.data.room || 'General';
    socket.to(room).emit('stop typing', { user: socket.data.username, room });
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

server.listen(3000, () => {
  console.log('listening on *:3000');
});
