@echo off
cd /d C:\easecutpro
echo Stopping the old server + tunnel (if running)...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8787 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1
timeout /t 2 /nobreak >nul
echo.
echo Starting EaseCutPro server + tunnel. LEAVE THIS WINDOW OPEN.
echo (The new URL + signup code will print below - open it on your phone.)
echo.
npm run remote
