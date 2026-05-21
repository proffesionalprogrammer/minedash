@echo off
title MineDash Server Manager
echo ===================================================
echo Starting MineDash Server Manager...
echo ===================================================

echo Starting processes in the background...

:: Start backend silently in this same window
start /B cmd /c "cd backend && node index.js"

:: Start frontend silently in this same window
start /B cmd /c "cd frontend && npm run dev"

:: Wait a few seconds for the servers to spin up
timeout /t 3 /nobreak > nul

:: Automatically open the website in the user's default browser
start http://localhost:5173/

echo.
echo MineDash is now running! 
echo Keep this single window open. To completely shut down MineDash, just close this window!
echo.
:: Keep the window open
pause
