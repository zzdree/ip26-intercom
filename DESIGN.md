# Technical Design — IP26-Intercom

> **Versi:** 1.0.0
> **Status:** MVP — production-ready untuk venue test
> **Last updated:** 2026-08-28

---

## 1. Arsitektur Tinggi

```
┌────────────────────────────────────────────────────────────────┐
│                     JARINGAN: unnes-id WiFi                    │
│                                                                │
│  ┌──────────┐    WSS /ws     ┌──────────────────────────────┐  │
│  │ Admin HP │ ─────────────► │  Node.js Signaling Server   │  │
│  │ (server) │                │  (Express + ws)             │  │
│  └──────────┘                │  - presence registry        │  │
│                              │  - SDP/ICE relay            │  │
│                              │  - PTT state broadcast      │  │
│                              └────────────┬─────────────────┘  │
│                                           │                    │
│                          (signaling only, no audio)            │
│                                           │                    │
│       ┌──────────────┬────────────────────┴─────┐             │
│       │              │                          │             │
│       ▼              ▼                          ▼             │
│  ┌─────────┐    ┌─────────┐                ┌─────────┐        │
│  │ HP Kru 1│◄──►│ HP Kru 2│◄──────────────►│ HP Kru N│        │
│  │ CAM 1   │    │ Switcher│                │ Audio   │        │
│  │         │    │         │                │         │        │
│  └─────────┘    └─────────┘                └─────────┘        │
│     WebRTC P2P mesh audio (Opus 32kbps)                        │
│     Tidak lewat server. Low latency.                           │
└────────────────────────────────────────────────────────────────┘

           ▼ (hanya kalau P2P diblok) ▼

      ┌──────────────────────────────┐
      │  TURN Server (metered.ca)   │  fallback relay
      │  - Audio relay kalau P2P    │  (jarang dipakai di
      │    diblok network           │   unnes-id, validated)
      └──────────────────────────────┘
```

---

## 2. Komponen

### 2.1 `server.js` — Signaling Server

- **Stack**: Node.js 18+, Express 4, `ws` 8.
- **Listen**: `0.0.0.0:3000` (default). Override via `PORT` env.
- **Path**:
  - `GET /*` — static files dari `public/`.
  - `GET /health` — JSON health check.
  - `WS /ws` — signaling WebSocket.
- **State**: `Map<id, { ws, role, name, joinedAt, lastSeen }>`.
- **TIDAK** relay audio. Hanya signaling.
- **TIDAK** auth. Identitas = role + display name dari client.

### 2.2 `public/index.html` — Join Page

- Form: pilih role (radio) + display name.
- Submit → `localStorage` identity → redirect ke `intercom.html`.
- Validasi mic permission.
- Tampilan: dark theme, mobile-first.

### 2.3 `public/intercom.html` — Live PTT Page

- **Header**: identity (role + nama), connection status, leave button.
- **Speaker stage**: nama + role orang yang sedang bicara.
- **PTT button**: hold-to-talk, 200×200px, dark default, glow red saat aktif.
- **Crew panel**: daftar kru online + role badge + "you" / "speaking" indicator.
- **Audio element**: hidden, autoplay, gets remote streams.
- **Toast**: connection events, mic permission errors.

### 2.4 `public/intercom.js` — Client Logic

- **WebSocket lifecycle**: connect → send `hello` → receive `peer-list` / `peer-joined` / `peer-left`.
- **WebRTC lifecycle**: untuk setiap peer, create `RTCPeerConnection`, exchange SDP via signaling, exchange ICE candidates.
- **PTT handler**: mousedown / touchstart → enable track + broadcast `ptt-on`; mouseup / touchend → disable track + broadcast `ptt-off`.
- **Auto-reconnect**: WebSocket close → exponential backoff (1s, 2s, 4s, 8s, max 15s).
- **TURN config**: `global.turn.metered.ca` (port 443/3478). TAPI expected tidak dipakai di unnes-id.

### 2.5 `public/join.js` — Join Form Logic

- Form submit handler.
- `getUserMedia({ audio: true })` untuk pre-acquire mic permission.
- Save identity to `localStorage` (key: `intercom.identity`).
- Redirect ke `intercom.html`.

### 2.6 `public/style.css` — Stylesheet

- Vanilla CSS, ~900 baris, mobile-first.
- Dark theme default + light theme via `[data-theme="light"]`.
- Design tokens di `:root` (CSS custom properties).
- Breakpoints:
  - `max-height: 700px` — compact mode untuk HP landscape.
  - `min-width: 768px` — tablet / laptop.

