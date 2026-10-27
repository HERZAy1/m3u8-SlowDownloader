@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ---------------------------------------------------------------
rem  m3u8 Downloader - launcher for the local web GUI
rem  Requires Node.js >= 22.6. No npm install, no build step.
rem  Optional env vars: PORT (default 7788), NO_BROWSER=1
rem ---------------------------------------------------------------

set "NODE="
where node >nul 2>nul && set "NODE=node"

if not defined NODE (
  set "DSHNODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  if exist "!DSHNODE!" set "NODE=!DSHNODE!"
)

if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%USERPROFILE%\scoop\apps\nodejs\current\node.exe" set "NODE=%USERPROFILE%\scoop\apps\nodejs\current\node.exe"

if not defined NODE goto :nonode

if not defined PORT set "PORT=7788"

echo.
echo   m3u8 Downloader
echo   ----------------------------------------
echo   Node : !NODE!
echo   URL  : http://127.0.0.1:!PORT!
echo   Close this window to stop the server.
echo.

if not defined NO_BROWSER start "" cmd /c "timeout /t 2 >nul & rundll32 url.dll,FileProtocolHandler http://127.0.0.1:!PORT!"

"!NODE!" src\server.ts

echo.
echo   Server stopped.
pause
exit /b 0

:nonode
echo.
echo   [x] Node.js not found
echo.
echo   This tool requires Node.js 22.6 or newer.
echo   Install it with:  winget install OpenJS.NodeJS.LTS
echo   Or download from: https://nodejs.org
echo.
pause
exit /b 1
