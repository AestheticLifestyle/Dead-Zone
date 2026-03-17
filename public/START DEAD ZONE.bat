@echo off
title DEAD ZONE - Multiplayer Zombie Shooter
color 0C
echo.
echo  ========================================
echo    DEAD ZONE - Starting...
echo  ========================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  ERROR: Node.js is not installed!
    echo  Download it from: https://nodejs.org
    echo  Install it, then double-click this file again.
    echo.
    pause
    exit /b 1
)

:: Run the game
cd /d "%~dp0"
node start.js

:: Keep window open if it crashes
echo.
echo  Game stopped. Press any key to close...
pause >nul
