#!/bin/sh
# ============================================================
#  IP26-Intercom — One-click launcher (macOS / Linux)
#  ----------------------------------------------------------
#  Jalankan dari terminal: ./start.sh
#  Atau klik dua kali jika OS mendukung eksekusi .sh.
# ============================================================

cd "$(dirname "$0")"

echo "==========================================================="
echo "  IP26 INTERCOM — One-click launcher"
echo "==========================================================="
echo
echo "Pastikan laptop & HP kru terhubung ke WiFi yang SAMA."
echo

# Cek apakah node_modules ada
if [ ! -d "node_modules" ]; then
  echo "[SETUP] Menginstall dependensi... (hanya sekali)"
  npm install || {
    echo
    echo "[ERROR] Gagal install. Pastikan Node.js sudah terinstall."
    echo "Download: https://nodejs.org"
    exit 1
  }
fi

echo "[START] Menjalankan server..."
echo "Tekan CTRL+C kapan saja untuk menghentikan."
echo
node server.js
