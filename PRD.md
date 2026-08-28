# Product Requirements Document — IP26 Intercom

> **Project:** `ip26-intercom`
> **Owner:** Andreas (kru produksi IP26 — UKK UNNES)
> **Event:** UKK UNNES, Auditorium UNNES
> **Tanggal:** 2026-08-28
> **Status:** MVP — siap untuk dry-run

---

## 1. Vision

> **Komunikasi push-to-talk zero-install untuk kru produksi event,
> via WiFi lokal auditorium, tanpa internet, tanpa app.**

---

## 2. Problem Statement

Saat event live (konser, seminar, wedding, dll), kru produksi tersebar di
seluruh venue — camera operator di balcony, switcher di meja samping panggung,
ProPresenter di backstage, audio FOH di ruangan akustik, timekeeper di
sayap panggung. Mereka **harus bisa komunikasi real-time, full-duplex atau
half-duplex (PTT)**, untuk koordinasi cue, perubahan rundown, dan emergency.

**Solusi yang ada saat ini di pasaran:**

| Solusi | Problem |
| --- | --- |
| **HT (walkie-talkie)** | Mahal (sewa), perlu frekuensi, perlu izin, perlu charger, perlu baterai, harus bawa unit fisik. |
| **Discord** | Butuh internet, latency variable, perlu akun, perlu install app, suara bisa patah-patah, **tidak didesain untuk live event** (no PTT, no presence-aware, no role badge). |
| **WhatsApp voice note** | Butuh internet, satu arah, tidak real-time, anti-sosial saat event. |
| **Zoom / Google Meet** | Butuh internet, berat, latency tinggi, bukan tools PTT. |
| **DIY tanpa infrastruktur** | Teriak, hand signal — tidak reliable untuk cue yang presisi. |

**Insight:** Kru produksi sudah **bawa HP masing-masing**, dan venue biasanya
sudah punya **WiFi lokal** (atau access point murah). Yang kurang hanya
**software-nya**.

---

## 3. Target Users

### Primary: Kru Produksi Event

| Role | Use case utama |
| --- | --- |
| **CAM 1–4** | Koordinasi pindah angle, minta "ready cue" dari switcher, lapor "shot ready". |
| **Switcher** | Trigger cue ke cam op, info rundown, minta "ready on CAM 2". |
| **Produksi** | Koordinator pusat, kasih aba-aba, kontrol seluruh tim. |
| **ProPresenter 1–2** | Koordinasi slide change, info slide cue, lyric trigger. |
| **Audio FOH** | Lapor "audio ready", minta "fade music", "kill mic". |
| **Time Keeper** | Lapor countdown, info "5 menit lagi", "start cue". |
| **Lainnya** | Lighting, stage manager, runner, dll. |

### Secondary: Kru Event non-produksi

Misalnya tim security, tim registrasi, tim dokumentasi — semua yang perlu
komunikasi cepat tapi **bukan tim core** produksi. Saat MVP cukup pakai
role "Lainnya" dulu.

---

## 4. User Stories

### MVP (wajib ada untuk event pertama)

- **US-01**: Kru bisa buka halaman join di HP browser, pilih role + nama, lalu masuk ke live intercom dalam **< 10 detik**.
- **US-02**: Kru bisa **press-and-hold** tombol PTT untuk bicara, dan **semua kru lain mendengar suaranya** dalam **< 500 ms** (low-latency).
- **US-03**: Kru bisa **lihat siapa yang sedang bicara** saat ini (real-time speaker indicator).
- **US-04**: Kru bisa **lihat daftar kru yang online** (presence), dengan role badge.
- **US-05**: Kru bisa **lihat status koneksi** mereka (connected / connecting / reconnecting).
- **US-06**: Kru bisa **leave / ganti device** dengan satu tombol.
- **US-07**: Sistem jalan di WiFi `unnes-id` auditorium **tanpa internet**.
- **US-08**: Admin (server) bisa jalan dari **laptop / HP Android** (bukan server dedicated).
- **US-09**: Sistem **zero install** — kru tinggal scan QR / buka link, langsung jalan di Chrome / Safari.
- **US-10**: Sistem **graceful reconnect** — kalau WiFi drop sebentar, kru otomatis nyambung lagi tanpa perlu refresh.

