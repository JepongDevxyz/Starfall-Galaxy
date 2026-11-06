'use strict';
/*
 * Starfall Galaxy — zero-dependency server.
 * - Static file server for public/
 * - Minimal RFC 6455 WebSocket implementation (text frames, ping/pong, close)
 * - Room relay for Online 2P:
 *     host  -> {type:'create'}               => {type:'created', code}
 *     guest -> {type:'join', code}           => {type:'joined', code} / {type:'error', message}
 *     host  -> {type:'state', ...}           => relayed to guest
 *     guest -> {type:'input', ...}           => relayed to host
 *     guest -> {type:'guest-ready'} etc.     => relayed to host (any non-create/join type)
 *     either disconnects                      => other side gets {type:'peer-disconnected'}
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2'
};

// ---------------------------------------------------------------- rooms
const rooms = new Map(); // code -> { host: WSClient|null, guest: WSClient|null }

function makeRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

// ------------------------------------------------------- websocket impl
class WSClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.alive = true;
    this.role = null; // 'host' | 'guest'
    this.roomCode = null;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('end', () => { this.onClose(); try { socket.end(); } catch (_) {} });
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.onClose());
  }

  onData(chunk) {
    try { this._onData(chunk); } catch (_) { try { this.socket.destroy(); } catch (_) {} }
  }
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.parseFrame();
      if (!frame) break;
      const { fin, opcode, payload } = frame;
      if (opcode === 0x8) { // close
        try { this.sendFrame(0x8, Buffer.alloc(0)); } catch (_) {}
        this.socket.end();
        return;
      }
      if (opcode === 0x9) { // ping -> pong
        try { this.sendFrame(0xA, payload); } catch (_) {}
        continue;
      }
      if (opcode === 0xA) continue; // pong
      this.fragments.push(payload);
      if (fin) {
        const msg = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        if (msg) handleMessage(this, msg);
      }
    }
  }

  // Returns one complete frame or null when more bytes are needed.
  parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset); offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset); offset += 8;
      if (big > BigInt(16 * 1024 * 1024)) throw new Error('frame too large');
      len = Number(big);
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.slice(offset, offset + 4); offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.slice(offset, offset + len);
    if (masked && maskKey) {
      const unmasked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }
    this.buffer = buf.slice(offset + len);
    return { fin, opcode, payload };
  }

  sendFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(obj) {
    if (!this.alive) return;
    try { this.sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); } catch (_) {}
  }

  onClose() {
    if (!this.alive) return;
    this.alive = false;
    const code = this.roomCode;
    if (!code || !rooms.has(code)) return;
    const room = rooms.get(code);
    const peer = this.role === 'host' ? room.guest : room.host;
    if (this.role === 'host') room.host = null; else room.guest = null;
    if (peer && peer.alive) peer.send({ type: 'peer-disconnected', role: this.role });
    if (!room.host && !room.guest) rooms.delete(code);
    this.roomCode = null;
  }
}

function handleMessage(client, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'create') {
    const code = makeRoomCode();
    if (!code) { client.send({ type: 'error', message: 'Could not create a room. Try again.' }); return; }
    rooms.set(code, { host: client, guest: null });
    client.role = 'host';
    client.roomCode = code;
    client.send({ type: 'created', code });
    return;
  }

  if (msg.type === 'join') {
    const code = String(msg.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || !room.host) { client.send({ type: 'error', message: 'Room not found. Check the code.' }); return; }
    if (room.guest && room.guest.alive) { client.send({ type: 'error', message: 'That room is already full.' }); return; }
    room.guest = client;
    client.role = 'guest';
    client.roomCode = code;
    client.send({ type: 'joined', code });
    if (room.host.alive) room.host.send({ type: 'guest-joined', code });
    return;
  }

  // Everything else is relayed to the peer in the same room.
  const room = client.roomCode && rooms.get(client.roomCode);
  if (!room) return;
  const peer = client.role === 'host' ? room.guest : room.host;
  if (peer && peer.alive) peer.send(msg);
}

// ------------------------------------------------------------ http part
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    let filePath = decodeURIComponent(url.pathname);
    if (filePath === '/') filePath = '/index.html';
    const resolved = path.normalize(path.join(PUBLIC_DIR, filePath));
    if (!resolved.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        // SPA-ish fallback: unknown paths return index so the menu still loads.
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, index) => {
          if (err2) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(index);
        });
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
      });
      res.end(data);
    });
  } catch (_) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Server error');
  }
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n' +
    '\r\n'
  );
  socket.setNoDelay(true);
  new WSClient(socket);
});

server.listen(PORT, () => {
  console.log('Starfall Galaxy listening on http://localhost:' + PORT);
});
