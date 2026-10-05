@echo off
rem Install Corkboard on Windows. Double-click this file, or run it in a terminal.
rem It needs Node.js, and "npm install" in the project folder first.
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and run this file again. & pause & exit /b 1)
if not exist "%~dp0..\..\node_modules\electron" (echo Run "npm install" in the project folder first. & pause & exit /b 1)
node "%~dp0windows.js" install
if errorlevel 1 (echo The install failed. & pause & exit /b 1)
echo Corkboard is installed. Look for Corkboard on the Desktop and in the Start menu.
pause
