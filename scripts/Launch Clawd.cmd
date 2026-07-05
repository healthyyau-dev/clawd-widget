@echo off
rem Double-click to start the Clawd dev widget. Lives in scripts/, so cd up to the project root.
cd /d "%~dp0.."
if not exist "node_modules" (
  echo First-time setup: installing dependencies...
  call npm install
)
start "" /b npx electron .
exit
