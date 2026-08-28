/**
 * intercom IP26 — Main intercom page logic
 * -----------------------------------------------------------------------------
 * Handles:
 *  - WebSocket signaling for presence + PTT state + WebRTC negotiation
 *  - WebRTC peer connections (one per remote peer, mesh topology)
 *  - Push-to-Talk button (mouse + touch)
 *  - Audio routing (play remote streams through single <audio> element)
 *  - UI updates: speaker stage, crew list, connection status, toasts
 *
 * Audio flow:
 *   Local mic (getUserMedia) → ptt-button-controlled track.enabled
 *   → RTCPeerConnection tracks → remote peers hear us when PTT active
 *   ← RTCPeerConnection ontrack → <audio> element
 *
 * Important:
 *   - We never enable the local mic track until PTT is pressed (privacy)
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

  // Map<peerId, { pc, role, name, iceCandidateQueue }>
  const peers = new Map();
  const remoteStreams = new Map();   // Map<peerId, MediaStream>

  let pttActive = false;
  let pttHoldRegistered = false;     // safety: only one hold at a time
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

    pttButton: $('pttButton'),
    pttStatus: $('pttStatus'),
    pttLabel: $('pttButton').querySelector('.ptt-label'),
    pttHint: $('pttButton').querySelector('.ptt-hint'),

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

    // Setup PTT events
    setupPTT();

    // Setup leave button
    document.getElementById('leaveBtn').addEventListener('click', (e) => {
      e.preventDefault();
      cleanup();
      window.location.href = 'index.html';
    });

    // Start connection
    connect();

    // Prevent page from sleeping during PTT (wake lock when supported)
    setupWakeLock();

    // Visibility change → reconnect if hidden too long
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!ws || ws.readyState !== WebSocket.OPEN)) {
        connect();
      }
    });
  }

  // ============================================================================
  // WEBSOCKET CONNECTION
  // ============================================================================

  function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    setConnectionState('connecting', 'Menghubungkan...');

    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${location.host}/ws`;

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      setConnectionState('error', 'Gagal konek');
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectAttempts = 0;
      setConnectionState('connected', 'Terhubung');
      // Re-register our identity
      ws.send(JSON.stringify({
        type: 'register',
        role: identity.role,
        name: identity.name
      }));
      toast('Koneksi tersambung', 'success', 2000);
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      handleSignalingMessage(msg);
    };

    ws.onerror = () => {
      // error event will be followed by close
    };

    ws.onclose = () => {
      setConnectionState('error', 'Terputus');
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= 8) {
      toast('Koneksi gagal. Refresh halaman.', 'error', 6000);
      return;
    }
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    setTimeout(connect, delay);
  }

  function sendSignaling(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ============================================================================
  // SIGNALING MESSAGE HANDLER
  // ============================================================================

  function handleSignalingMessage(msg) {
    switch (msg.type) {

      case 'hello': {
        // server assigned us an id — update identity
        if (msg.id) {
          identity.id = msg.id;
        }
        break;
      }

      case 'presence': {
        renderCrewList(msg.users || []);
        break;
      }

      case 'peer-list': {
        // We're a newcomer — make offers to all existing peers
        (msg.peers || []).forEach(p => ensurePeer(p, true));
        break;
      }

      case 'new-peer': {
        // An existing peer should make the offer to us
        ensurePeer(msg.peer, false);
        break;
      }

      case 'signal': {
        handleRTCSignal(msg);
        break;
      }

      case 'ptt-state': {
        renderSpeaker(msg);
        // Also update crew list to show "speaking" badge
        markPeerSpeaking(msg.from, msg.state === 'on');
        break;
      }

      case 'error': {
        toast(msg.error || 'Server error', 'error', 4000);
        break;
      }

      case 'server-shutdown': {
        toast('Server dimatikan oleh admin', 'error', 5000);
        break;
      }
    }
  }

  // ============================================================================
  // WEBRTC PEER MANAGEMENT
  // ============================================================================

  function getRTCConfig() {
    return {
      iceServers: [
        // Public STUN servers (free, for NAT traversal on home/LAN networks)
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },

        // TURN server (free tier, public). Needed when WiFi has client-isolation
        // (e.g. unnes-id campus WiFi where devices cannot talk peer-to-peer).
        // TURN relays audio through a public server, so PTT still works.
        // ----------------------------------------------------------------------
        // NOTE: For a free, real TURN server, register at https://www.metered.ca/stun-turn
        // (free 500GB/mo) and replace the credentials below.
        // If these don't work at the venue, use a dedicated HP-hotspot WiFi
        // instead (no TURN needed).
        // ----------------------------------------------------------------------
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
      iceTransportPolicy: 'all',  // try direct first, fall back to TURN
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    };
  }

  async function ensurePeer(peer, isInitiator) {
    if (!peer || !peer.id) return;
    if (peer.id === identity.id) return; // don't connect to self
    if (peers.has(peer.id)) {
      // Update metadata only
      const p = peers.get(peer.id);
      p.role = peer.role;
      p.name = peer.name;
      return;
    }

    console.log(`[rtc] ensurePeer ${peer.id} (${peer.role}) initiator=${isInitiator}`);

    const pc = new RTCPeerConnection(getRTCConfig());

    // Add our local audio track (if we have one) — track will be disabled until PTT
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    const peerEntry = {
      pc,
      role: peer.role,
      name: peer.name,
      iceCandidateQueue: []
    };
    peers.set(peer.id, peerEntry);

    // ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignaling({
          type: 'signal',
          target: peer.id,
          signal: { type: 'ice', candidate: e.candidate }
        });
      }
    };

    // Remote track — play through single <audio> element
    pc.ontrack = (e) => {
      console.log(`[rtc] remote track from ${peer.id}`);
      let stream = e.streams[0];
      if (!stream) {
        // Some browsers split — build one
        stream = new MediaStream();
        stream.addTrack(e.track);
      }
      remoteStreams.set(peer.id, stream);
      attachRemoteAudio();
    };

    pc.onconnectionstatechange = () => {
      console.log(`[rtc] ${peer.id} state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanupPeer(peer.id);
      }
    };

    // If we are the initiator (newcomer), create the offer
    if (isInitiator) {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        sendSignaling({
          type: 'signal',
          target: peer.id,
          signal: { type: 'sdp', sdp: pc.localDescription }
        });
      } catch (err) {
        console.error('[rtc] createOffer failed:', err);
      }
    }
  }

  async function handleRTCSignal(msg) {
    if (!msg.from || !msg.signal) return;

    // Ensure we have a peer entry; if not, the new-peer event might race —
    // create as passive (non-initiator) and let us receive an offer.
    if (!peers.has(msg.from)) {
      await ensurePeer({ id: msg.from, role: msg.fromRole, name: msg.fromName }, false);
    }

    const peerEntry = peers.get(msg.from);
    if (!peerEntry) return;
    const pc = peerEntry.pc;

    try {
      if (msg.signal.type === 'sdp') {
        const desc = msg.signal.sdp;
        if (desc.type === 'offer') {
          await pc.setRemoteDescription(desc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignaling({
            type: 'signal',
            target: msg.from,
            signal: { type: 'sdp', sdp: pc.localDescription }
          });
        } else if (desc.type === 'answer') {
          await pc.setRemoteDescription(desc);
        }
        // Flush any queued ICE candidates
        while (peerEntry.iceCandidateQueue.length > 0) {
          const cand = peerEntry.iceCandidateQueue.shift();
          try { await pc.addIceCandidate(cand); } catch (e) { /* ignore */ }
        }
      } else if (msg.signal.type === 'ice') {
        if (!pc.remoteDescription) {
          // Queue until SDP is set
          peerEntry.iceCandidateQueue.push(msg.signal.candidate);
        } else {
          try {
            await pc.addIceCandidate(msg.signal.candidate);
          } catch (e) { /* ignore */ }
        }
      }
    } catch (err) {
      console.error('[rtc] signal handling error:', err);
    }
  }

  function attachRemoteAudio() {
    // Combine all remote streams into one and play through single <audio>
    const combined = new MediaStream();
    for (const stream of remoteStreams.values()) {
      stream.getTracks().forEach(t => combined.addTrack(t));
    }
    if (combined.getTracks().length === 0) return;
    dom.remoteAudio.srcObject = combined;
    dom.remoteAudio.play().catch(e => {
      console.warn('[audio] autoplay blocked:', e);
    });
  }

  function cleanupPeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) {
      try { peer.pc.close(); } catch (e) { /* ignore */ }
    }
    peers.delete(peerId);
    remoteStreams.delete(peerId);
    attachRemoteAudio();
  }

  // ============================================================================
  // PUSH-TO-TALK
  // ============================================================================

  function setupPTT() {
    const btn = dom.pttButton;

    // Press handlers
    const pressStart = (e) => {
      e.preventDefault();
      if (pttActive) return;
      startPTT();
    };

    const pressEnd = (e) => {
      e.preventDefault();
      if (!pttActive) return;
      stopPTT();
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
      if (e.code === 'Space' && !e.repeat && !pttActive &&
          document.activeElement?.tagName !== 'INPUT' &&
          document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        startPTT();
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && pttActive) {
        e.preventDefault();
        stopPTT();
      }
    });

    // Global safety: if we lose focus while transmitting, stop
    window.addEventListener('blur', () => {
      if (pttActive) stopPTT();
    });
  }

  async function startPTT() {
    if (pttActive) return;

    // First-time: get mic
    if (!localStream) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            // High quality for voice
            sampleRate: 48000,
            channelCount: 1
          },
          video: false
        });
        localAudioTrack = localStream.getAudioTracks()[0];
        localAudioTrack.enabled = false; // MUTED by default

        // Now add to existing peer connections
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

    pttActive = true;
    if (localAudioTrack) localAudioTrack.enabled = true;

    // UI
    dom.pttButton.classList.add('active');
    dom.pttLabel.textContent = 'TRANSMIT';
    dom.pttHint.textContent = 'Lepaskan untuk selesai';
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

  function stopPTT() {
    if (!pttActive) return;
    pttActive = false;
    if (localAudioTrack) localAudioTrack.enabled = false;

    // UI
    dom.pttButton.classList.remove('active');
    dom.pttLabel.textContent = 'Tahan Untuk Bicara';
    dom.pttHint.textContent = 'Tekan & Tahan';
    dom.pttStatus.textContent = 'Siap';
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
    // If our own id → don't double-render
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
    // If our own id is shown, hide it
    dom.speakerEmpty.classList.remove('hidden');
    dom.speakerActive.classList.add('hidden');
  }

  let lastSpeakingId = null;
  function markPeerSpeaking(peerId, speaking) {
    lastSpeakingId = speaking ? peerId : null;
    renderCrewList(getCurrentCrew());
  }

  function getCurrentCrew() {
    // Last known crew from server. Cached in lastPresenceUsers.
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
        roleLabel: ROLE_LABELS[identity.role] || identity.role,
        speaking: pttActive
      }];
    } else {
      // Update own speaking flag
      selfEntry.speaking = pttActive;
    }

    const totalKru = users.length;
    const speakers = users.filter(u => u.speaking).length;
    const otherCount = users.filter(u => u.id !== identity.id).length;

    dom.crewCount.textContent = totalKru;

    if (users.length === 0) {
      dom.crewList.innerHTML = '<li class="crew-empty">Belum ada kru lain yang join.</li>';
      return;
    }

    // Build rows
    const html = users.map(u => {
      const isSelf = u.id === identity.id;
      const speaking = u.speaking === true;
      const role = ROLE_LABELS[u.role] || u.role || '—';
      let badge = '';
      if (speaking && isSelf) badge = '<span class="crew-speaking-badge">TX</span>';
      else if (speaking) badge = '<span class="crew-speaking-badge">SPEAK</span>';
      else if (isSelf) badge = '<span class="crew-you-badge">YOU</span>';

      return `
        <li class="${speaking ? 'speaking' : ''}" data-id="${u.id}">
          <span class="crew-role">${escapeHtml(role)}</span>
          <span class="crew-name">${escapeHtml(u.name || 'Anonim')}</span>
          ${badge}
        </li>
      `;
    }).join('');

    dom.crewList.innerHTML = html;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ============================================================================
  // TOAST NOTIFICATIONS
  // ============================================================================

  function toast(text, kind = 'info', duration = 3000) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    dom.toastStack.appendChild(el);
    setTimeout(() => {
      el.classList.add('fade-out');
      setTimeout(() => el.remove(), 240);
    }, duration);
  }

  // ============================================================================
  // WAKE LOCK (prevent screen sleep during event)
  // ============================================================================
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* ignore */ }
  }
  function releaseWakeLock() {
    if (wakeLock) {
      try { wakeLock.release(); } catch (e) { /* ignore */ }
      wakeLock = null;
    }
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  function cleanup() {
    if (ws) {
      try { ws.close(); } catch (e) { /* ignore */ }
    }
    for (const [id] of peers) cleanupPeer(id);
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
    }
    releaseWakeLock();
  }

  window.addEventListener('beforeunload', cleanup);

  // ============================================================================
  // BOOT
  // ============================================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
