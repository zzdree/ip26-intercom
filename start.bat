@echo off
REM ============================================================
REM  IP26 Intercom — One-click launcher (Windows)
REM  ----------------------------------------------------------
REM  Klik dua kali file ini untuk menjalankan server lokal.
REM  Tidak perlu install apa-apa lagi (paket sudah terinstall).
REM  ----------------------------------------------------------
REM  Setelah jalan, akan muncul alamat seperti:
REM    http://192.168.x.x:3000
REM  Bagikan alamat itu ke kru yang satu WiFi.
REM ============================================================

setlocal
title IP26 Intercom Server
cd /d "%~dp0"

echo.
echo  ===========================================================
echo   IP26 INTERCOM — One-click launcher
echo  ===========================================================
echo.
echo  Pastikan laptop & HP kru terhubung ke WiFi yang SAMA.
echo  (mis. unnes-id, WiFi kos, hotspot dari laptop ini, dsb.)
echo.
echo  Server akan jalan di: http://localhost:3000
echo  ------------------------------------------------------------
echo.

REM Cek apakah node_modules ada, kalau belum install otomatis
if not exist "node_modules" (
  echo  [SETUP] Menginstall dependensi... (hanya sekali)
  call npm install
  if errorlevel 1 (
    echo.
    echo  [ERROR] Gagal install. Pastikan Node.js sudah terinstall.
    echo  Download: https://nodejs.org
    pause
    exit /b 1
  )
)

echo  [START] Menjalankan server...
echo  Tekan CTRL+C kapan saja untuk menghentikan.
echo.
node server.js
pause
