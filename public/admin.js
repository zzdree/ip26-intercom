/* eslint-disable */
/**
 * IP26-Intercom — Admin Dashboard
 * ------------------------------------------------------------------
 * WebSocket sebagai observer: terima broadcast presence + PTT state
 * dari server. Tidak perlu register karena admin = listener only.
 *
 * Kontrol: refresh peer list, kick peer, broadcast system message.
 * QR Code sharing via qrcodejs (CDN).
 * ------------------------------------------------------------------
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const ui = {
  statConn: $('#statConn'),
  statConnText: $('#statConnText'),
  statCount: $('#statCount'),
  statSpeak: $('#statSpeak'),
  peerCount: $('#peerCount'),
  peerGrid: $('#peerGrid'),
  speakerNow: $('#speakerNow'),
  speakerNowName: $('#speakerNowName'),
  speakerNowRole: $('#speakerNowRole'),
  logList: $('#logList'),
  broadcastForm: $('#broadcastForm'),
  broadcastText: $('#broadcastText'),
  refreshBtn: $('#refreshBtn'),
  clearLogBtn: $('#clearLogBtn'),
  toastStack: $('#toastStack'),
  // QR Share UI
  shareCard: $('#shareCard'),
  intercomUrlInput: $('#intercomUrlInput'),
  adminUrlInput: $('#adminUrlInput'),
  copyIntercomBtn: $('#copyIntercomBtn'),
  copyAdminBtn: $('#copyAdminBtn'),
  qrIntercomBtn: $('#qrIntercomBtn'),
  qrAdminBtn: $('#qrAdminBtn'),
  qrPreview: $('#qrPreview'),
  qrTitle: $('#qrTitle'),
  qrCanvas: $('#qrCanvas'),
  closeQrBtn: $('#closeQrBtn'),
  fullscreenQrBtn: $('#fullscreenQrBtn'),
  downloadQrBtn: $('#downloadQrBtn'),
  // Fullscreen QR Modal
  fullscreenQrModal: $('#fullscreenQrModal'),
  fullscreenQrTitle: $('#fullscreenQrTitle'),
  fullscreenQrCanvas: $('#fullscreenQrCanvas'),
  closeFullscreenQrBtn: $('#closeFullscreenQrBtn'),
  closeFullscreenQrBtn2: $('#closeFullscreenQrBtn2'),
  downloadFullscreenQrBtn: $('#downloadFullscreenQrBtn')
};

const state = {
  ws: null,
  connected: false,
  currentSpeaker: null,
  peers: new Map(),
  // QR state
  currentQrUrl: null,
  currentQrTitle: null,
  qrCodeLibLoaded: false
};

// ============================================================================
// QR CODE LIBRARY LOADER (qrcodejs via CDN)
// ============================================================================

function loadQrCodeLibrary() {
  if (state.qrCodeLibLoaded || window.QRCode) {
    state.qrCodeLibLoaded = true;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js';
    script.onload = () => {
      state.qrCodeLibLoaded = true;
      console.log('[admin] qrcodejs loaded from CDN');
      resolve();
    };
    script.onerror = () => {
      console.error('[admin] Failed to load qrcodejs from CDN');
      reject(new Error('QR library load failed'));
    };
    document.head.appendChild(script);
  });
}

// Generate QR code using qrcodejs
function generateQrCode(text, canvas, size = 256) {
  if (!window.QRCode) {
    console.warn('[admin] QRCode not loaded yet');
    return;
  }
  // Clear canvas first
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // qrcodejs writes to a div, so we create a temporary div
  const tempDiv = document.createElement('div');
  new window.QRCode(tempDiv, {
    text: text,
    width: size,
    height: size,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: window.QRCode.CorrectLevel.M
  });
  // Copy from tempDiv's canvas to our canvas
  const tempCanvas = tempDiv.querySelector('canvas');
  if (tempCanvas) {
    canvas.width = size;
    canvas.height = size;
    ctx.drawImage(tempCanvas, 0, 0, size, size);
  }
}

// ============================================================================
// WEBSOCKET
// ============================================================================

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${proto}://${location.host}/ws`;

  console.log('[admin] connecting to', wsUrl);
  state.ws = new WebSocket(wsUrl);

  state.ws.addEventListener('open', () => {
    state.connected = true;
    ui.statConn.classList.add('online');
    ui.statConnText.textContent = 'Terhubung';
    addLog('system', 'Tersambung ke server');
  });

  state.ws.addEventListener('close', () => {
    state.connected = false;
    ui.statConn.classList.remove('online');
    ui.statConnText.textContent = 'Terputus — mencoba lagi...';
    addLog('system', 'Koneksi terputus, retry dalam 2 detik');
    setTimeout(connectWS, 2000);
  });

  state.ws.addEventListener('error', () => {
    addLog('system', 'Error koneksi WebSocket');
  });

  state.ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch (e) { console.warn('invalid JSON from server', ev.data); return; }
    handleMessage(msg);
  });
}

function handleMessage(msg) {
  switch (msg.type) {

    case 'hello':
      console.log('[admin] server hello, my observer id:', msg.id);
      break;

    case 'presence':
      state.peers.clear();
      for (const p of msg.users) {
        state.peers.set(p.id, p);
      }
      renderPeers();
      renderCount();
      // Jika yang sedang bicara ada, sinkronkan
      const stillSpeaking = Array.from(state.peers.values()).find(p => p.speaking);
      if (!stillSpeaking && state.currentSpeaker) {
        setCurrentSpeaker(null);
      }
      break;

    case 'ptt-state':
      if (msg.state === 'on') {
        setCurrentSpeaker({ id: msg.from, name: msg.fromName, role: msg.fromRole });
        addLog('speak', `${msg.fromName} (${msg.fromRole}) mulai bicara`);
      } else {
        if (state.currentSpeaker?.id === msg.from) {
          setCurrentSpeaker(null);
        }
        addLog('silence', `${msg.fromName} selesai bicara`);
      }
      break;

    case 'system':
      toast(`📣 ${msg.text}`);
      addLog('system', `Broadcast: ${msg.text}`);
      break;

    case 'kicked':
      break;

    case 'server-shutdown':
      toast('⚠️ Server akan shutdown');
      break;

    default:
      console.log('[admin] unknown message', msg);
  }
}

// ============================================================================
// RENDER
// ============================================================================

function renderCount() {
  const n = state.peers.size;
  ui.statCount.textContent = n;
  ui.peerCount.textContent = n;
}

function renderPeers() {
  if (state.peers.size === 0) {
    ui.peerGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div class="empty-state-icon">📡</div>
        <div>Belum ada kru yang join</div>
        <small style="color: #555;">Buka <code>/intercom</code> di HP untuk join</small>
      </div>`;
    return;
  }

  const arr = Array.from(state.peers.values());
  arr.sort((a, b) => a.joinedAt - b.joinedAt);

  ui.peerGrid.innerHTML = arr.map(p => {
    const isSpeaking = p.speaking === true;
    const avatar = isSpeaking ? '🎤' : '👤';
    return `
      <div class="peer-card ${isSpeaking ? 'speaking' : ''}" data-id="${p.id}">
        <div class="peer-avatar">${avatar}</div>
        <div class="peer-info">
          <div class="peer-name">${escapeHtml(p.name)}</div>
          <div class="peer-role">${escapeHtml(p.roleLabel || p.role || '?')}</div>
        </div>
        <div class="peer-actions">
          <button class="kick-btn" data-id="${p.id}" data-name="${escapeHtml(p.name)}" title="Keluarkan">✕</button>
        </div>
      </div>
    `;
  }).join('');

  $$('.kick-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      if (!confirm(`Keluarkan ${name}?`)) return;
      await kickPeer(id, 'Dikeluarkan oleh admin');
    });
  });
}

function setCurrentSpeaker(speaker) {
  state.currentSpeaker = speaker;
  if (speaker) {
    ui.speakerNow.classList.remove('silent');
    ui.speakerNow.querySelector('.who-icon').textContent = '🎤';
    ui.speakerNowName.textContent = speaker.name;
    ui.speakerNowRole.textContent = roleLabel(speaker.role);
    ui.speakerNow.querySelector('.badge').textContent = 'LIVE';
    ui.statSpeak.style.display = 'inline-flex';
  } else {
    ui.speakerNow.classList.add('silent');
    ui.speakerNow.querySelector('.who-icon').textContent = '🔇';
    ui.speakerNowName.textContent = 'Tidak ada';
    ui.speakerNowRole.textContent = '— standby —';
    ui.speakerNow.querySelector('.badge').textContent = 'IDLE';
    ui.statSpeak.style.display = 'none';
  }
  renderPeers();
}

function roleLabel(role) {
  const labels = {
    cam1: 'CAM 1', cam2: 'CAM 2', cam3: 'CAM 3', cam4: 'CAM 4',
    switcher: 'Switcher', production: 'Produksi',
    ppt1: 'ProPresenter 1', ppt2: 'ProPresenter 2',
    audio: 'Audio FOH', timekeeper: 'Time Keeper', other: 'Lainnya'
  };
  return labels[role] || role || '—';
}

// ============================================================================
// LOG
// ============================================================================

function addLog(kind, text) {
  const time = new Date().toTimeString().slice(0, 8);
  if (ui.logList.querySelector('.empty-log')) {
    ui.logList.innerHTML = '';
  }
  const item = document.createElement('div');
  item.className = `log-item ${kind}`;
  item.innerHTML = `<span class="time">${time}</span><span>${escapeHtml(text)}</span>`;
  ui.logList.insertBefore(item, ui.logList.firstChild);

  while (ui.logList.children.length > 200) {
    ui.logList.removeChild(ui.logList.lastChild);
  }
}

// ============================================================================
// API CALLS
// ============================================================================

async function refreshPeers() {
  try {
    const res = await fetch('/api/peers');
    const data = await res.json();
    state.peers.clear();
    for (const p of data.peers) {
      state.peers.set(p.id, p);
    }
    renderPeers();
    renderCount();
  } catch (e) {
    toast('Gagal refresh peer list');
  }
}

async function kickPeer(id, reason) {
  try {
    const res = await fetch('/api/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, reason })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(`Gagal kick: ${err.error || res.status}`);
      return;
    }
    toast(`✓ ${id} dikick`);
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

async function sendBroadcast(text) {
  try {
    const res = await fetch('/api/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(`Gagal broadcast: ${err.error || res.status}`);
      return false;
    }
    toast(`✓ Broadcast terkirim`);
    return true;
  } catch (e) {
    toast('Error: ' + e.message);
    return false;
  }
}

// ============================================================================
// TOAST
// ============================================================================

function toast(text, durationMs = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  ui.toastStack.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, durationMs);
}

// ============================================================================
// HELPERS
// ============================================================================

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&', '<': '<', '>': '>', '"': '"', "'": '''
  }[c]));
}

// Copy to clipboard helper
async function copyToClipboard(text, label = 'Teks') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`✓ ${label} disalin ke clipboard`);
  } catch (e) {
    toast(`Gagal salin: ${e.message}`);
  }
}

// ============================================================================
// QR CODE HANDLERS
// ============================================================================

async function showQrPreview(title, url, canvas) {
  state.currentQrUrl = url;
  state.currentQrTitle = title;

  await loadQrCodeLibrary();

  ui.qrTitle.textContent = title;
  ui.qrPreview.style.display = 'block';

  // Generate QR
  generateQrCode(url, canvas, 256);

  // Scroll to preview
  ui.qrPreview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function showFullscreenQr(title, url, canvas) {
  state.currentQrUrl = url;
  state.currentQrTitle = title;

  await loadQrCodeLibrary();

  ui.fullscreenQrTitle.textContent = title;
  ui.fullscreenQrModal.style.display = 'flex';

  // Generate QR at larger size for fullscreen
  generateQrCode(url, canvas, 512);
}

function hideQrPreview() {
  ui.qrPreview.style.display = 'none';
}

function hideFullscreenQr() {
  ui.fullscreenQrModal.style.display = 'none';
}

async function downloadQrPng(canvas, filename = 'qrcode.png') {
  try {
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    link.click();
    toast('✓ QR code diunduh sebagai PNG');
  } catch (e) {
    toast('Gagal unduh: ' + e.message);
  }
}

// ============================================================================
// SERVER INFO & INIT
// ============================================================================

async function loadServerInfo() {
  try {
    const res = await fetch('/api/server-info');
    if (!res.ok) throw new Error('Failed to fetch server info');
    const data = await res.json();

    const intercomUrl = data.urls.intercom;
    const adminUrl = data.urls.admin;

    ui.intercomUrlInput.value = intercomUrl;
    ui.adminUrlInput.value = adminUrl;

    ui.shareCard.style.display = 'block';

    console.log('[admin] Server info loaded:', data);
  } catch (e) {
    console.warn('[admin] Failed to load server info:', e);
    const proto = location.protocol === 'https:' ? 'https' : 'http';
    const host = location.host;
    ui.intercomUrlInput.value = `${proto}://${host}/intercom`;
    ui.adminUrlInput.value = `${proto}://${host}/admin`;
    ui.shareCard.style.display = 'block';
  }
}

// ============================================================================
// INIT
// ============================================================================

ui.broadcastForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = ui.broadcastText.value.trim();
  if (!text) return;
  const btn = ui.broadcastForm.querySelector('button');
  btn.disabled = true;
  btn.textContent = '⏳ Mengirim...';
  const ok = await sendBroadcast(text);
  btn.disabled = false;
  btn.textContent = '📡 Kirim ke Semua Kru';
  if (ok) {
    ui.broadcastText.value = '';
  }
});

ui.refreshBtn.addEventListener('click', refreshPeers);
ui.clearLogBtn.addEventListener('click', () => {
  ui.logList.innerHTML = '<div class="log-item empty-log"><span class="time">--:--:--</span><span>Log dikosongkan</span></div>';
});

// QR button handlers
ui.copyIntercomBtn.addEventListener('click', () => copyToClipboard(ui.intercomUrlInput.value, 'Intercom URL'));
ui.copyAdminBtn.addEventListener('click', () => copyToClipboard(ui.adminUrlInput.value, 'Admin URL'));

ui.qrIntercomBtn.addEventListener('click', () => showQrPreview('QR Intercom (HTTPS untuk HP kru)', ui.intercomUrlInput.value, ui.qrCanvas));
ui.qrAdminBtn.addEventListener('click', () => showQrPreview('QR Admin Dashboard', ui.adminUrlInput.value, ui.qrCanvas));

ui.closeQrBtn.addEventListener('click', hideQrPreview);

ui.fullscreenQrBtn.addEventListener('click', () => showFullscreenQr(state.currentQrTitle, state.currentQrUrl, ui.fullscreenQrCanvas));
ui.downloadQrBtn.addEventListener('click', () => downloadQrPng(ui.qrCanvas, 'qrcode-intercom.png'));

ui.closeFullscreenQrBtn.addEventListener('click', hideFullscreenQr);
ui.closeFullscreenQrBtn2.addEventListener('click', hideFullscreenQr);
ui.downloadFullscreenQrBtn.addEventListener('click', () => downloadQrPng(ui.fullscreenQrCanvas, 'qrcode-intercom-full.png'));

// Close modal on overlay click
ui.fullscreenQrModal.addEventListener('click', (e) => {
  if (e.target === ui.fullscreenQrModal) hideFullscreenQr();
});

// Load server info & connect WS
loadServerInfo();
connectWS();

// Auto refresh setiap 30 detik sebagai fallback kalau WS drop
setInterval(() => {
  if (state.connected) refreshPeers();
}, 30000);