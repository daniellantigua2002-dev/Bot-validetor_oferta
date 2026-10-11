@echo off
rem Arranca el bot validador de comprobantes SPEI (doble clic). Para detenerlo: Ctrl+C o cerrar la ventana.
title Bot validador SPEI
cd /d "%~dp0"
echo Iniciando el bot... (no cierres esta ventana mientras quieras que el bot funcione)
call npm run bot
echo.
echo El bot se detuvo.
pause
