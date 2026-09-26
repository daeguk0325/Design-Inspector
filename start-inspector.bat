@echo off
REM Design Inspector Tool - one double-click startup (no IDE, no terminal typing).
REM Starts App A (vite) + Launcher window + target supervision.
REM Keep this window open: target dev logs appear here, and closing it
REM (Ctrl+C) shuts the target dev server down together with App A.
cd /d "%~dp0"
node scripts\with-launcher.mjs %*
if errorlevel 1 pause
