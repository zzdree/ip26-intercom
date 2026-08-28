/**
 * IP26-Intercom — Main intercom page logic
 * -----------------------------------------------------------------------------
 * Handles:
 *  - WebSocket signaling for presence + PTT state + WebRTC negotiation
 *  - WebRTC peer connections (one per remote peer, mesh topology)
 *  - Two mic modes:
 *      • PTT  — press and hold the button to transmit (default)
 *      • MUTE — tap to toggle mic on/off (latch)
 *  - Audio routing (play remote streams through single <audio> element)
 *  - UI updates: speaker stage, crew list, connection status, toasts
 *  - Lifecycle safety: visibilitychange, pagehide, freeze, idle-timeout
 *
 * Audio flow:
 *   Local mic (getUserMedia on page load) → tx-controlled track.enabled
 *   → RTCPeerConnection tracks → remote peers hear us when our track is enabled
 *   ← RTCPeerConnection ontrack → <audio> element
 *
 * Important:
 *   - Mic is acquired ONCE on page load (after identity check) so the browser
 *     permission prompt appears immediately, not buried behind a button press.
 *   - Wake lock is requested immediately on page load and re-acquired when the
 *     tab becomes visible again — this prevents the screen from sleeping while
 *     a kru is holding the device for production use.
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
  let localMicReady = false;     // apakah user sudah kasih izin mic
  let localMicError = null;      // kenapa izin ditolak / gagal

  // Map<peerId, { pc, role, name }>
  const peers = new Map();
  const remoteStreams = new Map();

  // Transmission state — single source of truth
  let txActive = false;              // are we currently sending audio?
  let txMode = 'ptt';                // 'ptt' (hold) or 'mute' (toggle)

  // Idle safety: if mic stays on this long without a re-confirm, auto-mute
  const IDLE_MUTE_MS = 60_000;       // 60s
  let idleMuteTimer = null;
  let lastTxActivityAt = 0;

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

  async function init() {
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
    setupAudioUnlock();

    // Start in selected mode (silent = no toast)
    applyMode(txMode, true);

    // ========================================================================
    // PERMISSION PROMPT: ask for mic immediately on page load.
    // Browser rules require a user gesture for getUserMedia. We work around
    // this by:
    //   1. Adding a transparent "Tap untuk masuk" gate button that fires on
    //      first user interaction (any click/tap counts)
    //   2. As soon as that fires, request mic and connect WS
    // If the page is already inside a "warm" tap (e.g. user just hit "Masuk"
    // on join.html), we go straight in.
    // ========================================================================

    const warmed = sessionStorage.getItem('intercom-warmed') === '1';
    if (warmed) {
      sessionStorage.removeItem('intercom-warmed');
      enterRoom();
    } else {
      showEnterGate();
    }

    // ========================================================================
    // LIFECYCLE SAFETY
    // ========================================================================

    // Page Visibility: kalau user pindah tab saat PTT (mode PTT), lepas transmisi
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // PTT mode: selalu aman dilepas
        if (txActive && txMode === 'ptt') stopTx('visibility');
        // Re-acquire wake lock when we come back
      } else {
        acquireWakeLock();
      }
    });

    // HP locked / app frozen / tab di-swap
    window.addEventListener('pagehide', () => {
      if (txActive) stopTx('pagehide');
    });
    window.addEventListener('freeze', () => {
      if (txActive) stopTx('freeze');
    });
    window.addEventListener('blur', () => {
      // PTT mode: lepas transmisi kalau kehilangan fokus
      if (txActive && txMode === 'ptt') stopTx('blur');
    });

    // Idle safety: kalau mic on > 60s tanpa aktivitas, auto-mute (safety net
    // kalau HP jatuh ke saku / kru lupa matikan)
    setInterval(checkIdleMute, 5_000);

    // Re-acquire wake lock if it gets released (battery saver, tab switch, etc.)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !wakeLock) acquireWakeLock();
    });
  }

  // ============================================================================
  // ENTER GATE — one tap to request mic + open WS
  // ============================================================================

  function showEnterGate() {
    // Hide the PTT/Mute buttons, show a "Masuk" button that primes everything
    dom.pttButton.classList.add('hidden');
    dom.muteButton.classList.add('hidden');
    dom.pttStatus.textContent = 'Tekan tombol di bawah untuk masuk';

    const gate = document.createElement('button');
    gate.id = 'enterGate';
    gate.className = 'ptt-button ptt-mode ptt-color-ptt';
    gate.style.minHeight = '120px';
    gate.innerHTML = `
      <div class="ptt-inner">
        <div class="ptt-icon" aria-hidden="true">🎙️</div>
        <div class="ptt-label">MASUK INTERCOM</div>
        <div class="ptt-hint">Aktifkan mikrofon &amp; speaker</div>
      </div>
    `;
    gate.setAttribute('aria-label', 'Tekan untuk masuk intercom dan mengaktifkan mikrofon');

    // Insert before the status text
    dom.pttStatus.parentNode.insertBefore(gate, dom.pttStatus);

    const onEnter = async () => {
      gate.removeEventListener('click', onEnter);
      gate.removeEventListener('touchend', onEnter);
      gate.disabled = true;
      gate.querySelector('.ptt-label').textContent = 'MEMBUKA...';
      gate.querySelector('.ptt-hint').textContent = 'Minta izin mikrofon...';
      try {
        await enterRoom();
        gate.remove();
        // After enter, show the active mode's button
        if (txMode === 'ptt') dom.pttButton.classList.remove('hidden');
        else dom.muteButton.classList.remove('hidden');
        dom.pttStatus.textContent = 'Siap · Mode ' + (txMode === 'ptt' ? 'PTT' : 'Mute');
      } catch (e) {
        gate.disabled = false;
        gate.querySelector('.ptt-label').textContent = 'COBA LAGI';
        gate.querySelector('.ptt-hint').textContent = (e && e.message) || 'Izin ditolak, periksa pengaturan';
      }
    };

    gate.addEventListener('click', onEnter);
    gate.addEventListener('touchend', onEnter, { passive: false });
  }

  async function enterRoom() {
    // 1) Minta izin mic SEKALIGUS (bukan pas pencet PTT)
    await ensureLocalMic();

    // 2) Buka WS
    connectWebSocket();

    // 3) Wake lock supaya HP gak tidur pas live
    acquireWakeLock();

    // 4) Setup audio device picker (kalau browser support enumerateDevices)
    setupAudioDevices();

    // 5) Pilih output device default (kalau browser support setSinkId)
    setupOutputDevice();

    // 6) Mark warmed for next visit
    try { sessionStorage.setItem('intercom-warmed', '1'); } catch (e) {}
  }

  // ============================================================================
  // LOCAL MIC ACQUISITION
  // ============================================================================

  async function ensureLocalMic() {
    if (localMicReady && localStream) return localStream;

    // Pick best available audio constraints
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1
      },
      video: false
    };

    // If user previously picked a specific input device, use it
    try {
      const savedInputId = localStorage.getItem('intercom-input-device');
      if (savedInputId) {
        constraints.audio.deviceId = { exact: savedInputId };
      }
    } catch (e) { /* ignore */ }

    try {
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      localAudioTrack = localStream.getAudioTracks()[0];
      localAudioTrack.enabled = false; // MUTED by default
      localMicReady = true;
      localMicError = null;

      // Add to any existing peer connections
      for (const [, peerEntry] of peers) {
        const sender = peerEntry.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
        if (sender) {
          sender.replaceTrack(localAudioTrack).catch(() => {});
        } else {
          peerEntry.pc.addTrack(localAudioTrack, localStream);
        }
      }

      console.log('[mic] local mic acquired:', localAudioTrack.label);
      return localStream;
    } catch (err) {
      localMicError = err;
      console.error('[mic] getUserMedia failed:', err);

      let msg = 'Izin mikrofon ditolak.';
      if (err && err.name === 'NotAllowedError') {
        msg = 'Izin mikrofon ditolak. Buka Setelan → Situs → Mikrofon untuk mengizinkan.';
      } else if (err && err.name === 'NotFoundError') {
        msg = 'Tidak ada mikrofon ditemukan. Sambungkan headset/IEM.';
      } else if (err && err.name === 'NotReadableError') {
        msg = 'Mikrofon sedang dipakai aplikasi lain. Tutup dulu.';
      }
      toast(msg, 'error', 6000);
      throw err;
    }
  }

  // ============================================================================
  // AUDIO DEVICE PICKER (input & output)
  // ============================================================================

  let audioDeviceSelector = null;

  function setupAudioDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

    navigator.mediaDevices.enumerateDevices().then(devices => {
      const inputs = devices.filter(d => d.kind === 'audioinput');
      const outputs = devices.filter(d => d.kind === 'audiooutput');

      // Append a small device picker UI to the crew panel header
      const crewHead = document.querySelector('.crew-head');
      if (!crewHead || audioDeviceSelector) return;

      audioDeviceSelector = document.createElement('div');
      audioDeviceSelector.className = 'device-picker';
      audioDeviceSelector.innerHTML = `
        <div class="device-row">
          <label for="inputDevice">🎙️ Mic</label>
          <select id="inputDevice" aria-label="Pilih mikrofon"></select>
        </div>
        ${('setSinkId' in HTMLMediaElement.prototype) ? `
        <div class="device-row">
          <label for="outputDevice">🔊 Speaker</label>
          <select id="outputDevice" aria-label="Pilih speaker"></select>
        </div>
        ` : ''}
      `;
      crewHead.parentNode.insertBefore(audioDeviceSelector, crewHead.nextSibling);

      const inputSel = audioDeviceSelector.querySelector('#inputDevice');
      const outputSel = audioDeviceSelector.querySelector('#outputDevice');

      // Populate input
      inputs.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Mic (${d.deviceId.slice(0, 6)})`;
        if (localAudioTrack && d.deviceId === localAudioTrack.getSettings().deviceId) {
          opt.selected = true;
        }
        inputSel.appendChild(opt);
      });
      // Also add "default" option
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = '— Default —';
      inputSel.insertBefore(defOpt, inputSel.firstChild);

      inputSel.addEventListener('change', async () => {
        const newId = inputSel.value;
        try {
          if (newId) {
            localStorage.setItem('intercom-input-device', newId);
          } else {
            localStorage.removeItem('intercom-input-device');
          }
          // Re-acquire mic with new device
          if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
            localAudioTrack = null;
            localMicReady = false;
          }
          await ensureLocalMic();
          toast('Mikrofon diganti: ' + (inputSel.options[inputSel.selectedIndex].textContent), 'info', 2000);
        } catch (e) {
          toast('Gagal ganti mikrofon', 'error');
        }
      });

      // Populate output (only if setSinkId supported)
      if (outputSel) {
        outputs.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Speaker (${d.deviceId.slice(0, 6)})`;
          outputSel.appendChild(opt);
        });
        const defOut = document.createElement('option');
        defOut.value = '';
        defOut.textContent = '— Default —';
        outputSel.insertBefore(defOut, outputSel.firstChild);

        outputSel.addEventListener('change', () => {
          const newId = outputSel.value;
          if (newId && dom.remoteAudio.setSinkId) {
            dom.remoteAudio.setSinkId(newId).then(() => {
              localStorage.setItem('intercom-output-device', newId);
              toast('Speaker diganti: ' + (outputSel.options[outputSel.selectedIndex].textContent), 'info', 2000);
            }).catch(err => {
              console.error('[audio] setSinkId failed:', err);
              toast('Gagal ganti speaker', 'error');
            });
          } else {
            localStorage.removeItem('intercom-output-device');
          }
        });
      }

      // Watch for hot-plug (kru colok IEM / TWS di tengah acara)
      navigator.mediaDevices.addEventListener('devicechange', async () => {
        const fresh = await navigator.mediaDevices.enumerateDevices();
        const newInputs = fresh.filter(d => d.kind === 'audioinput');
        const newOutputs = fresh.filter(d => d.kind === 'audiooutput');
        if (newInputs.length !== inputs.length || newOutputs.length !== outputs.length) {
          toast('Perangkat audio berubah — refresh halaman jika perlu', 'info', 3500);
        }
      });
    }).catch(err => {
      console.warn('[audio] enumerateDevices failed:', err);
    });
  }

  function setupOutputDevice() {
    if (!('setSinkId' in HTMLMediaElement.prototype)) return;
    try {
      const savedOutputId = localStorage.getItem('intercom-output-device');
      if (savedOutputId) {
        dom.remoteAudio.setSinkId(savedOutputId).catch(() => {});
      }
    } catch (e) { /* ignore */ }
  }

  function setupAudioUnlock() {
    // Some browsers (iOS Safari especially) require a user gesture before
    // audio output is allowed to play. We unlock on first interaction.
    const unlock = () => {
      if (dom.remoteAudio) {
        dom.remoteAudio.play().catch(() => {});
      }
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('click', unlock);
    };
    document.addEventListener('touchstart', unlock, { once: true, passive: true });
    document.addEventListener('click', unlock, { once: true });
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
    if (txActive) stopTx('modechange');

    txMode = mode;

    // Toggle chip styles
    const isPtt = mode === 'ptt';
    dom.modePttBtn.classList.toggle('active', isPtt);
    dom.modeMuteBtn.classList.toggle('active', !isPtt);
    dom.modePttBtn.setAttribute('aria-selected', isPtt ? 'true' : 'false');
    dom.modeMuteBtn.setAttribute('aria-selected', !isPtt ? 'true' : 'false');

    // Toggle which big button is visible (skip if enter gate is showing)
    if (!document.getElementById('enterGate')) {
      dom.pttButton.classList.toggle('hidden', !isPtt);
      dom.muteButton.classList.toggle('hidden', isPtt);
    }

    // Update status text
    if (localMicReady) {
      dom.pttStatus.textContent = isPtt ? 'Siap · Mode PTT' : 'Siap · Mode Mute';
    }
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
      startTx('ptt-press');
    };

    const pressEnd = (e) => {
      e.preventDefault();
      if (!txActive) return;
      stopTx('ptt-release');
    };

    // Touch events (mobile)
    btn.addEventListener('touchstart', pressStart, { passive: false });
    btn.addEventListener('touchend', pressEnd, { passive: false });
    btn.addEventListener('touchcancel', pressEnd, { passive: false });

    // Mouse events (desktop testing)
    btn.addEventListener('mousedown', pressStart);
    btn.addEventListener('mouseup', pressEnd);
    btn.addEventListener('mouseleave', pressEnd);
  }

  // ============================================================================
  // MUTE TOGGLE (tap on / tap off)
  // ============================================================================

  function setupMute() {
    const btn = dom.muteButton;

    const toggle = (e) => {
      e.preventDefault();
      if (txActive) {
        stopTx('mute-toggle');
      } else {
        startTx('mute-toggle');
      }
    };

    btn.addEventListener('click', toggle);
    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (txActive) {
        stopTx('mute-toggle');
      } else {
        startTx('mute-toggle');
      }
    }, { passive: false });
  }

  // ============================================================================
  // UNIFIED TX START/STOP (used by both PTT and Mute)
  // ============================================================================

  async function startTx(reason) {
    if (txActive) return;

    // Make sure mic is acquired. If not (e.g. user skipped the gate somehow),
    // try once more.
    if (!localMicReady) {
      try {
        await ensureLocalMic();
      } catch (e) {
        return; // toast already shown
      }
    }

    txActive = true;
    if (localAudioTrack) localAudioTrack.enabled = true;
    lastTxActivityAt = Date.now();
    scheduleIdleMute();

    // Update UI for both buttons (only the visible one is rendered)
    if (txMode === 'ptt') {
      dom.pttButton.classList.add('active');
      dom.pttLabel.textContent = 'TRANSMIT';
      dom.pttHint.textContent = 'Lepaskan untuk selesai';
    } else {
      dom.muteButton.classList.add('active');
      dom.muteLabel.textContent = 'MIC ON';
      dom.muteHint.textContent = 'Tap untuk matikan';
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

    // Re-acquire wake lock in case it was released
    acquireWakeLock();
  }

  function stopTx(reason) {
    if (!txActive) return;
    txActive = false;
    if (localAudioTrack) localAudioTrack.enabled = false;
    clearIdleMute();

    // Reset both button UIs (only the visible one matters)
    dom.pttButton.classList.remove('active');
    dom.pttLabel.textContent = 'Tahan Untuk Bicara';
    dom.pttHint.textContent = 'Tekan & Tahan';

    dom.muteButton.classList.remove('active');
    dom.muteLabel.textContent = 'MIC ON';
    dom.muteHint.textContent = 'Tap untuk matikan';

    if (localMicReady) {
      dom.pttStatus.textContent = txMode === 'ptt' ? 'Siap · Mode PTT' : 'Siap · Mode Mute';
    } else {
      dom.pttStatus.textContent = 'Tekan "MASUK INTERCOM" dulu';
    }
    dom.pttStatus.classList.remove('transmitting');

    // Clear our own speaking display
    clearSpeakerIfSelf();

    // Notify server
    sendSignaling({ type: 'ptt-off' });

    if (reason && reason !== 'ptt-release' && reason !== 'mute-toggle') {
      console.log('[tx] stopped due to:', reason);
    }
  }

  // ============================================================================
  // IDLE SAFETY
  // ============================================================================

  function scheduleIdleMute() {
    clearIdleMute();
    if (txMode !== 'mute') return; // only worry about Mute Toggle (latched)
    idleMuteTimer = setTimeout(() => {
      if (txActive) {
        stopTx('idle-timeout');
        toast('Mic auto-mute setelah 60 detik. Tap lagi untuk menyalakan.', 'warn', 5000);
      }
    }, IDLE_MUTE_MS);
  }

  function clearIdleMute() {
    if (idleMuteTimer) {
      clearTimeout(idleMuteTimer);
      idleMuteTimer = null;
    }
  }

  function checkIdleMute() {
    // Double-check safety net
    if (txActive && txMode === 'mute' && Date.now() - lastTxActivityAt > IDLE_MUTE_MS) {
      stopTx('idle-check');
      toast('Mic auto-mute (60s safety). Tap lagi untuk menyalakan.', 'warn', 5000);
    }
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
        // Release any existing lock first
        if (wakeLock) {
          try { await wakeLock.release(); } catch (e) {}
          wakeLock = null;
        }
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (err) {
      // Wake lock may be denied (battery saver, etc.) — that's OK
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
        // Some browsers need an explicit play() call after src change
        dom.remoteAudio.play().catch(() => {});
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
