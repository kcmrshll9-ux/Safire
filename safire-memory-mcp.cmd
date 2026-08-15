@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\Safire.exe" "%~dp0app.asar.unpacked\safire-memory-mcp.mjs" %*
