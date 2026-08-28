/* eslint-disable */
/**
 * intercom IP26 — Admin Dashboard
 * ------------------------------------------------------------------
 * WebSocket sebagai observer: terima broadcast presence + PTT state
 * dari server. Tidak perlu register karena admin = listener only.
 *
 * Kontrol: refresh peer list, kick peer, broadcast system message.
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
  toastStack: $('#toastStack')
};

const state = {
  ws: null,
  connected: false,
  currentSpeaker: null,
  peers: new Map()
};

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
      // Broadcast masuk dari admin lain atau via API
      toast(`📣 ${msg.text}`);
      addLog('system', `Broadcast: ${msg.text}`);
      break;

    case 'kicked':
      // Tidak relevan untuk admin (admin tidak bisa di-kick dari server)
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

  // Wire up kick buttons
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
  // Re-render peers untuk update border speaking
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
  // Remove empty placeholder
  if (ui.logList.querySelector('.empty-log')) {
    ui.logList.innerHTML = '';
  }
  const item = document.createElement('div');
  item.className = `log-item ${kind}`;
  item.innerHTML = `<span class="time">${time}</span><span>${escapeHtml(text)}</span>`;
  ui.logList.insertBefore(item, ui.logList.firstChild);

  // Cap 200 entries
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
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
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

connectWS();
// Auto refresh setiap 30 detik sebagai fallback kalau WS drop
setInterval(() => {
  if (state.connected) refreshPeers();
}, 30000);
