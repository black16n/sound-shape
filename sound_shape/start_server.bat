@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Find a real Python.
rem
rem Two traps this script avoids:
rem  1) Do NOT test a command with:  if not exist "%PY%"
rem     That only looks in the current directory, not on PATH. Use where.
rem  2) The first python on PATH is sometimes the Microsoft Store stub,
rem     which just opens the Store. Skip any path containing WindowsApps.
set "PY="

for /f "delims=" %%i in ('where python 2^>nul') do (
  echo %%i | findstr /i "WindowsApps" >nul
  if errorlevel 1 if not defined PY set "PY=%%i"
)
if defined PY goto have_py

set "CAND=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if exist "%CAND%" set "PY=%CAND%"
if defined PY goto have_py

where py >nul 2>nul
if not errorlevel 1 set "PY=py"
if defined PY goto have_py

echo.
echo  [ERROR] Python 3 not found.
echo    1) Install Python 3.9+ and tick "Add to PATH" during setup, or
echo    2) Run open_standalone.bat for frontend-only mode (no Python needed).
echo.
pause
exit /b 1

:have_py
echo  Using Python: %PY%
echo  Starting backend. This window is the server log - keep it open.
echo  Press Ctrl+C (or close this window) to stop the server.
echo.

"%PY%" server.py --open

echo.
echo  Server stopped.
pause >nul
