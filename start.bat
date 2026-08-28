@echo off
REM ============================================================
REM  IP26-Intercom — One-click Launcher (Windows)
REM  ----------------------------------------------------------
REM  Klik dua kali file ini untuk menjalankan server intercom.
REM  Otomatis deteksi IP LAN & tampilkan QR code untuk HP.
REM  Tekan 'Q' kapan saja untuk menghentikan server.
REM ============================================================

setlocal enabledelayedexpansion

title IP26-Intercom Server
cd /d "%~dp0"

cls
echo  ============================================================
echo   IP26-INTERCOM — WEBSOCKET PTT INTERCOM
echo  ============================================================
echo.
echo  [INFO] Memeriksa Node.js...

where node >nul 2>nul
if errorlevel 1 (
    echo  [ERROR] Node.js tidak ditemukan!
    echo  Silakan install dari: https://nodejs.org (versi 18+)
    echo.
    pause
    exit /b 1
)

echo  [OK] Node.js ditemukan.
echo.

REM Auto-install dependencies kalau belum ada
if not exist "node_modules" (
    echo  [SETUP] Menginstall dependensi (hanya sekali)... 
    call npm install
    if errorlevel 1 (
        echo.
        echo  [ERROR] Gagal install dependensi.
        pause
        exit /b 1
    )
    echo  [OK] Dependensi terinstall.
    echo.
)

REM Deteksi IP LAN otomatis
echo  [INFO] Mendeteksi IP jaringan lokal...
for /f "tokens=2 delims=[]" %%a in ('ping -n 1 -4 "%computername%" ^| findstr "\["') do set LOCAL_IP=%%a
if "!LOCAL_IP!"=="" (
    for /f "tokens=2" %%a in ('ipconfig ^| findstr /i "ipv4" ^| findstr /v "127.0.0.1"') do set LOCAL_IP=%%a
)
if "!LOCAL_IP!"=="" set LOCAL_IP=127.0.0.1

echo  [OK] IP terdeteksi: !LOCAL_IP!
echo.

echo  ============================================================
echo   SERVER SIAP DIJALANKAN
echo  ============================================================
echo.
echo   📱  BAGIKAN ALAMAT INI KE KRU (satu WiFi):
echo.
echo       HTTP   : http://!LOCAL_IP!:3000
echo       HTTPS  : https://!LOCAL_IP!:3443  (wajib untuk mikrofon HP)
echo.
echo   💡  TIPS:
echo       - HP wajib pakai HTTPS (browser akan warning "Not Secure" → klik Advanced → Proceed)
echo       - Semua perangkat harus di WiFi YANG SAMA
echo       - Maksimal ~8-10 orang sekaligus (mesh P2P)
echo.
echo  ============================================================
echo   TEKAN [ENTER] UNTUK MULAI SERVER
echo   TEKAN [Q] LALU [ENTER] UNTUK KELUAR
echo  ============================================================
echo.

set /p START_KEY=Pilihan: 
if /i "!START_KEY!"=="Q" (
    echo.
    echo  Dibatalkan.
    timeout /t 1 /nobreak >nul
    exit /b 0
)

echo.
echo  [START] Menjalankan server... (tekan Q + Enter untuk berhenti)
echo.

REM Jalankan server di background
start "IP26-Intercom Server" cmd /k "node server.js"

REM Tunggu sebentar supaya server siap
timeout /t 2 /nobreak >nul

REM Auto-buka browser ke Admin Dashboard & Intercom (test)
echo  [INFO] Membuka browser...
start "" "http://!LOCAL_IP!:3000/admin"
start "" "https://!LOCAL_IP!:3443"

echo.
echo  ============================================================
echo   SERVER BERJALAN — Browser sudah dibuka otomatis
echo  ============================================================
echo.
echo   📱  Admin Dashboard: http://!LOCAL_IP!:3000/admin
echo   🎙️  Intercom (test): https://!LOCAL_IP!:3443
echo.
echo   💡  HP Kru buka: https://!LOCAL_IP!:3443  (scan QR di admin)
echo   💡  Tekan [Q] + [ENTER] di sini untuk menghentikan server
echo  ============================================================
echo.

REM Tunggu input stop
:STOP_LOOP
set /p STOP_KEY=
if /i "!STOP_KEY!"=="Q" (
    taskkill /f /fi "windowtitle eq IP26-Intercom Server" >nul 2>nul
    echo.
    echo  [STOP] Server dihentikan.
    timeout /t 1 /nobreak >nul
    exit /b 0
)
goto STOP_LOOP
