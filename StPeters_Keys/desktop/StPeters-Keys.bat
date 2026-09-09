@echo off
rem ============================================================================
rem  StPeters-Keys.bat - double-click this in Explorer to run the newsletter.
rem
rem  WHAT IT DOES, in order:
rem    1. finds a Node.js of version 20 or newer, looking on PATH and in the
rem       places Node actually installs itself (Program Files, the winget shim
rem       folder, nvm-windows, Volta, scoop, Chocolatey),
rem    2. if there is none, explains what is needed and why, ASKS before
rem       installing anything, then installs it with winget if that is present
rem       or the official .msi if it is not,
rem    3. runs desktop\launch.js, which starts the server on 127.0.0.1 and
rem       opens your browser,
rem    4. if Node cannot be had - declined, or the install failed - opens
rem       index.html straight from disk instead, and says what that costs.
rem
rem  This window never closes on an error without telling you why: every exit
rem  goes through a pause. Every path is quoted, so a project folder inside
rem  "C:\Users\Someone\OneDrive - St Peter's\Newsletter" is fine.
rem
rem  There is no "npm install" here and there never will be: this project has
rem  no packages. Node itself is the only thing it needs.
rem
rem  MAINTAINER'S NOTE: this file was written and reviewed line by line on a
rem  Mac and has NOT been executed on Windows. The macOS twin
rem  (StPeters-Keys.command) and launch.js have been run and tested.
rem ============================================================================

setlocal EnableExtensions EnableDelayedExpansion
title St. Peter's Keys

set "MIN_MAJOR=20"

rem %~dp0 is this file's own folder and always ends in a backslash.
set "HERE=%~dp0"
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "LAUNCH=%HERE%launch.js"
set "INDEX=%ROOT%\index.html"

rem Assigned up here, at the top level, on purpose: the parentheses in the name
rem of the 32-bit Program Files variable confuse cmd's parser inside an
rem if/for block, and this is the one place it can be read safely.
set "PF86=%ProgramFiles(x86)%"

set "RULE=----------------------------------------------------------------"

echo.
echo St. Peter's Keys - starting up.

if not exist "%LAUNCH%" (
  echo.
  echo Cannot find "%LAUNCH%".
  echo This file has to stay in the desktop\ folder of the project, next to
  echo launch.js, server\ and index.html.
  goto :dead
)

call :findnode
if defined NODE goto :run

rem --------------------------------------------------------------------------
rem  No usable Node. Say which of the two problems it is, then ask.
rem --------------------------------------------------------------------------
echo.
if defined FOUNDVER (
  echo [keys] Found Node !FOUNDVER!, which is older than Node %MIN_MAJOR%.
) else (
  echo [keys] Node.js is not installed on this computer.
)

echo.
echo %RULE%
echo   St. Peter's Keys needs Node.js ^(version %MIN_MAJOR% or newer^) to run
echo   on this computer. It is the free, standard program that runs the small
echo   local server this app uses to hold your newsletter safely while you
echo   edit it. Nothing is sent anywhere.
echo %RULE%
echo.

set "ANSWER="
set /p "ANSWER=Install Node.js now? [y/N] "
if /i "!ANSWER!"=="y" goto :install
if /i "!ANSWER!"=="yes" goto :install

echo.
echo [keys] Not installing anything. That is a perfectly good answer.
goto :fromdisk

rem --------------------------------------------------------------------------
rem  Installing, with consent already given
rem --------------------------------------------------------------------------
:install
where winget >nul 2>nul
if errorlevel 1 goto :install_msi

echo.
echo [keys] Installing Node.js with winget. This takes a few minutes, and
echo [keys] Windows may ask you to approve it.
echo.
winget install --exact --id OpenJS.NodeJS.LTS --source winget ^
  --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo.
  echo [keys] winget could not install Node. Trying the official installer.
  goto :install_msi
)
goto :installed

:install_msi
rem Which Node to install is asked of nodejs.org, not written down here.
rem
rem An earlier version of this script fetched /dist/latest-v22.x/ and called
rem that "not hard-coded". It was: a pinned major line silently installs an
rem ageing LTS long after a newer one exists, and becomes a 404 - which reads
rem to the user as "this app is broken" - the day v22 is removed. A parish is
rem expected to run this for years without anybody editing it.
rem
rem /dist/index.json is newest-first and each entry's "lts" field holds a
rem codename for LTS releases and false for the rest, so the first truthy one
rem is the current LTS. /dist/latest-lts/ would be the obvious thing to use and
rem does not exist.
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
set "MSI=%TEMP%\stpeters-keys-node-%ARCH%.msi"

echo.
echo [keys] Asking nodejs.org which release is current, then downloading it...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $rel=@(Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts })[0]; if(-not $rel){ exit 2 }; $url='https://nodejs.org/dist/' + $rel.version + '/node-' + $rel.version + '-%ARCH%.msi'; Invoke-WebRequest -UseBasicParsing $url -OutFile '%MSI%'"
if errorlevel 1 (
  echo.
  echo [keys] Could not download the installer. That is usually no internet
  echo [keys] connection, or a company firewall blocking nodejs.org.
  goto :fromdisk
)

