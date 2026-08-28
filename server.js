/**
 * intercom IP26 — Signaling Server
 * -----------------------------------------------------------------------------
 * Self-hosted WebSocket signaling untuk WebRTC mesh antar HP kru produksi.
 * Server TIDAK relay audio — audio stream peer-to-peer via WebRTC setelah
 * signaling handshake. Server hanya:
 *   1. Track siapa saja yang terhubung (presence)
 *   2. Tukar SDP offer/answer + ICE candidates antar peer
 *   3. Broadcast status PTT (siapa yang sedang bicara) ke semua kru
 *   4. Admin API: list / kick / broadcast
 *
 * Jalankan:   npm install
 *             npm start
 *             node server.js
 *
 * Default port: 3000 (override via PORT env)
 * Listen: 0.0.0.0 (supaya bisa diakses dari device lain di WiFi lokal)
 *
 * 🌐 Jaringan target: WiFi `unnes-id` (auditorium).
 *    Divalidasi works tanpa internet — kru QL Stage Mix iPad sudah
 *    terbukti bisa kontrol mixer Yamaha QL5 via WiFi yang sama.
 *    Artinya: WebRTC P2P antar HP kru akan jalan tanpa TURN.
 *    TURN hanya jadi safety net kalau campus WiFi tiba-tiba block P2P.
 * -----------------------------------------------------------------------------
 */

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Serve static files
app.use(express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
        // Hindari caching agresif selama event (supaya update langsung terasa)
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));

// Health check (untuk verify server hidup)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        clients: clients.size,
        version: '1.1.0'
    });
});

// Admin: lihat snapshot semua peer (untuk dashboard production lead)
app.get('/api/peers', (req, res) => {
    const list = [];
    for (const [id, c] of clients) {
        list.push({
            id,
            role: c.role || 'unregistered',
            name: c.name || '—',
            roleLabel: getRoleLabel(c.role),
            speaking: c.speaking === true,
            joinedAt: c.joinedAt,
            lastSeen: c.lastSeen,
            ip: c.ip
        });
    }
    list.sort((a, b) => a.joinedAt - b.joinedAt);
    res.json({ count: list.length, peers: list, serverTime: Date.now() });
});

// Admin: kick peer by id
app.post('/api/kick', express.json(), (req, res) => {
    const { id, reason } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const c = clients.get(id);
    if (!c) return res.status(404).json({ ok: false, error: 'peer not found' });
    const msg = { type: 'kicked', reason: String(reason || 'dikeluarkan oleh admin').slice(0, 200) };
    safeSend(c.ws, msg);
    try { c.ws.close(1000, 'kicked'); } catch (e) { /* ignore */ }
    clients.delete(id);
    broadcastPresence();
    console.log(`[admin] kicked ${id} (${c.name || '?'} / ${c.role || '?'}) — reason: ${msg.reason}`);
    res.json({ ok: true });
});

// Admin: broadcast system message ke semua kru
app.post('/api/broadcast', express.json(), (req, res) => {
    const { text } = req.body || {};
    const t = String(text || '').trim().slice(0, 200);
    if (!t) return res.status(400).json({ ok: false, error: 'text required' });
    broadcast({ type: 'system', text: t });
    console.log(`[admin] broadcast: ${t}`);
    res.json({ ok: true, sent: clients.size });
});

// ============================================================================
// CLIENT REGISTRY
// ============================================================================
// Map<id, { ws, role, name, joinedAt, lastSeen }>
const clients = new Map();

function generateId() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function getRoleLabel(role) {
    const labels = {
        cam1: 'CAM 1',
        cam2: 'CAM 2',
        cam3: 'CAM 3',
        cam4: 'CAM 4',
        switcher: 'Switcher',
        production: 'Produksi',
        ppt1: 'ProPresenter 1',
        ppt2: 'ProPresenter 2',
        audio: 'Audio FOH',
        timekeeper: 'Time Keeper',
        other: 'Lainnya'
    };
    return labels[role] || role || 'Unknown';
}

