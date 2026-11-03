@echo off
cd /d "%~dp0"
if exist "build\reader_server.exe" (
  echo Starting C++ server: http://localhost:8080/
  start "" http://localhost:8080/
  "build\reader_server.exe" --port 8080 --root web
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
)
pause
