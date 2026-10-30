@echo off
title Omniforge — Lancement de la Fenetre Native
echo ========================================================
echo   Lancement de la fenetre native Omniforge (Desktop)
echo ========================================================
echo.
wsl -e bash -lic "cd /mnt/c/wamp64/www/colab-ai-studio && DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 npx electron dist-electron/main.js"
pause
