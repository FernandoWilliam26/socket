const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// Sirve el index
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Helpers de usuarios conectados
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

io.on('connection', (socket) => {
  // Bloquea mensajes hasta que elija nombre
  socket.data.username = null;
  // Color (por defecto ninguno hasta que lo pida/definamos)
  socket.data.color = null;

  // Enviar conteo a todos
  socket.emit('UserCount', getUserCount());
  broadcastUserCount();

  // El cliente propone un nombre
  socket.on('set username', (rawName, ack) => {
    let name = String(rawName || '').trim();
    if (!name) return ack && ack({ ok: false, error: 'empty' });
    if (name.length > 24) name = name.slice(0, 24);

    socket.data.username = name;
    ack && ack({ ok: true, username: name });

    // Aviso de sistema para todos
    io.emit('system', { text: `${name} se ha unido` });
  });

  // El cliente propone (o solicita) color
  socket.on('set color', (rawColor, ack) => {
    const chosen = pickColor(rawColor);
    socket.data.color = chosen;
    ack && ack({ ok: true, color: chosen });
  });

  // Mensajes de chat
  socket.on('chat message', (text, ack) => {
    if (!socket.data.username) {
      return ack && ack({ ok: false, error: 'no-username' });
    }
    const msg = {
      id: Date.now() + Math.random(),
      user: socket.data.username,
      text: String(text || '').slice(0, 2000),
      ts: Date.now(),
      color: socket.data.color || '#3f51b5', // color del usuario (o uno por defecto)
    };
    io.emit('chat message', msg);
    ack && ack({ ok: true });
  });

  socket.on('disconnect', () => {
    if (socket.data.username) {
      io.emit('system', { text: `${socket.data.username} salió` });
    }
    broadcastUserCount();
  });
});

server.listen(3000, () => {
  console.log('listening on *:3000');
});
