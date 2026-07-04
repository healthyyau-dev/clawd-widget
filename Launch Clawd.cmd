@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo First-time setup: installing dependencies...
  call npm install
)
start "" /b npx electron .
exit