function getPublicList() {
    const list = [];
    for (const [id, c] of clients) {
        list.push({
            id,
            role: c.role,
            name: c.name,
            roleLabel: getRoleLabel(c.role),
            joinedAt: c.joinedAt,
            speaking: c.speaking === true
        });
    }
    // Sort: switcher & production first, then cams, then others
    const priority = { switcher: 1, production: 2, cam1: 3, cam2: 4, cam3: 5, cam4: 6 };
    list.sort((a, b) => (priority[a.role] || 99) - (priority[b.role] || 99));
    return list;
}

function safeSend(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(payload));
            return true;
        } catch (e) {
            return false;
        }
    }
    return false;
}

function broadcast(payload, excludeId = null) {
    const data = JSON.stringify(payload);
    for (const [id, c] of clients) {
        if (id === excludeId) continue;
        if (c.ws.readyState === WebSocket.OPEN) {
            try {
                c.ws.send(data);
            } catch (e) {
                // ignore
            }
        }
    }
}

function broadcastPresence() {
    broadcast({ type: 'presence', users: getPublicList() });
}

// ============================================================================
// WEBSOCKET HANDLERS
// ============================================================================

wss.on('connection', (ws, req) => {
    const id = generateId();
    const ip = req.socket.remoteAddress;
    clients.set(id, {
        ws,
        role: null,
        name: null,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
        speaking: false,
        ip
    });

    console.log(`[+] ${id} connected from ${ip} (total: ${clients.size})`);

    // Kirim hello dengan id assigned
    safeSend(ws, { type: 'hello', id, serverTime: Date.now() });

    // Broadcast presence baru
    broadcastPresence();

    // Heartbeat: detect dead connections
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            console.warn(`[!] Invalid JSON from ${id}: ${raw}`);
            return;
        }

        const client = clients.get(id);
        if (!client) return;
        client.lastSeen = Date.now();

        handleMessage(id, client, msg);
    });

    ws.on('close', () => {
        const c = clients.get(id);
        console.log(`[-] ${id} (${c?.name || 'unknown'} / ${c?.role || 'unregistered'}) disconnected`);
        clients.delete(id);
        broadcastPresence();
    });

    ws.on('error', (err) => {
        console.error(`[!] WS error for ${id}:`, err.message);
    });
});

function handleMessage(fromId, client, msg) {
    switch (msg.type) {

        // ----- Registrasi awal: role + nama kru -----------------------------
        case 'register': {
            const { role, name } = msg;
            if (!role || !name) {
                return safeSend(client.ws, { type: 'error', error: 'role dan name wajib diisi' });
            }
            const trimmedName = String(name).trim().slice(0, 20);
            client.role = String(role).slice(0, 20);
            client.name = trimmedName;
            console.log(`[*] ${fromId} registered as ${client.role} / ${trimmedName}`);

            // Konfirmasi ke client yg baru daftar + kirim full peer list
            safeSend(client.ws, {
                type: 'registered',
                id: fromId,
                role: client.role,
                name: client.name
            });

            // Broadcast ke semua
            broadcastPresence();

            // Beri tahu peer lain untuk initiate WebRTC ke newcomer
            const newcomer = { id: fromId, role: client.role, name: client.name };
            // Existing peers diminta membuat offer ke newcomer
            broadcast({ type: 'new-peer', peer: newcomer }, fromId);
            // Newcomer diminta membuat offer ke semua existing peers
            const existingPeers = getPublicList()
                .filter(p => p.id !== fromId)
                .map(p => ({ id: p.id, role: p.role, name: p.name }));
            safeSend(client.ws, { type: 'peer-list', peers: existingPeers });
            break;
        }

        // ----- WebRTC signaling relay (SDP + ICE) ----------------------------
        case 'signal': {
            const { target, signal } = msg;
            if (!target || !signal) return;
            const targetClient = clients.get(target);
            if (!targetClient) {
                return safeSend(client.ws, { type: 'error', error: `target ${target} not found` });
            }
            safeSend(targetClient.ws, {
                type: 'signal',
                from: fromId,
                fromRole: client.role,
                fromName: client.name,
                signal
            });
            break;
        }

        // ----- PTT state broadcast ------------------------------------------
        case 'ptt-on': {
            if (!client.role) return;
            // Validasi: hanya 1 yang boleh bicara pada satu waktu (opsional)
            // Kita broadcast ke semua peer bahwa kru ini mulai bicara
            client.speaking = true;
            broadcast({
                type: 'ptt-state',
                from: fromId,
                fromRole: client.role,
                fromName: client.name,
                state: 'on'
            });
            console.log(`[ptt] ${client.name} (${client.role}) mulai bicara`);
            break;
        }

        case 'ptt-off': {
            if (!client.role) return;
            client.speaking = false;
            broadcast({
                type: 'ptt-state',
                from: fromId,
                fromRole: client.role,
                fromName: client.name,
                state: 'off'
            });
            console.log(`[ptt] ${client.name} (${client.role}) selesai bicara`);
            break;
        }

        // ----- Ping (client-side latency check) ------------------------------
        case 'ping': {
            safeSend(client.ws, { type: 'pong', t: msg.t, serverTime: Date.now() });
            break;
        }

        default:
            console.warn(`[?] Unknown message type from ${fromId}: ${msg.type}`);
    }
}

