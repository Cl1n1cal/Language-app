@echo off
rem Start the app on Windows. Double-click, or run: serve.cmd [port] [--no-open]
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto run

echo Setting up Python environment - first run only...
py -3 -m venv .venv 2>nul || python -m venv .venv 2>nul || goto nopython
".venv\Scripts\python.exe" -m pip install -q --upgrade pip anthropic || goto failed

:run
".venv\Scripts\python.exe" server.py %*
goto end

:nopython
echo Python 3 is needed. Install it from https://www.python.org/downloads/
echo and tick "Add python.exe to PATH" during setup.
goto failed

:failed
pause
exit /b 1

:end
endlocal