echo.
echo %RULE%
echo   Windows will now ask for permission to install Node.js, because it
echo   puts files in a shared folder. The installer is the official one,
echo   downloaded from nodejs.org just now, and you can say no here with no
echo   harm done.
echo %RULE%
echo.
rem start /wait, not a bare msiexec: msiexec is entitled to return control
rem before it has finished, and a findnode that runs while the install is still
rem going would report "installed but cannot be found".
start /wait "" msiexec /i "%MSI%" /qb
if errorlevel 1 (
  echo.
  echo [keys] The installer did not finish. Nothing has been changed. If a
  echo [keys] permission box appeared and you said no, that is why.
  goto :fromdisk
)

:installed
rem PATH in THIS window is a copy made when the window opened, so a Node that
rem was just installed is not on it. That is why findnode looks in the install
rem folders directly rather than only asking PATH.
call :findnode
if defined NODE (
  echo.
  echo [keys] Node.js installed: !NODE! ^(!NODEVER!^)
  goto :run
)

echo.
echo [keys] Node.js was installed but cannot be found from this window.
echo [keys] Close this window and double-click StPeters-Keys.bat again -
echo [keys] that usually fixes it, because the new PATH is picked up then.
goto :fromdisk

rem --------------------------------------------------------------------------
rem  Running it
rem --------------------------------------------------------------------------
:run
echo [keys] Using Node !NODEVER! ^(!NODE!^)
"!NODE!" "%LAUNCH%" %*
set "STATUS=!ERRORLEVEL!"

if not "!STATUS!"=="0" (
  echo.
  echo [keys] The newsletter did not start ^(exit code !STATUS!^).
  echo [keys] The reason is in the lines above.
  goto :dead
)

echo.
echo [keys] St. Peter's Keys has stopped.
goto :done

rem --------------------------------------------------------------------------
rem  The fallback: never leave somebody with a closed door
rem --------------------------------------------------------------------------
:fromdisk
echo.
echo %RULE%
echo   Opening the newsletter straight from the file instead.
echo.
echo   This works, and you can write, arrange and print exactly as usual.
echo   What it costs: opened this way the page has no web address, and some
echo   browsers refuse to let a page like that save anything. If that happens
echo   here, your work will NOT be kept when you close the tab - so print to
echo   PDF as you go, or install Node.js and run this again.
echo %RULE%
echo.
if exist "%INDEX%" (
  start "" "%INDEX%"
) else (
  echo Could not find "%INDEX%".
)
goto :done

rem --------------------------------------------------------------------------
rem  Exits. Both pause; neither vanishes.
rem --------------------------------------------------------------------------
:dead
echo.
pause
endlocal
exit /b 1

:done
echo.
pause
endlocal
exit /b 0

rem ==========================================================================
rem  Subroutines
rem ==========================================================================

rem Sets NODE and NODEVER to the first usable Node found, or leaves them unset.
rem Sets FOUNDVER to the version of a Node that exists but is too old, so the
rem message above can quote it.
:findnode
set "NODE="
set "NODEVER="
set "FOUNDVER="

for /f "delims=" %%C in ('where node 2^>nul') do (
  if not defined NODE call :trynode "%%~fC"
)

for %%C in (
  "%ProgramFiles%\nodejs\node.exe"
  "%PF86%\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
  "%LOCALAPPDATA%\Microsoft\WinGet\Links\node.exe"
  "%NVM_SYMLINK%\node.exe"
  "%APPDATA%\nvm\node.exe"
  "%LOCALAPPDATA%\Volta\bin\node.exe"
  "%USERPROFILE%\scoop\shims\node.exe"
  "%ProgramData%\chocolatey\bin\node.exe"
) do (
  if not defined NODE call :trynode "%%~C"
)
exit /b 0

rem "node --version" prints v20.11.1; the major is all that matters.
:trynode
set "CAND=%~1"
if not exist "%CAND%" exit /b 0

set "VER="
for /f "usebackq delims=" %%V in (`"%CAND%" --version 2^>nul`) do set "VER=%%V"
if not defined VER exit /b 0

set "VNUM=!VER:v=!"
set "MAJ="
for /f "tokens=1 delims=." %%A in ("!VNUM!") do set "MAJ=%%A"
if not defined MAJ exit /b 0

rem Refuse to compare something that is not a number: "if xyz GEQ 20" is a
rem STRING comparison, and "xyz" sorts above "20", so a nonsense version would
rem quietly pass. If MAJ is all digits this for/f yields no token at all and
rem the body never runs; one non-digit and we give up on this candidate.
rem (set /a is no good here: it treats an unrecognised word as a variable
rem worth zero and reports success.)
for /f "delims=0123456789" %%X in ("!MAJ!") do exit /b 0

if !MAJ! GEQ %MIN_MAJOR% (
  set "NODE=%CAND%"
  set "NODEVER=!VER!"
) else (
  if not defined FOUNDVER set "FOUNDVER=!VER!"
)
exit /b 0
