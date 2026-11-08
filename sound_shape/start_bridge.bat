@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   Sound Shape - hardware bridge
echo   Reads the ESP32 serial port and forwards events to the local backend.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bridge.ps1" %*

echo.
pause