### Post-MVP (nice-to-have, bukan blocker)

- **US-11**: Channel per role (misal channel "FOH" khusus audio team).
- **US-12**: Text chat side-channel.
- **US-13**: Recording session untuk archive.
- **US-14**: Multi-server (cluster) untuk event > 30 kru.
- **US-15**: Audio level meter per peer.
- **US-16**: Push notification kalau ada panggilan saat HP di-lock.

---

## 5. MVP Scope

### ✅ IN SCOPE

- Single Node.js signaling server (WebSocket).
- WebRTC P2P mesh audio antar HP kru.
- TURN fallback (metered.ca) untuk kasus network path aneh.
- 11 role preset: cam1–4, switcher, production, ppt1–2, audio, timekeeper, other.
- Push-to-Talk (press-and-hold) via mouse / touch.
- Real-time speaker indicator + presence list.
- Mobile-first responsive UI (HP portrait & landscape).
- Desktop responsive (laptop, tablet).
- Health check endpoint (`/health`) untuk monitoring.
- No build step — pure static HTML + JS, served by Express.
- Self-contained: hanya butuh `npm install` + `node server.js`.

### ❌ OUT OF SCOPE (untuk MVP)

- Server-side audio recording.
- Multi-server / clustering.
- Channel / room / sub-grouping.
- Text chat.
- Authentication / user account.
- Push notifications.
- Native mobile app.
- Public internet deployment (sengaja — only local WiFi).

---

## 6. Success Metrics

| Metric | Target |
| --- | --- |
| **Join time** (buka link → bisa bicara) | < 10 detik |
| **PTT latency** (tekan tombol → terdengar di peer lain) | < 500 ms |
| **Concurrent users** di satu event | 8–12 kru |
| **Crash rate** (1 event = 4 jam) | 0 crash |
| **Reconnect success** (WiFi drop 5 detik) | 100% auto-recover |
| **Install / setup time** untuk admin | < 2 menit |
| **Install time** untuk kru (per device) | 0 detik (browser only) |

---

## 7. Non-Functional Requirements

- **Privacy**: audio tidak pernah lewat server (P2P only). Mic track disabled sampai PTT ditekan.
- **Battery**: P2P audio dengan opus codec di 32 kbps cukup hemat (< 5% battery / jam).
- **Reliability**: WebSocket auto-reconnect dengan backoff exponential, max 15 detik.
- **Compatibility**: Chrome ≥ 90, Safari ≥ 14, Edge, Firefox. iOS Safari 14+.
- **Aesthetic**: dark theme default (low light friendly), high contrast untuk visibility di backstage.
- **Accessibility**: tombol PTT besar (minimum 64px), text kontras tinggi, no critical info conveyed by color alone.

---

## 8. Technical Constraints

- **No internet dependency** saat runtime. Server optional self-host.
- **No account / no login**. Identitas = role + display name.
- **Single binary deploy** untuk admin (Node.js + 1 folder).
- **Standard Web APIs only**: WebRTC, WebSocket, MediaStream, Web Audio. No native plugin.

---

## 9. Roadmap

### Phase 1 — MVP (Done)
- Signaling server + WebRTC mesh
- PTT button + presence
- 11 role preset
- Mobile responsive

### Phase 2 — Polish (Next)
- Desktop responsive layout (2-column)
- QR code generator untuk invite link
- "How to use" mini-tutorial di join page
- Better error messages (mic permission denied, etc.)

### Phase 3 — Production-grade
- Persistent presence (rejoin sama identity)
- Speaker stats (siapa ngomong paling banyak)
- Channel / sub-group
- Recording & playback

### Phase 4 — Scale
- SFU (mediasoup) instead of mesh untuk > 15 user
- Multi-server deployment
- Cloud TURN config
- Push notification integration

---

## 10. Open Questions

- [ ] Apakah kru perlu lihat **siapa yang sedang bicara di role tertentu** (filter)? (Phase 3)
- [ ] Apakah perlu **private channel** antara production ↔ switcher? (Phase 3)
- [ ] Apakah perlu **integration dengan ProPresenter API** untuk auto-trigger? (Future)
- [ ] Apakah perlu **export log** untuk post-event review? (Phase 3)

---

**Versi:** 1.0.0
**Last updated:** 2026-08-28
