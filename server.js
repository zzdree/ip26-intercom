/**
 * IP26-Intercom — Signaling Server (HTTP + HTTPS paralel)
 * -----------------------------------------------------------------------------
 * Self-hosted WebSocket signaling untuk WebRTC mesh antar HP kru produksi.
 *
 * Server listen di DUA protokol:
 *   - HTTP  :3000 — admin / fallback
 *   - HTTPS :3443 — PRIMARY untuk HP kru (getUserMedia butuh secure context)
 *
 * HTTPS pakai self-signed cert yang di-generate on-the-fly. Saat pertama akses
 * dari HP, browser tampil "Not Secure" — klik Advanced → Proceed. Setelah itu
 * Chrome mengingat pengecualian dan getUserMedia(mic) langsung muncul prompt-nya.
 *
 * Jalankan:   npm install
 *             npm start
 *             node server.js
 * -----------------------------------------------------------------------------
 */

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');
const selfsigned = require('selfsigned');
const { WebSocketServer, WebSocket } = require('ws');

const PORT_HTTP = parseInt(process.env.PORT || '3000', 10);
const PORT_HTTPS = parseInt(process.env.PORT_HTTPS || '3443', 10);
const HOST = process.env.HOST || '0.0.0.0';

// TURN server config from env (secure, not exposed to client directly)
const TURN_CONFIG = {
    username: process.env.TURN_USERNAME || 'e7f3a4b2c1d9e8f6a5b4c3d2e1f0a9b8',
    credential: process.env.TURN_CREDENTIAL || 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
    urls: [
        'turn:global.turn.metered.ca:80',
        'turn:global.turn.metered.ca:443'
    ]
};

// CSP header middleware
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "font-src 'self' data:; " +
        "connect-src 'self' wss: https:; " +
        "media-src 'self' blob:; " +
        "frame-ancestors 'none'; " +
        "base-uri 'self'; " +
        "form-action 'self'"
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// ============================================================================
// 1. APP & STATIC ASSETS
// ============================================================================
const app = express();

app.use(express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));

// TURN config endpoint - serves credentials securely from server
app.get('/api/turn-config', (req, res) => {
    res.json({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            {
                urls: TURN_CONFIG.urls[0],
                username: TURN_CONFIG.username,
                credential: TURN_CONFIG.credential
            },
            {
                urls: TURN_CONFIG.urls[1],
                username: TURN_CONFIG.username,
                credential: TURN_CONFIG.credential
            }
        ],
        iceCandidatePoolSize: 10
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        clients: clients.size,
        version: '1.2.0',
        https: true
    });
});

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
            ip: c.ip,
            secure: c.secure === true
        });
    }
    list.sort((a, b) => a.joinedAt - b.joinedAt);
    res.json({ count: list.length, peers: list, serverTime: Date.now() });
});

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

app.post('/api/broadcast', express.json(), (req, res) => {
    const { text } = req.body || {};
    const t = String(text || '').trim().slice(0, 200);
    if (!t) return res.status(400).json({ ok: false, error: 'text required' });
    broadcast({ type: 'system', text: t });
    console.log(`[admin] broadcast: ${t}`);
    res.json({ ok: true, sent: clients.size });
});

// ============================================================================
// 2. SELF-SIGNED CERTIFICATE
// ============================================================================
async function generateCert() {
    const certPath = path.join(__dirname, '.cert.pem');
    const keyPath = path.join(__dirname, '.key.pem');

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        const age = Date.now() - fs.statSync(certPath).mtimeMs;
        if (age < 30 * 24 * 60 * 60 * 1000) {
            console.log('[cert] Reusing existing self-signed certificate');
            return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
        }
    }

    console.log('[cert] Generating new self-signed certificate (~500ms)...');

    // SAN: pisahkan DNS names (type 2) dari IPv4 (type 7). Jangan campur.
    const dnsNames = ['localhost', 'intercom-ip26.local'];
    const ipv4s = ['127.0.0.1'];
    const interfaces = os.networkInterfaces();
    const seen = new Set(ipv4s);
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(iface.address) && !seen.has(iface.address)) {
                    seen.add(iface.address);
                    ipv4s.push(iface.address);
                }
            }
        }
    }

    const attrs = [{ name: 'commonName', value: 'intercom-ip26.local' }];
    const pems = await selfsigned.generate(attrs, {
        algorithm: 'sha256',
        days: 365,
        keySize: 2048,
        extensions: [
            { name: 'basicConstraints', cA: true },
            {
                name: 'subjectAltName',
                altNames: [
                    ...dnsNames.map(d => ({ type: 2, value: d })),
                    ...ipv4s.map(ip => ({ type: 7, ip }))
                ]
            }
        ]
    });

    fs.writeFileSync(certPath, pems.cert);
    fs.writeFileSync(keyPath, pems.private);
    console.log(`[cert] Generated. DNS: ${dnsNames.join(', ')} | IPv4: ${ipv4s.join(', ')}`);

    return { cert: pems.cert, key: pems.private };
}