// Heartbeat interval: terminate dead connections
const heartbeat = setInterval(() => {
    for (const [id, c] of clients) {
        if (c.ws.readyState === WebSocket.OPEN) {
            if (c.ws.isAlive === false) {
                console.log(`[~] ${id} failed heartbeat, terminating`);
                c.ws.terminate();
                clients.delete(id);
                broadcastPresence();
                continue;
            }
            c.ws.isAlive = false;
            try { c.ws.ping(); } catch (e) { /* ignore */ }
        }
    }
}, 30000);

// ============================================================================
// STARTUP
// ============================================================================

function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push({ name, address: iface.address });
            }
        }
    }
    return ips;
}

server.listen(PORT, HOST, () => {
    const ips = getLocalIPs();
    console.log('');
    console.log('================================================================');
    console.log('  🎙️  intercom IP26 — Signaling Server Aktif');
    console.log('================================================================');
    console.log(`  Port     : ${PORT}`);
    console.log(`  Host     : ${HOST}`);
    console.log(`  Mode     : WebRTC mesh (P2P audio, signaling only)`);
    console.log(`  Maks     : 12 peer simultan (cocok untuk tim produksi)`);
    console.log('----------------------------------------------------------------');
    console.log('  📡  Akses dari device di WiFi lokal yang sama:');
    console.log(`     📱 /intercom    — HP kru (PTT)`);
    console.log(`     👑 /admin       — Dashboard production lead (laptop/desktop)`);
    console.log(`     🔌 /api/peers   — JSON snapshot semua peer`);
    console.log(`     💚 /health      — Server status`);
    console.log('----------------------------------------------------------------');
    for (const { name, address } of ips) {
        console.log(`     → http://${address}:${PORT}    [${name}]`);
    }
    if (ips.length === 0) {
        console.log('     ⚠️  Tidak ada IP LAN terdeteksi. Cek koneksi WiFi.');
    }
    console.log('----------------------------------------------------------------');
    console.log('  ⏹️   Tekan Ctrl+C untuk menghentikan server.');
    console.log('================================================================');
    console.log('');
});

// Graceful shutdown
function shutdown(signal) {
    console.log(`\n[!] Received ${signal}, shutting down...`);
    clearInterval(heartbeat);
    broadcast({ type: 'server-shutdown' });
    setTimeout(() => {
        wss.close();
        server.close(() => process.exit(0));
    }, 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
