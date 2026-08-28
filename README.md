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

## ⚡ Quick start (30 detik)

**Cara paling gampang — one-click:**

- **Windows**: double-click `start.bat`
- **Mac / Linux**: double-click `start.sh` (atau `bash start.sh` dari terminal)

Server otomatis nyala, terminal akan langsung nampilin IP address untuk kru.

**Atau manual (kalau mau lihat proses detailnya):**

```bash
# 1. Clone
git clone https://github.com/zzdree/ip26-intercom.git
cd ip26-intercom

# 2. Install (cuma sekali)
npm install

# 3. Run server (di laptop / HP admin)
npm start

# 4. Lihat IP admin di terminal, misal 192.168.1.17
# 5. Kru buka di HP: http://192.168.1.17:3000
```

Server jalan di port 3000. Kru tinggal buka link, pilih role + nama, langsung bisa bicara. **No app install, no account, no internet.**

> **📡 Soal WiFi:** aplikasi ini jalan di WiFi lokal mana aja — WiFi kos, WiFi kampus (unnes-id), hotspot HP, atau WiFi venue. Server bind ke `0.0.0.0:3000`, jadi bisa diakses lewat IP mana aja yang aktif. Gak perlu "pilih WiFi" — yang penting kru nyambung ke WiFi yang sama dengan laptop server. Lihat `start.bat` output untuk lihat semua IP yang tersedia.

---

## 🎙️ Dua mode bicara

Pilih mode yang sesuai gaya kerjamu — switch kapan aja:

| Mode | Cara Pakai | Cocok Untuk |
| --- | --- | --- |
| 📻 **Push-to-Talk** (default) | **Tahan** tombol untuk bicara, lepas untuk selesai | Cue cepat, koordinasi singkat, one-shot message |
| 🎙️ **Mute Toggle** | **Tap sekali** untuk mic ON, tap lagi untuk OFF | Ngobrol panjang, diskusi, presentasi, gosip ringan |

Tap salah satu chip mode di atas tombol utama untuk ganti. Preferensi tersimpan otomatis per device.

> **Visual cue:** Mode PTT = tombol **hijau emerald**. Mode Mute = tombol **amber/oranye**. Pas transmit, tombol jadi **lebih terang + glow ring + scale up 3%** — gampang kelihatan kalau lagi mic-on.

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

- 🎙️ **2 mode bicara** — Push-to-Talk (tahan) atau Mute Toggle (tap on/off). Pilih yang cocok per situasi.
- 👥 **Presence real-time** — lihat siapa aja yang online + role badge.
- 🔊 **Speaker indicator** — langsung tahu siapa yang lagi ngomong.
- 📱 **Mobile-first** — dioptimalkan untuk HP, tapi juga jalan di laptop.
- 🔌 **Zero install** — browser only. Chrome, Safari, Edge, Firefox.
- 🌐 **No internet required** — semua via WiFi lokal. TURN hanya fallback.
- 🔁 **Auto-reconnect** — kalau WiFi drop sebentar, otomatis nyambung lagi.
- 🔇 **Privacy by design** — mic disabled sampai PTT/Mute ditekan. Audio tidak lewat server.
- 🎚️ **11 role preset** — CAM 1–4, Switcher, Produksi, ProPresenter 1–2, Audio FOH, Time Keeper, Lainnya.
- ⚡ **Low latency** — P2P LAN typical < 50ms airtime. PTT → terdengar < 500ms.
- 🚀 **One-click launcher** — `start.bat` (Windows) / `start.sh` (Unix) handle install + run otomatis.

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
| 🎙️ PTT semantic | Native, hold-to-talk (default) ATAU mute toggle | Push-to-Talk harus di-toggle manual, bukan default |
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
│  │ Laptop   │ ◄──────────── │  Server (port 3000) │    │
│  └──────────┘    SDP/ICE    └─────────────────────┘    │
│       │                            ▲                   │
│       │ WebRTC (UDP, srflx)        │ presence          │
│       ▼                            │                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ CAM 1    │  │ Switcher │  │ Audio FOH│             │
│  │ (iPad)   │  │ (iPad)   │  │ (iPad)   │             │
│  └──────────┘  └──────────┘  └──────────┘             │
│  Full-mesh: setiap peer P2P langsung ke semua peer     │
└─────────────────────────────────────────────────────────┘
```

**Kenapa arsitektur ini?**

- **Mesh, bukan SFU** — untuk ≤ 12 peer, mesh lebih sederhana dan latency-nya lebih rendah. Tidak butuh media server.
- **WebSocket untuk signaling** — pertukaran SDP/ICE dan presence state. Cuma 1 endpoint HTTP yang perlu di-firewall.
- **WebRTC untuk audio** — Opus codec, AGC/noise-cancel/echo-cancel built-in, native browser support.
- **PTT di-track** — mic track di-disable sampai user trigger. Server tidak pernah tau audio (privacy by design).

---

## 📱 Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js ≥ 18 |
| Server | Express 4 (static + WebSocket) |
| Signaling | `ws` 8 (WebSocket) |
| Audio | WebRTC (Opus codec) |
| Frontend | Vanilla JS + Vanilla CSS, no framework |
| Build | **None** — no Webpack/Vite/babel, just open `index.html` |
| Storage | `sessionStorage` only (no localStorage tracking) |

**Total dependencies: 1 (express) + 1 (ws) = 2.**

---

## 🎬 Use Case: UKK UNNES August 2026

Event akademik tahunan Universitas Negeri Semarang. Kru produksi:

- 1× **Produksi** (stage manager)
- 1× **Switcher** (vision mixer)
- 4× **CAM 1–4** (camera ops)
- 1× **ProPresenter 1** (lyrics operator)
- 1× **ProPresenter 2** (slide operator)
- 1× **Audio FOH** (sound engineer)
- 1× **Time Keeper** (running order)

**Tanpa IP26 Intercom:** mereka teriak-teriakan atau lari ke switcher buat kasih cue. **Dengan IP26 Intercom:** satu tombol PTT di HP, cue "CAM 2 take 3" langsung terdengar semua kru.

---

## 🛣️ Roadmap

- [x] MVP: PTT + presence + role badge
- [x] Mode selector: Push-to-Talk + Mute Toggle
- [x] One-click launcher (start.bat / start.sh)
- [ ] Group channels (bisa split jadi "team camera" dan "team audio")
- [ ] Recording per event (opsional, default OFF, audio-only)
- [ ] PWA (installable ke homescreen)
- [ ] Federation (antar venue bisa bridge signaling)

---

## 📄 Lisensi

MIT — fork, modif, deploy sesuka hati.

---

## 🙏 Credits

- Yamaha QL Stage Mix — inspiration untuk kontrol mixer iPad via WiFi (tidak ada afiliasi)
- WebRTC.org — untuk spec dan reference implementation
- Tim produksi UKK UNNES — untuk use case yang valid
