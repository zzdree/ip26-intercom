# 🎙️ IP26 Intercom

> **Push-to-talk intercom web untuk kru produksi event.**
> Zero-install, jalan di WiFi lokal, tanpa internet.

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![WebRTC](https://img.shields.io/badge/WebRTC-P2P%20mesh-3333ff?logo=webrtc&logoColor=white)](https://webrtc.org)
[![License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)
[![No Build](https://img.shields.io/badge/build-none-8b5cf6)](#-tech-stack)
[![Status](https://img.shields.io/badge/status-MVP-f59e0b)](#-roadmap)

Browser-based push-to-talk untuk **kru produksi event live** — camera op, switcher, ProPresenter, audio FOH, timekeeper, dan stage manager. Dirancang untuk **venue dengan WiFi lokal** (seperti auditorium, hotel ballroom, dll) **tanpa butuh internet**.

---

## ⚡ Quick start (2 menit)

```bash
# 1. Clone
git clone https://github.com/yourname/ip26-intercom.git
cd ip26-intercom

# 2. Install
npm install

# 3. Run server (di laptop / HP admin)
npm start

# 4. Lihat IP admin, misal 10.20.30.40
# 5. Kru buka di HP: http://10.20.30.40:3000
```

Server jalan di port 3000. Kru tinggal buka link, pilih role + nama, langsung bisa PTT. **No app install, no account, no internet.**

---

## 🤔 Kenapa?

Saat event live, kru produksi tersebar di venue: camera di balcony, switcher di meja samping, ProPresenter di backstage, audio di FOH booth. Mereka harus bisa **koordinasi real-time** — kasih cue, lapor ready, minta perubahan rundown.

**Solusi yang ada sekarang, dan kenapa nggak cocok:**

| Solusi | Problem |
| --- | --- |
| 📻 HT / walkie-talkie | Mahal sewa, perlu izin frekuensi, perlu charger, harus bawa unit. |
| 💬 Discord | Butuh internet, latency variable, harus install app + bikin akun, **bukan tool PTT**. |
| 🎤 Zoom / Meet | Butuh internet, latency tinggi, bukan untuk live event. |
| 📱 WhatsApp voice note | Satu arah, delay, nggak real-time. |
| 🗣️ Teriak | Nggak reliable untuk cue yang presisi. |

**Insight:** kru produksi sudah bawa HP. Venue sudah punya WiFi. Yang kurang cuma **software-nya**. IP26 Intercom = software itu.

---

## ✨ Fitur

- 🎙️ **Push-to-Talk** — tahan tombol, bicara, lepas. Audio half-duplex (satu orang bicara, semua dengar).
- 👥 **Presence real-time** — lihat siapa aja yang online + role badge.
- 🔊 **Speaker indicator** — langsung tahu siapa yang lagi ngomong.
- 📱 **Mobile-first** — dioptimalkan untuk HP, tapi juga jalan di laptop.
- 🔌 **Zero install** — browser only. Chrome, Safari, Edge, Firefox.
- 🌐 **No internet required** — semua via WiFi lokal. TURN hanya fallback.
- 🔁 **Auto-reconnect** — kalau WiFi drop sebentar, otomatis nyambung lagi.
- 🔇 **Privacy by design** — mic disabled sampai PTT ditekan. Audio tidak lewat server.
- 🎚️ **11 role preset** — CAM 1–4, Switcher, Produksi, ProPresenter 1–2, Audio FOH, Time Keeper, Lainnya.
- ⚡ **Low latency** — P2P LAN typical < 50ms airtime. PTT → terdengar < 500ms.

---

## 🆚 vs Discord

Pertanyaan yang sering muncul: *"Kan bisa pake Discord, kenapa bikin sendiri?"*

| | **IP26 Intercom** | **Discord** |
| --- | --- | --- |
| 💰 Biaya | Gratis, self-host | Gratis (dengan limit), Nitro $10/bln untuk quality |
| 🌐 Internet | **Tidak butuh** | Wajib |
| 📦 Install | Browser only | App 100+ MB atau install browser |
| 👤 Akun | Tidak perlu | Wajib, harus register, harus login |
| 🔐 Privacy | Audio tidak lewat server, LAN only | Audio lewat Discord server (centralized) |
| ⚡ Latency P2P LAN | < 50ms (host candidate) | 100–300ms (regional server) |
| 🎙️ PTT semantic | Native, hold-to-talk | Push-to-Talk harus di-toggle manual, bukan default |
| 🏷️ Role badge | Built-in (CAM 1, Switcher, dll) | Role ada, tapi tidak production-aware |
| 📍 Discoverability | Lokal saja — kru harus sudah tahu | Bisa di-invite siapa aja dari mana aja |
| 🎚️ Audio quality | Opus 32kbps, optimized for voice | Opus, variable quality |
| 🛠️ Customizability | Full source, fork sesuka hati | Tertutup, EULA |
| 🔋 Battery HP | Hemat (P2P LAN, short routes) | Lebih boros (cloud route) |

**Ringkas:** Discord itu **komunikasi umum via internet**. IP26 Intercom itu **komunikasi event-kru via WiFi lokal**. Keduanya punya use case, tapi untuk live event tanpa internet, IP26 Intercom menang telak di latency, privacy, dan simplicity.

---

## 🏗️ Arsitektur

```
┌─────────────────────────────────────────────────────────┐
│              WiFi: unnes-id (auditorium)               │
│                                                         │
│  ┌──────────┐    WSS /ws    ┌─────────────────────┐    │
│  │ Admin    │ ────────────► │  Node.js Signaling  │    │
│  │ (server) │               │  Server (Express)   │    │
│  └──────────┘               │  • presence         │    │
│                              │  • SDP/ICE relay    │    │
│                              │  • PTT broadcast    │    │
│                              └──────────┬──────────┘    │
│                                         │               │
│                          signaling only, no audio       │
│                                         │               │
│       ┌──────────────┬──────────────────┴──┐            │
│       ▼              ▼                     ▼            │
│  ┌─────────┐   ┌─────────┐            ┌─────────┐      │
│  │ HP Kru 1│◄─►│ HP Kru 2│◄──────────►│ HP Kru N│      │
│  │ CAM 1   │   │ Switcher│            │ Audio   │      │
│  └─────────┘   └─────────┘            └─────────┘      │
│     WebRTC P2P mesh audio (Opus 32kbps)                │
└─────────────────────────────────────────────────────────┘
```

**Key idea:** signaling lewat WebSocket, audio langsung P2P antar HP. Server nggak pernah dengerin audio. TURN server hanya fallback kalau P2P diblok.

Detail lengkap? Lihat [DESIGN.md](DESIGN.md).

---

## 🛠️ Tech stack

- **Backend**: Node.js 18+, Express 4, `ws` (WebSocket)
- **Frontend**: Vanilla JS, Vanilla CSS, no build step, no framework
- **Audio**: WebRTC + Opus codec, `getUserMedia` untuk mic
- **Signaling**: JSON over WebSocket (`/ws` endpoint)
- **TURN**: `global.turn.metered.ca` (replace dengan credentials sendiri untuk production)

Total dependencies: **2 packages**. `node_modules` size typical < 1 MB.

---

## 📂 Struktur

```
ip26-intercom/
├── server.js              # Express + ws signaling server
├── package.json
├── README.md              # ← you're here
├── PRD.md                 # Product Requirements Document
├── DESIGN.md              # Technical design
├── LICENSE                # MIT
├── .gitignore
└── public/
    ├── index.html         # Join page (pilih role + nama)
    ├── join.js
    ├── intercom.html      # Live PTT page
    ├── intercom.js        # WebRTC + WebSocket client
    └── style.css          # Mobile-first stylesheet
```

---

## 🧪 Testing cepat

1. **Single-device test**: buka `http://localhost:3000` di Chrome, pilih role CAM 1, klik Join. Speaker stage show "Tidak ada yang bicara". PTT button bisa di-hold. (Tidak ada peer lain = tidak ada yang dengar, tapi UI harusnya responsive.)
2. **Multi-device test**: di HP kedua (sama WiFi), buka link yang sama. Pilih role berbeda. Sekarang crew list show 2 kru. PTT di HP 1 → HP 2 dengar audio + lihat speaker indicator update.
3. **Mic permission**: browser akan minta izin mic. Wajib di-allow, kalau deny tidak akan ada audio keluar.
4. **Reconnect test**: matikan WiFi 5 detik, nyalakan lagi. Connection harus auto-recover tanpa refresh.

Detail testing lengkap di [DESIGN.md §10](DESIGN.md#10-testing).

---

## 🗺️ Roadmap

Lihat [PRD.md §9](PRD.md#9-roadmap) untuk detail.

- [x] **Phase 1 — MVP**: signaling + PTT + presence + mobile responsive
- [ ] **Phase 2 — Polish**: desktop 2-column, QR code invite, better error messages
- [ ] **Phase 3 — Production-grade**: persistent presence, speaker stats, channels
- [ ] **Phase 4 — Scale**: SFU (mediasoup) untuk > 15 user, multi-server, push notif

---

## 📜 Lisensi

MIT — lihat [LICENSE](LICENSE).

Bebas dipakai, dimodifikasi, di-distribute. Kalau mau kasih credit, link balik ke repo ini appreciated.

---

## 🙏 Credits

- Dibuat untuk **UKK UNNES** event produksi, Agustus 2026.
- Terima kasih ke kru produksi yang sudah jadi guinea pig pertama. 🫡
- WebRTC stack by Google / W3C. Signaling pakai [`ws`](https://github.com/websockets/ws) library. TURN by [Metered](https://www.metered.ca/).

---

## 📚 Dokumentasi

- 📋 [PRD.md](PRD.md) — apa & kenapa (product)
- 🏗️ [DESIGN.md](DESIGN.md) — gimana caranya (technical)
- 📦 [package.json](package.json) — dependencies & scripts
