/**
 * IP26-Intercom — Join page logic
 * -----------------------------------------------------------------------------
 * Validates form, registers identity with signaling server via WebSocket,
 * then navigates to intercom.html. Self-contained, no build step.
 * -----------------------------------------------------------------------------
 */

(function () {
  'use strict';

  // ---------- Server health check ----------
  const statusEl = document.getElementById('serverStatus');

  function pingServer() {
    fetch('/health', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        statusEl.textContent = `✓ Server online · ${data.clients} kru terhubung`;
        statusEl.style.color = 'var(--accent-green)';
      })
      .catch(err => {
        statusEl.textContent = '✗ Server tidak terdeteksi. Pastikan server sudah berjalan.';
        statusEl.style.color = 'var(--accent-hot)';
      });
  }
  pingServer();
  setInterval(pingServer, 8000);

  // ---------- Form handling ----------
  const form = document.getElementById('joinForm');
  const nameInput = document.getElementById('name');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const roleEl = form.querySelector('input[name="role"]:checked');

    if (!name) {
      nameInput.focus();
      nameInput.style.borderColor = 'var(--accent-hot)';
      setTimeout(() => { nameInput.style.borderColor = ''; }, 1500);
      return;
    }

    if (!roleEl) {
      // Highlight the role grid
      const grid = form.querySelector('.role-grid');
      grid.style.boxShadow = '0 0 0 2px var(--accent-hot)';
      setTimeout(() => { grid.style.boxShadow = ''; }, 1200);
      return;
    }

    const role = roleEl.value;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Menghubungkan...</span>';

    // Connect WebSocket and register
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${location.host}/ws`;
    let ws = null;
    let registerTimeout = null;

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      showError('Gagal membuka WebSocket. Coba lagi.');
      resetForm();
      return;
    }

    registerTimeout = setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
      showError('Timeout. Server tidak merespons.');
      resetForm();
    }, 5000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', role, name }));
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }

      if (msg.type === 'registered') {
        clearTimeout(registerTimeout);
        // Save identity to sessionStorage for intercom.html
        const identity = {
          id: msg.id,
          role: msg.role,
          name: msg.name,
          serverHost: location.host
        };
        try {
          sessionStorage.setItem('intercom-identity', JSON.stringify(identity));
          // Mark this as a "warmed" user gesture context — the join button click
          // Mark this as a "warmed" user gesture context — the join button click    // already counts as a user gesture, so intercom.html can request mic
          // permission immediately without showing the enter-gate overlay.
          sessionStorage.setItem('intercom-warmed', '1');
        } catch (e) { /* private mode etc. */ }
        // Redirect
        window.location.href = 'intercom.html';
      }

      if (msg.type === 'error') {
        clearTimeout(registerTimeout);
        showError(msg.error || 'Gagal registrasi.');
        resetForm();
      }
    };

    ws.onerror = () => {
      clearTimeout(registerTimeout);
      showError('Koneksi ke server gagal. Periksa WiFi Anda.');
      resetForm();
    };

    ws.onclose = () => {
      // If we reach here without registered, something went wrong
    };
  });

  function resetForm() {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<span>Masuk intercom</span><span class="arrow" aria-hidden="true">→</span>';
  }

  function showError(text) {
    statusEl.textContent = '✗ ' + text;
    statusEl.style.color = 'var(--accent-hot)';
  }

  // Auto-fill name if returning user has it in sessionStorage
  try {
    const cached = sessionStorage.getItem('intercom-identity');
    if (cached) {
      const data = JSON.parse(cached);
      if (data.name) nameInput.value = data.name;
      if (data.role) {
        const radio = form.querySelector(`input[name="role"][value="${data.role}"]`);
        if (radio) radio.checked = true;
      }
    }
  } catch (e) { /* ignore */ }

  // Live validation: trim name as you type
  nameInput.addEventListener('input', () => {
    if (nameInput.value.length > 20) {
      nameInput.value = nameInput.value.slice(0, 20);
    }
  });

})();