---

## 3. WebSocket Protocol

Server hanya relay messages; tidak interpret logic. Semua message adalah JSON.

### 3.1 Client → Server

| Type | Payload | Tujuan |
| --- | --- | --- |
| `hello` | `{ role, name }` | Pertama kali connect, daftar sebagai participant. Server reply dengan `welcome`. |
| `offer` | `{ to, sdp }` | WebRTC SDP offer ke peer tertentu. |
| `answer` | `{ to, sdp }` | WebRTC SDP answer. |
| `ice-candidate` | `{ to, candidate }` | ICE candidate untuk NAT traversal. |
| `ptt-on` | `{}` | Broadcast: gue lagi ngomong. |
| `ptt-off` | `{}` | Broadcast: gue udah selesai. |
| `ping` | `{}` | Heartbeat (optional, TCP keepalive biasanya cukup). |

### 3.2 Server → Client

| Type | Payload | Tujuan |
| --- | --- | --- |
| `welcome` | `{ id, peers: [...] }` | Reply hello. Beri id + list peer yang sudah ada. |
| `peer-joined` | `{ id, role, name }` | Broadcast: ada kru baru. |
| `peer-left` | `{ id }` | Broadcast: ada kru disconnect. |
| `offer` | `{ from, sdp }` | Relay dari peer lain. |
| `answer` | `{ from, sdp }` | Relay dari peer lain. |
| `ice-candidate` | `{ from, candidate }` | Relay dari peer lain. |
| `ptt-on` | `{ id, role, name }` | Broadcast: ada kru yang PTT. |
| `ptt-off` | `{ id }` | Broadcast: kru sudah selesai PTT. |
| `error` | `{ code, message }` | Generic error. |

### 3.3 Connection Lifecycle

```
Client                                  Server
  │                                        │
  │  ──── WS upgrade /ws ───────────────►  │
  │  ◄──── 101 Switching Protocols ──────  │
  │                                        │
  │  ──── { type: "hello", role, name } ►  │
  │  ◄─── { type: "welcome", id, peers }  │
  │                                        │
  │       (for each existing peer)        │
  │  ◄── { type: "offer", from, sdp }     │
  │  ──► { type: "answer", to, sdp }      │
  │  ◄► { type: "ice-candidate", ... }    │
  │                                        │
  │       (when new peer joins)           │
  │  ◄── { type: "peer-joined", ... }     │
  │  ──► { type: "offer", to, sdp }       │
  │  ◄── { type: "answer", from, sdp }    │
  │                                        │
  │       (PTT event)                     │
  │  ──► { type: "ptt-on" } ────────────►  │
  │  ─── { type: "ptt-off" } ───────────►  │
  │                                        │
  │  ──── WS close ─────────────────────►  │
  │  ◄── { type: "peer-left", id } ───►   │ (broadcast ke semua)
```

---

## 4. WebRTC Peer Connection

### 4.1 Codec & Constraints

- **Audio codec**: Opus (default WebRTC, browser-native).
- **Bitrate**: 32 kbps (cukup untuk voice, hemat bandwidth).
- **Echo cancellation**: enabled.
- **Noise suppression**: enabled.
- **Auto gain control**: enabled.
- **Sample rate**: browser default (48 kHz typical).

### 4.2 Connection per Peer

Untuk N kru online, setiap kru maintain **N-1 RTCPeerConnection** (full mesh).
Untuk MVP dengan 8–12 kru, ini masih OK. Di Phase 4 (scale), switch ke SFU
(`mediasoup` atau `ion-sfu`).

### 4.3 ICE Configuration

```js
{
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },     // STUN publik
    {                                          // TURN fallback
      urls: 'turn:global.turn.metered.ca:443',
      username: '...',
      credential: '...'
    }
  ]
}
```

**Expected**: di unnes-id, ICE akan resolve ke **host candidate** lokal
(LAN), karena semua kru satu subnet. STUN/TURN jarang dipakai.

**TURN** hanya aktif kalau P2P diblok (misal: ada AP isolation, ada
firewall aneh). Validated: kru QL Stage Mix iPad sudah bisa kontrol
mixer QL5 via unnes-id tanpa internet, artinya LAN P2P works.

### 4.4 PTT & Audio Routing

- **Local mic** di-`getUserMedia` saat join, track di-`enabled = false` sampai PTT ditekan.
- **Track.enabled = true** saat PTT active (hold).
- **Track.enabled = false** saat PTT release.
- **PTT event** di-broadcast via WebSocket agar UI peer lain bisa update
  speaker indicator (TANPA peer harus decode audio dulu).

