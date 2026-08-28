#!/bin/bash
# ============================================================
#  IP26-Intercom — One-click Launcher (macOS / Linux)
#  ----------------------------------------------------------
#  Jalankan dari terminal: ./start.sh
#  Otomatis deteksi IP LAN & tampilkan info lengkap.
#  Tekan 'q' lalu Enter kapan saja untuk menghentikan server.
# ============================================================

cd "$(dirname "$0")"

# Warna untuk output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

clear
echo -e "${CYAN}============================================================${NC}"
echo -e "${CYAN}  IP26-INTERCOM — WEBSOCKET PTT INTERCOM${NC}"
echo -e "${CYAN}============================================================${NC}"
echo

# Cek Node.js
echo -e "${YELLOW}[INFO]${NC} Memeriksa Node.js..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}[ERROR]${NC} Node.js tidak ditemukan!"
    echo "Silakan install dari: https://nodejs.org (versi 18+)"
    exit 1
fi
echo -e "${GREEN}[OK]${NC} Node.js ditemukan: $(node --version)"
echo

# Auto-install dependencies
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}[SETUP]${NC} Menginstall dependensi (hanya sekali)..."
    npm install || {
        echo -e "${RED}[ERROR]${NC} Gagal install dependensi."
        exit 1
    }
    echo -e "${GREEN}[OK]${NC} Dependensi terinstall."
    echo
fi

# Deteksi IP LAN otomatis
echo -e "${YELLOW}[INFO]${NC} Mendeteksi IP jaringan lokal..."
LOCAL_IP=""

# Coba berbagai cara deteksi IP (Linux/macOS/WSL)
if command -v hostname &> /dev/null; then
    # macOS / Linux dengan hostname -I
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi

if [ -z "$LOCAL_IP" ] && command -v ip &> /dev/null; then
    # Linux dengan ip route
    LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
fi

if [ -z "$LOCAL_IP" ] && command -v ifconfig &> /dev/null; then
    # macOS / BSD dengan ifconfig
    LOCAL_IP=$(ifconfig | grep -E "inet.*broadcast" | head -1 | awk '{print $2}')
fi

if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP="127.0.0.1"
fi

echo -e "${GREEN}[OK]${NC} IP terdeteksi: ${BLUE}$LOCAL_IP${NC}"
echo

echo -e "${CYAN}============================================================${NC}"
echo -e "${CYAN}  SERVER SIAP DIJALANKAN${NC}"
echo -e "${CYAN}============================================================${NC}"
echo
echo -e "  📱  ${YELLOW}BAGIKAN ALAMAT INI KE KRU (satu WiFi):${NC}"
echo
echo -e "      ${GREEN}HTTP  :${NC} http://$LOCAL_IP:3000"
echo -e "      ${GREEN}HTTPS :${NC} https://$LOCAL_IP:3443  ${YELLOW}(wajib untuk mikrofon HP)${NC}"
echo
echo -e "  💡  ${CYAN}TIPS:${NC}"
echo -e "      - HP wajib pakai HTTPS (browser akan warning \"Not Secure\" → klik Advanced → Proceed)"
echo -e "      - Semua perangkat harus di WiFi ${YELLOW}YANG SAMA${NC}"
echo -e "      - Maksimal ~8-10 orang sekaligus (mesh P2P)"
echo
echo -e "${CYAN}============================================================${NC}"
echo -e "  Tekan ${GREEN}[ENTER]${NC} untuk mulai server"
echo -e "  Tekan ${RED}[q]${NC} lalu ${GREEN}[ENTER]${NC} untuk keluar"
echo -e "${CYAN}============================================================${NC}"
echo

read -r START_KEY
if [[ "${START_KEY,,}" == "q" ]]; then
    echo
    echo -e "${YELLOW}Dibatalkan.${NC}"
    exit 0
fi

echo
echo -e "${GREEN}[START]${NC} Menjalankan server... (tekan ${RED}q${NC} lalu ${GREEN}Enter${NC} untuk berhenti)"
echo

# Jalankan server di background
node server.js &
SERVER_PID=$!

# Tunggu sebentar supaya server siap
sleep 2

# Auto-buka browser ke Admin Dashboard & Intercom (test)
echo -e "${YELLOW}[INFO]${NC} Membuka browser..."
# Cross-platform browser open
if command -v xdg-open &> /dev/null; then
    xdg-open "http://$LOCAL_IP:3000/admin" >/dev/null 2>&1
    xdg-open "https://$LOCAL_IP:3443" >/dev/null 2>&1
elif command -v open &> /dev/null; then
    open "http://$LOCAL_IP:3000/admin" >/dev/null 2>&1
    open "https://$LOCAL_IP:3443" >/dev/null 2>&1
elif command -v start &> /dev/null; then
    start "" "http://$LOCAL_IP:3000/admin" >/dev/null 2>&1
    start "" "https://$LOCAL_IP:3443" >/dev/null 2>&1
else
    echo -e "${YELLOW}[WARN]${NC} Tidak bisa auto-buka browser. Buka manual:"
    echo -e "  Admin: http://$LOCAL_IP:3000/admin"
    echo -e "  Intercom: https://$LOCAL_IP:3443"
fi

echo
echo -e "${CYAN}============================================================${NC}"
echo -e "${CYAN}  SERVER BERJALAN — Browser sudah dibuka otomatis${NC}"
echo -e "${CYAN}============================================================${NC}"
echo
echo -e "  📱  Admin Dashboard: http://$LOCAL_IP:3000/admin"
echo -e "  🎙️  Intercom (test): https://$LOCAL_IP:3443"
echo
echo -e "  💡  HP Kru buka: https://$LOCAL_IP:3443  (scan QR di admin)"
echo -e "  💡  Tekan ${RED}[q]${NC} lalu ${GREEN}[Enter]${NC} di sini untuk menghentikan server"
echo -e "${CYAN}============================================================${NC}"
echo

# Trap Ctrl+C dan cleanup
cleanup() {
    echo
    echo -e "${YELLOW}[STOP]${NC} Menghentikan server (PID: $SERVER_PID)..."
    kill $SERVER_PID 2>/dev/null
    wait $SERVER_PID 2>/dev/null
    echo -e "${GREEN}[OK]${NC} Server dihentikan."
    exit 0
}
trap cleanup INT TERM

# Loop baca input untuk stop manual
while true; do
    read -r STOP_KEY
    if [[ "${STOP_KEY,,}" == "q" ]]; then
        cleanup
    fi
done
