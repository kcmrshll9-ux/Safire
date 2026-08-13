@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem Always launch the local browser build; do not switch to a packaged EXE.
set "PORT=5277"
set "URL=http://127.0.0.1:%PORT%/"
set "STATUS="

rem Reuse a healthy existing Safire server instead of creating a duplicate.
for /f "delims=" %%s in ('curl.exe -s -o nul -w "%%{http_code}" "%URL%api/health"') do set "STATUS=%%s"
if "%STATUS%"=="200" goto ready

if not exist node_modules (
  echo Installing Safire dependencies...
  call npm install
  if errorlevel 1 pause & exit /b 1
)

if not exist dist\index.html (
  echo Building Safire...
  call npm run build
  if errorlevel 1 pause & exit /b 1
)

start "Safire Browser Server" /min cmd.exe /d /c "cd /d ""%~dp0"" && npm start"

echo Waiting for Safire browser at %URL% ...
for /l %%i in (1,1,40) do (
  set "STATUS="
  for /f "delims=" %%s in ('curl.exe -s -o nul -w "%%{http_code}" "%URL%api/health"') do set "STATUS=%%s"
  if "!STATUS!"=="200" goto ready
  timeout /t 1 /nobreak >nul
)

echo Safire browser did not become ready. Check the Safire Browser Server window.
pause
exit /b 1

:ready
where msedge.exe >nul 2>nul
if %errorlevel%==0 (
  start "" msedge.exe --app=%URL%
) else (
  start "" %URL%
)
endlocal
