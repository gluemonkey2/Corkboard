@echo off
rem Install Corkboard on Windows as a desktop app, with a shortcut on the Desktop and in the Start menu.
rem Double-click this file (or "Install Corkboard.cmd" in the project folder). It needs Node.js.
setlocal
cd /d "%~dp0..\.."

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist "node_modules\electron\dist" goto install
echo Getting the packages that Corkboard needs. This can take some minutes...
call npm install
if errorlevel 1 goto nopackages

:install
node "tools\deploy\windows.js" install
if errorlevel 1 goto failed
echo.
echo Corkboard is installed. The Desktop has two shortcuts: Corkboard, and Update Corkboard.
pause
exit /b 0

:nonode
echo Node.js is not installed.
echo Get it from https://nodejs.org (the LTS version), then run this file again.
pause
exit /b 1

:nopackages
echo npm could not get the packages. Make sure that this computer has a connection to the internet.
pause
exit /b 1

:failed
echo The install failed. The text above gives the cause.
pause
exit /b 1
