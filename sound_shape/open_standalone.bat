@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PAGE=%CD%\dashboard.html"
set "PF=%ProgramFiles%"
set "PF86=%ProgramFiles(x86)%"
set "BROWSER="

if exist "%PF86%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%PF86%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%PF%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%PF%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%PF%\Google\Chrome\Application\chrome.exe" set "BROWSER=%PF%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%PF86%\Google\Chrome\Application\chrome.exe" set "BROWSER=%PF86%\Google\Chrome\Application\chrome.exe"

if defined BROWSER (
  start "" "%BROWSER%" --new-window "file:///%PAGE:\=/%"
) else (
  start "" "%PAGE%"
)

echo.
echo   Opened dashboard.html in a STANDALONE browser window.
echo   Frontend-only mode: microphone + local recognition work without Python.
echo   For backend MFCC / WebSocket, use start_server.bat instead.
echo   If blocked, allow microphone from the address bar lock icon.
echo.
timeout /t 4 >nul
