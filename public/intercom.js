/**
 * intercom IP26 — Main intercom page logic
 * -----------------------------------------------------------------------------
 * Handles:
 *  - WebSocket signaling for presence + PTT state + WebRTC negotiation
 *  - WebRTC peer connections (one per remote peer, mesh topology)
 *  - Two mic modes:
 *      • PTT  — press and hold the button to transmit (default)
 *      • MUTE — tap to toggle mic on/off (latch)
 *  - Audio routing (play remote streams through single <audio> element)
 *  - UI updates: speaker stage, crew list, connection status, toasts
 *
 * Audio flow:
 *   Local mic (getUserMedia) → tx-controlled track.enabled
 *   → RTCPeerConnection tracks → remote peers hear us when our track is enabled
 *   ← RTCPeerConnection ontrack → <audio> element
 *
 * Important:
 *   - We never enable the local mic track until the user triggers PTT/mute-on
 *   - All peers are full-mesh, works for ≤ 8-10 simultaneous users fine
 * -----------------------------------------------------------------------------
 */

(function () {
  'use strict';

  // ============================================================================
  // STATE
  // ============================================================================

  let identity = null;
  let ws = null;
  let localStream = null;
  let localAudioTrack = null;

  // Map<peerId, { pc, role, name }>
  const peers = new Map();
  const remoteStreams = new Map();

  // Transmission state — single source of truth
  let txActive = false;              // are we currently sending audio?
  let txMode = 'ptt';                // 'ptt' (hold) or 'mute' (toggle)

  let reconnectAttempts = 0;
  const MAX_RECONNECT_DELAY = 15000;

  const ROLE_LABELS = {
    cam1: 'CAM 1', cam2: 'CAM 2', cam3: 'CAM 3', cam4: 'CAM 4',
    switcher: 'Switcher', production: 'Produksi',
    ppt1: 'ProPresenter 1', ppt2: 'ProPresenter 2',
    audio: 'Audio FOH', timekeeper: 'Time Keeper',
    other: 'Lainnya'
  };

  // ============================================================================
  // DOM REFS
  // ============================================================================
  const $ = (id) => document.getElementById(id);

  const dom = {
    myRole: $('myRole'),
    myName: $('myName'),
    connStatus: $('connStatus'),
    connLabel: $('connStatus').querySelector('.label'),

    speakerEmpty: $('speakerEmpty'),
    speakerActive: $('speakerActive'),
    speakerRole: $('speakerRole'),
    speakerName: $('speakerName'),

    modePttBtn: $('modePttBtn'),
    modeMuteBtn: $('modeMuteBtn'),

    pttButton: $('pttButton'),
    muteButton: $('muteButton'),
    pttStatus: $('pttStatus'),
    pttLabel: $('pttButton').querySelector('.ptt-label'),
    pttHint: $('pttButton').querySelector('.ptt-hint'),
    muteLabel: $('muteButton').querySelector('.ptt-label'),
    muteHint: $('muteButton').querySelector('.ptt-hint'),

    crewCount: $('crewCount'),
    crewList: $('crewList'),

    remoteAudio: $('remoteAudio'),
    toastStack: $('toastStack')
  };

  // ============================================================================
  // INIT
  // ============================================================================

  function init() {
    // Restore identity from sessionStorage (set by join.html)
    try {
      const cached = sessionStorage.getItem('intercom-identity');
      if (!cached) {
        window.location.href = 'index.html';
        return;
      }
      identity = JSON.parse(cached);
    } catch (e) {
      window.location.href = 'index.html';
      return;
    }

    dom.myRole.textContent = ROLE_LABELS[identity.role] || identity.role;
    dom.myName.textContent = identity.name;

    // Prevent page navigation via swipe (we use press-and-hold gestures)
    document.addEventListener('touchmove', (e) => {
      if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });

    // Read preferred mode from sessionStorage or default to PTT
    try {
      const saved = sessionStorage.getItem('intercom-mode');
      if (saved === 'mute' || saved === 'ptt') txMode = saved;
    } catch (e) { /* ignore */ }

    setupModeSelector();
    setupPTT();
    setupMute();

    // Start in selected mode (silent = no toast)
    applyMode(txMode, true);

    // Page Visibility: kalau user pindah tab saat PTT, lepas transmisi
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && txActive && txMode === 'ptt') stopTx();
    });
  }

  // ============================================================================
  // MODE SELECTOR
  // ============================================================================

  function setupModeSelector() {
    dom.modePttBtn.addEventListener('click', () => applyMode('ptt'));
    dom.modeMuteBtn.addEventListener('click', () => applyMode('mute'));
  }

  function applyMode(mode, silent) {
    if (mode !== 'ptt' && mode !== 'mute') return;

    // If currently transmitting, stop first
    if (txActive) stopTx();

    txMode = mode;

    // Toggle chip styles
    const isPtt = mode === 'ptt';
    dom.modePttBtn.classList.toggle('active', isPtt);
    dom.modeMuteBtn.classList.toggle('active', !isPtt);
    dom.modePttBtn.setAttribute('aria-selected', isPtt ? 'true' : 'false');
    dom.modeMuteBtn.setAttribute('aria-selected', !isPtt ? 'true' : 'false');

    // Toggle which big button is visible
    dom.pttButton.classList.toggle('hidden', !isPtt);
    dom.muteButton.classList.toggle('hidden', isPtt);

    // Update status text
    dom.pttStatus.textContent = isPtt ? 'Siap · Mode PTT' : 'Siap · Mode Mute';
    dom.pttStatus.classList.remove('transmitting');

    // Persist preference for next session
    try { sessionStorage.setItem('intercom-mode', mode); } catch (e) { /* ignore */ }
  }

  // ============================================================================
  // PUSH-TO-TALK (hold to transmit)
  // ============================================================================

  function setupPTT() {
    const btn = dom.pttButton;

    const pressStart = (e) => {
      e.preventDefault();
      if (txActive) return;
      startTx();
    };

    const pressEnd = (e) => {
      e.preventDefault();
      if (!txActive) return;
      stopTx();
    };

    // Touch events (mobile)
    btn.addEventListener('touchstart', pressStart, { passive: false });
    btn.addEventListener('touchend', pressEnd, { passive: false });
    btn.addEventListener('touchcancel', pressEnd, { passive: false });

    // Mouse events (desktop testing)
    btn.addEventListener('mousedown', pressStart);
    btn.addEventListener('mouseup', pressEnd);
    btn.addEventListener('mouseleave', pressEnd);

    // Keyboard: hold space to talk (handy for testing on laptop)
    document.addEventListener('keydown', (e) => {
      if (txMode !== 'ptt') return;
      if (e.code === 'Space' && !e.repeat && !txActive &&
          document.activeElement?.tagName !== 'INPUT' &&
          document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        startTx();
      }
    });
    document.addEventListener('keyup', (e) => {
      if (txMode !== 'ptt') return;
      if (e.code === 'Space' && txActive) {
        e.preventDefault();
        stopTx();
      }
    });

    // Global safety: if we lose focus while transmitting, stop
    window.addEventListener('blur', () => {
      if (txActive && txMode === 'ptt') stopTx();
    });
  }

  // ============================================================================
  // MUTE TOGGLE (tap on / tap off)
  // ============================================================================

  function setupMute() {
    const btn = dom.muteButton;

    const toggle = (e) => {
      e.preventDefault();
      if (txActive) {
        stopTx();
      } else {
        startTx();
      }
    };

    btn.addEventListener('click', toggle);
    // Use touchend for snappier mobile feel; click is fallback
    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (txActive) {
        stopTx();
      } else {
        startTx();
      }
    }, { passive: false });
  }

  // ============================================================================
  // UNIFIED TX START/STOP (used by both PTT and Mute)
  // ============================================================================

  async function startTx() {
    if (txActive) return;

    // First-time: get mic
    if (!localStream) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            channelCount: 1
          },
          video: false
        });
        localAudioTrack = localStream.getAudioTracks()[0];
        localAudioTrack.enabled = false; // MUTED by default

        // Add to existing peer connections
        for (const [, peerEntry] of peers) {
          const sender = peerEntry.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
          if (sender) {
            sender.replaceTrack(localAudioTrack).catch(() => {});
          } else {
            peerEntry.pc.addTrack(localAudioTrack, localStream);
          }
        }
      } catch (err) {
        console.error('[mic] getUserMedia failed:', err);
        toast('Izin mikrofon ditolak. Periksa pengaturan browser.', 'error', 5000);
        return;
      }
    }

    txActive = true;
    if (localAudioTrack) localAudioTrack.enabled = true;

    // Update UI for both buttons (only the visible one is rendered)
    if (txMode === 'ptt') {
      dom.pttButton.classList.add('active');
      dom.pttLabel.textContent = 'TRANSMIT';
      dom.pttHint.textContent = 'Lepaskan untuk selesai';
    } else {
      dom.muteButton.classList.add('active');
      dom.muteLabel.textContent = 'MIC OFF';
      dom.muteHint.textContent = 'Tap untuk matikan / nyalakan';
    }

    dom.pttStatus.textContent = '● Mengirim...';
    dom.pttStatus.classList.add('transmitting');

    // Show our own "speaking" state
    renderSpeaker({
      from: identity.id,
      fromRole: identity.role,
      fromName: identity.name,
      state: 'on'
    });

    // Notify server
    sendSignaling({ type: 'ptt-on' });

    // Haptic feedback on mobile
    if (navigator.vibrate) navigator.vibrate(40);

    // Lock orientation / wake
    acquireWakeLock();
  }

  function stopTx() {
    if (!txActive) return;
    txActive = false;
    if (localAudioTrack) localAudioTrack.enabled = false;

    // Reset both button UIs (only the visible one matters)
    dom.pttButton.classList.remove('active');
    dom.pttLabel.textContent = 'Tahan Untuk Bicara';
    dom.pttHint.textContent = 'Tekan & Tahan';

    dom.muteButton.classList.remove('active');
    dom.muteLabel.textContent = 'MIC ON';
    dom.muteHint.textContent = 'Tap untuk matikan';

    dom.pttStatus.textContent = txMode === 'ptt' ? 'Siap · Mode PTT' : 'Siap · Mode Mute';
    dom.pttStatus.classList.remove('transmitting');

    // Clear our own speaking display
    clearSpeakerIfSelf();

    // Notify server
    sendSignaling({ type: 'ptt-off' });

    // Release wake lock if we have one
    releaseWakeLock();
  }

  // ============================================================================
  // RENDERING
  // ============================================================================

  function setConnectionState(state, label) {
    dom.connStatus.dataset.state = state;
    dom.connLabel.textContent = label;
  }

  function renderSpeaker(msg) {
    if (msg.from === identity.id) return;
    if (msg.state === 'on') {
      dom.speakerEmpty.classList.add('hidden');
      dom.speakerActive.classList.remove('hidden');
      dom.speakerRole.textContent = ROLE_LABELS[msg.fromRole] || msg.fromRole || '—';
      dom.speakerName.textContent = msg.fromName || 'Anonim';
    } else {
      dom.speakerEmpty.classList.remove('hidden');
      dom.speakerActive.classList.add('hidden');
    }
  }

  function clearSpeakerIfSelf() {
    dom.speakerEmpty.classList.remove('hidden');
    dom.speakerActive.classList.add('hidden');
  }

  let lastSpeakingId = null;
  function markPeerSpeaking(peerId, speaking) {
    lastSpeakingId = speaking ? peerId : null;
    renderCrewList(getCurrentCrew());
  }

  function getCurrentCrew() {
    return lastPresenceUsers || [];
  }

  let lastPresenceUsers = [];
  function renderCrewList(users) {
    lastPresenceUsers = users;

    // Ensure self is in list
    const selfEntry = users.find(u => u.id === identity.id);
    if (!selfEntry) {
      users = [...users, {
        id: identity.id,
        role: identity.role,
        name: identity.name,
        self: true,
        speaking: false
      }];
    }

    dom.crewCount.textContent = users.length;

    if (users.length === 0) {
      dom.crewList.innerHTML = '<li class="crew-empty">Belum ada kru lain yang join.</li>';
      return;
    }

    const roleOrder = ['production', 'switcher', 'audio', 'cam1', 'cam2', 'cam3', 'cam4', 'ppt1', 'ppt2', 'timekeeper', 'other'];
    users.sort((a, b) => {
      if (a.id === identity.id) return -1;
      if (b.id === identity.id) return 1;
      if (a.speaking && !b.speaking) return -1;
      if (!a.speaking && b.speaking) return 1;
      return (roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));
    });

    const html = users.map(u => {
      const isMe = u.id === identity.id;
      const speaking = u.speaking || (isMe && txActive);
      return `
        <li class="${speaking ? 'speaking' : ''} ${isMe ? 'me' : ''}">
          <span class="crew-role">${ROLE_LABELS[u.role] || u.role || '—'}</span>
          <span class="crew-name">${escapeHtml(u.name || 'Anonim')}${isMe ? ' (kamu)' : ''}</span>
          <span class="crew-state" aria-label="${speaking ? 'sedang bicara' : 'diam'}">
            ${speaking ? '🎙️' : ''}
          </span>
        </li>
      `;
    }).join('');
    dom.crewList.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(message, type = 'info', duration = 3000) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    dom.toastStack.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-leaving');
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  // ============================================================================
  // WAKE LOCK
  // ============================================================================

  let wakeLock = null;
  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (err) {
      // Wake lock may be denied — that's OK
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // ============================================================================
  // SIGNALING
  // ============================================================================

  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws?role=${identity.role}&name=${encodeURIComponent(identity.name)}&id=${identity.id}`;

    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      reconnectAttempts = 0;
      setConnectionState('connected', 'Terhubung');
    });

    ws.addEventListener('message', async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      switch (msg.type) {
        case 'peer-list':
          handlePeerList(msg.peers);
          break;
        case 'new-peer':
          await createPeerConnection(msg.peer);
          break;
        case 'peer-left':
          handlePeerLeft(msg.peerId);
          break;
        case 'signal':
          await handleSignal(msg.from, msg.data);
          break;
        case 'ptt-state':
          handlePttState(msg);
          break;
        case 'presence':
          renderCrewList(msg.users);
          break;
        case 'error':
          toast(msg.message || 'Terjadi kesalahan', 'error');
          break;
        case 'server-shutdown':
          toast('Server dimatikan', 'error', 5000);
          break;
      }
    });

    ws.addEventListener('close', () => {
      setConnectionState('connecting', 'Memutus...');
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      setConnectionState('error', 'Gagal');
    });
  }

  function scheduleReconnect() {
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY);
    setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        connectWebSocket();
      }
    }, delay);
  }

  function sendSignaling(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ============================================================================
  // WEBRTC PEER CONNECTIONS
  // ============================================================================

  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // NOTE: TURN credentials below are placeholders for the demo.
      // For real cross-network use, register at https://www.metered.ca/stun-turn
      // and replace with real credentials. On the same LAN (e.g. unnes-id,
      // WiFi kos, hotspot), STUN alone is enough — TURN only needed if
      // client isolation blocks direct peer-to-peer traffic.
      {
        urls: 'turn:global.turn.metered.ca:80',
        username: 'e7f3a4b2c1d9e8f6a5b4c3d2e1f0a9b8',
        credential: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'
      },
      {
        urls: 'turn:global.turn.metered.ca:443',
        username: 'e7f3a4b2c1d9e8f6a5b4c3d2e1f0a9b8',
        credential: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'
      }
    ],
    iceCandidatePoolSize: 10
  };

  function handlePeerList(peerList) {
    for (const peer of peerList) {
      createPeerConnection(peer);
    }
  }

  async function createPeerConnection(peer) {
    if (peers.has(peer.id)) return;

    const pc = new RTCPeerConnection(ICE_CONFIG);
    const peerEntry = { pc, role: peer.role, name: peer.name };
    peers.set(peer.id, peerEntry);

    if (localAudioTrack && localStream) {
      pc.addTrack(localAudioTrack, localStream);
    }

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        sendSignaling({
          type: 'signal',
          to: peer.id,
          data: { candidate: event.candidate }
        });
      }
    });

    pc.addEventListener('track', (event) => {
      const [stream] = event.streams;
      if (stream) {
        remoteStreams.set(peer.id, stream);
        if (dom.remoteAudio.srcObject !== stream) {
          dom.remoteAudio.srcObject = stream;
        }
      }
    });

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        handlePeerLeft(peer.id);
      }
    });

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignaling({
        type: 'signal',
        to: peer.id,
        data: { sdp: pc.localDescription }
      });
    } catch (err) {
      console.error('[webrtc] createOffer failed:', err);
    }
  }

  async function handleSignal(fromId, data) {
    let peerEntry = peers.get(fromId);
    if (!peerEntry) return;
    const pc = peerEntry.pc;

    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignaling({
          type: 'signal',
          to: fromId,
          data: { sdp: pc.localDescription }
        });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('[webrtc] addIceCandidate failed:', err);
      }
    }
  }

  function handlePeerLeft(peerId) {
    const peerEntry = peers.get(peerId);
    if (peerEntry) {
      try { peerEntry.pc.close(); } catch (e) {}
      peers.delete(peerId);
    }
    if (remoteStreams.has(peerId)) {
      remoteStreams.delete(peerId);
    }
  }

  function handlePttState(msg) {
    const updated = lastPresenceUsers.map(u => ({
      ...u,
      speaking: u.id === msg.from
    }));
    renderCrewList(updated);
  }

  // ============================================================================
  // BOOT
  // ============================================================================

  document.addEventListener('DOMContentLoaded', init);
})();