// ============================================================================
// 3. CLIENT REGISTRY & HELPERS
// ============================================================================
const clients = new Map();

function generateId() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function getRoleLabel(role) {
    const labels = {
        cam1: 'CAM 1', cam2: 'CAM 2', cam3: 'CAM 3', cam4: 'CAM 4',
        switcher: 'Switcher', production: 'Produksi',
        ppt1: 'ProPresenter 1', ppt2: 'ProPresenter 2',
        audio: 'Audio FOH', timekeeper: 'Time Keeper', other: 'Lainnya'
    };
    return labels[role] || role || 'Unknown';
}

function getPublicList() {
    const list = [];
    for (const [id, c] of clients) {
        list.push({
            id, role: c.role, name: c.name,
            roleLabel: getRoleLabel(c.role),
            joinedAt: c.joinedAt,
            speaking: c.speaking === true,
            secure: c.secure === true
        });
    }
    const priority = { switcher: 1, production: 2, cam1: 3, cam2: 4, cam3: 5, cam4: 6 };
    list.sort((a, b) => (priority[a.role] || 99) - (priority[b.role] || 99));
    return list;
}

function safeSend(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(payload)); return true; }
        catch (e) { return false; }
    }
    return false;
}

function broadcast(payload, excludeId = null) {
    const data = JSON.stringify(payload);
    for (const [id, c] of clients) {
        if (id === excludeId) continue;
        if (c.ws.readyState === WebSocket.OPEN) {
            try { c.ws.send(data); } catch (e) { /* ignore */ }
        }
    }
}

function broadcastPresence() {
    broadcast({ type: 'presence', users: getPublicList() });
}

// ============================================================================
// 4. WEBSOCKET HANDLERS
// ============================================================================
function handleConnection(wss, secure) {
    wss.on('connection', (ws, req) => {
        const id = generateId();
        const ip = req.socket.remoteAddress;
        clients.set(id, {
            ws, role: null, name: null,
            joinedAt: Date.now(), lastSeen: Date.now(),
            speaking: false, ip, secure
        });

        const proto = secure ? 'WSS' : 'WS';
        console.log(`[+] ${id} connected via ${proto} from ${ip} (total: ${clients.size})`);

        safeSend(ws, { type: 'hello', id, secure, serverTime: Date.now() });
        broadcastPresence();

        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); }
            catch (e) { console.warn(`[!] Invalid JSON from ${id}: ${raw}`); return; }

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
}

function handleMessage(fromId, client, msg) {
    switch (msg.type) {

        case 'register': {
            const { role, name } = msg;
            if (!role || !name) {
                return safeSend(client.ws, { type: 'error', error: 'role dan name wajib diisi' });
            }
            const trimmedName = String(name).trim().slice(0, 20);
            client.role = String(role).slice(0, 20);
            client.name = trimmedName;
            console.log(`[*] ${fromId} registered as ${client.role} / ${trimmedName}`);

            safeSend(client.ws, {
                type: 'registered', id: fromId,
                role: client.role, name: client.name
            });

            broadcastPresence();

            const newcomer = { id: fromId, role: client.role, name: client.name };
            broadcast({ type: 'new-peer', peer: newcomer }, fromId);
            const existingPeers = getPublicList()
                .filter(p => p.id !== fromId)
                .map(p => ({ id: p.id, role: p.role, name: p.name }));
            safeSend(client.ws, { type: 'peer-list', peers: existingPeers });
            break;
        }

        case 'signal': {
            const { target, signal } = msg;
            if (!target || !signal) return;
            const targetClient = clients.get(target);
            if (!targetClient) {
                return safeSend(client.ws, { type: 'error', error: `target ${target} not found` });
            }
            safeSend(targetClient.ws, {
                type: 'signal', from: fromId,
                fromRole: client.role, fromName: client.name, signal
            });
            break;
        }

        case 'ptt-on': {
            if (!client.role) return;
            client.speaking = true;
            broadcast({
                type: 'ptt-state', from: fromId,
                fromRole: client.role, fromName: client.name, state: 'on'
            });
            console.log(`[ptt] ${client.name} (${client.role}) mulai bicara`);
            break;
        }

        case 'ptt-off': {
            if (!client.role) return;
            client.speaking = false;
            broadcast({
                type: 'ptt-state', from: fromId,
                fromRole: client.role, fromName: client.name, state: 'off'
            });
            console.log(`[ptt] ${client.name} (${client.role}) selesai bicara`);
            break;
        }

        case 'ping': {
            safeSend(client.ws, { type: 'pong', t: msg.t, serverTime: Date.now() });
            break;
        }

        default:
            console.warn(`[?] Unknown message type from ${fromId}: ${msg.type}`);
    }
}

