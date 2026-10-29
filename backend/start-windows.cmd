@echo off
rem Double-click to start the Video Summary backend on Windows.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0vs-backend.ps1" %*
pause