### 4.5 Reconnection

- **WebSocket close** → exponential backoff reconnect (1s, 2s, 4s, 8s, max 15s).
- Setelah reconnect → kirim `hello` lagi → dapat peer list baru → re-negotiate.
- **WebRTC peer disconnect** → on `iceconnectionstatechange === 'disconnected'` → tunggu 5s → kalau masih 'failed', close PC, recreate.
- **Page refresh** → identity masih di `localStorage` → bisa langsung rejoin dengan role yang sama.

---

## 5. File Structure

```
ip26-intercom/
├── server.js                # Express + ws signaling
├── package.json             # name, deps, scripts
├── package-lock.json        # (generated by npm install)
├── README.md                # Marketing/usage doc
├── PRD.md                   # Product requirements
├── DESIGN.md                # ← file ini
├── ABOUT.md                 # Story & acknowledgments
├── TOPICS.md                # FAQ & use cases
├── .gitignore               # node_modules, .env
└── public/
    ├── index.html           # Join page
    ├── join.js              # Join form logic
    ├── intercom.html        # Live PTT page
    ├── intercom.js          # Client logic
    └── style.css            # Stylesheet
```

---

## 6. Configuration

### 6.1 Environment

| Variable | Default | Tujuan |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port. |
| `HOST` | `0.0.0.0` | HTTP listen address. |

### 6.2 TURN Credentials

Di `public/intercom.js`, `ICE_SERVERS` array. Saat ini pakai placeholder.
**Untuk production, generate di [metered.ca dashboard](https://app.metered.ca/)**
dan replace.

### 6.3 Network

- Default: jalan di WiFi `unnes-id`, server IP = IP admin HP (misal `10.x.x.x`).
- Kru akses: `http://10.x.x.x:3000/`.
- Recommended: host server di laptop admin (lebih stabil dari HP).

---

## 7. Security & Privacy

- **No auth** (sengaja, untuk MVP). Identitas = role + display name.
- **No audio lewat server** (P2P only, audio encrypted DTLS-SRTP by default).
- **No recording** (sengaja, MVP).
- **LAN only** (sengaja, no public deployment).
- **WebSocket origin check** (TODO Phase 2): validate `Origin` header untuk
  prevent random web page connect ke server kita.

---

## 8. Performance

- **Mesh P2P** untuk ≤ 12 kru. Bandwidth per kru: upload ~32 kbps + (N-1) × 32 kbps download.
- **Latency**: P2P LAN typical < 50ms. Target PTT latency < 500ms (termasuk airtime).
- **CPU**: opus encode/decode di ~2% per stream di HP modern.
- **Battery**: typical 5–8% per jam saat active PTT (Opus codec di browser efficient).

---

## 9. Future: Scale

### Phase 4 — SFU

Pindah ke **Selective Forwarding Unit** (mediasoup / ion-sfu) saat N > 15.
SFU server receive satu stream per publisher, forward ke semua subscriber.
Bandwidth dari publisher: 1× stream. Bandwidth server: O(N²) tapi aggregated
di core, bukan di HP kru.

### Phase 4 — Multi-server

Multiple signaling server (Redis pub/sub untuk sync state), multiple SFU.
Lakukan DNS round-robin atau sticky session.

---

## 10. Testing

### 10.1 Manual test checklist (pre-event)

- [ ] Server start OK, `/health` return 200.
- [ ] Join page render di Chrome desktop.
- [ ] Join page render di Safari iOS.
- [ ] Pilih role, klik join, redirect ke intercom.
- [ ] Mic permission popup muncul.
- [ ] Speaker stage initially "Tidak ada yang bicara".
- [ ] PTT button bisa di-hold.
- [ ] Saat PTT, speaker stage update.
- [ ] Crew list show kru sendiri + 0 others.
- [ ] Buka tab kedua sebagai peer kedua.
- [ ] Crew list show 2 kru.
- [ ] PTT di tab 1 → tab 2 hear audio + see speaker.
- [ ] Close tab 1 → tab 2 crew list update ke 1.
- [ ] Kill WiFi 5 detik → auto-reconnect.
- [ ] Switch ke WiFi lain (test TURN path).

### 10.2 Load test

Untuk MVP cukup manual test 4–6 HP di satu venue. Load test dengan
artificial peers (Node.js + `wrtc`) bisa di Phase 2.

---

**Owner:** Andreas · **License:** MIT