let heartbeat = null;

function startHeartbeat() {
    heartbeat = setInterval(() => {
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
}

// ============================================================================
// 5. STARTUP
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

function printBanner() {
    const ips = getLocalIPs();
    console.log('');
    console.log('================================================================');
    console.log('  🎙️  IP26-Intercom — Signaling Server Aktif (HTTP + HTTPS)');
    console.log('================================================================');
    console.log(`  HTTP   : ${PORT_HTTP}   (fallback / admin)`);
    console.log(`  HTTPS  : ${PORT_HTTPS}   (PRIMARY — wajib untuk mic di HP)`);
    console.log(`  Host   : ${HOST}`);
    console.log(`  Mode   : WebRTC mesh (P2P audio, signaling only)`);
    console.log(`  Maks   : 12 peer simultan`);
    console.log('----------------------------------------------------------------');
    console.log('  📡  Akses dari device di WiFi lokal yang sama:');
    console.log(`     📱 HTTPS intercom → https://<IP>:${PORT_HTTPS}/intercom   (WAJIB HTTPS!)`);
    console.log(`     👑 HTTP  admin    → http://<IP>:${PORT_HTTP}/admin`);
    console.log(`     🔌 API  peers     → http://<IP>:${PORT_HTTP}/api/peers`);
    console.log(`     💚 Health         → http://<IP>:${PORT_HTTP}/health`);
    console.log('----------------------------------------------------------------');
    console.log('  ⚠️  HTTPS akan tampil "Not Secure" — itu NORMAL untuk self-signed.');
    console.log('     Klik "Advanced" → "Proceed to ..." sekali, lalu mic akan jalan.');
    console.log('----------------------------------------------------------------');
    for (const { name, address } of ips) {
        console.log(`     → http://${address}:${PORT_HTTP}  &  https://${address}:${PORT_HTTPS}  [${name}]`);
    }
    if (ips.length === 0) {
        console.log('     ⚠️  Tidak ada IP LAN terdeteksi. Cek koneksi WiFi.');
    }
    console.log('----------------------------------------------------------------');
    console.log('  ⏹️   Tekan Ctrl+C untuk menghentikan server.');
    console.log('================================================================');
    console.log('');
}

async function main() {
    const tlsMaterial = await generateCert();

    const httpServer = http.createServer(app);
    const httpsServer = https.createServer(tlsMaterial, app);

    const wssHttp = new WebSocketServer({ server: httpServer, path: '/ws' });
    const wssHttps = new WebSocketServer({ server: httpsServer, path: '/ws' });

    handleConnection(wssHttp, false);
    handleConnection(wssHttps, true);

    startHeartbeat();

    httpServer.listen(PORT_HTTP, HOST, printBanner);
    httpsServer.listen(PORT_HTTPS, HOST, () => { /* banner sudah di-print */ });

    function shutdown(signal) {
        console.log(`\n[!] Received ${signal}, shutting down...`);
        if (heartbeat) clearInterval(heartbeat);
        broadcast({ type: 'server-shutdown' });
        setTimeout(() => {
            wssHttp.close();
            wssHttps.close();
            httpServer.close(() => {});
            httpsServer.close(() => process.exit(0));
        }, 500);
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
    console.error('[FATAL] Failed to start server:', err);
    process.exit(1);
});
