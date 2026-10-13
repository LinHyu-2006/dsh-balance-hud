@echo off
REM ---------------------------------------------------------------------------
REM Install launcher (Windows): find Node, then run tools\install.mjs.
REM
REM Why this exists: the README's `node tools/install.mjs` assumes Node is on
REM PATH, but a DSH user may never have installed Node -- DSH ships its own
REM runtime, and that runtime is not on PATH. So look for Node in order:
REM DSH_NODE -> node on PATH -> DSH's bundled runtime -> common install dirs.
REM
REM IMPORTANT: keep this file ASCII-only. cmd.exe reads .cmd files using the
REM system ANSI code page (GBK on a Chinese Windows), so non-ASCII comments
REM corrupt command parsing. Verified the hard way while writing this.
REM
REM Flat if/goto instead of parenthesised blocks on purpose: a goto out of a
REM parenthesised block leaves block state unexpanded and behaves oddly.
REM
REM Usage: double-click, or `tools\install.cmd [--profile <dir>] [--uninstall] [--dry-run]`
REM ---------------------------------------------------------------------------
setlocal EnableDelayedExpansion
set "SCRIPT=%~dp0install.mjs"
set "NODE="

if defined DSH_NODE if exist "%DSH_NODE%" set "NODE=%DSH_NODE%"
if defined NODE goto :run

for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODE=%%~$PATH:N"
if defined NODE goto :run

set "DSH_HOME_DIR=%USERPROFILE%\.dsh"
if defined DSH_HOME set "DSH_HOME_DIR=%DSH_HOME%"
for /d %%D in ("%DSH_HOME_DIR%\dsh-runtimes\*") do if not defined NODE if exist "%%~fD\dependencies\node\bin\node.exe" set "NODE=%%~fD\dependencies\node\bin\node.exe"
if defined NODE goto :run

if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if defined NODE goto :run
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODE goto :run
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE goto :run

echo.
echo   Node.js was not found, so the plugin cannot be installed.
echo.
echo   Pick one:
echo     1. Install Node.js 18+: https://nodejs.org/
echo     2. Point at an existing Node: set DSH_NODE=C:\path\to\node.exe
echo     3. DSH is not in the default place: set DSH_HOME=C:\path\to\.dsh
echo.
exit /b 1

:run
echo Using Node: !NODE!
"!NODE!" "!SCRIPT!" %*
exit /b %ERRORLEVEL%
