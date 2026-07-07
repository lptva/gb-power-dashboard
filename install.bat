@echo off
rem One-command installer for Windows: double-click this file.
rem It finds Python and hands over to install.py; if Python is missing it
rem explains what to do instead of showing a cryptic error.

rem The py launcher works even when "Add to PATH" was missed, so try it first.
where py >nul 2>nul
if %errorlevel%==0 (
  py "%~dp0install.py" %*
  goto :done
)

where python >nul 2>nul
if %errorlevel%==0 (
  python "%~dp0install.py" %*
  goto :done
)

echo.
echo  Python was not found on this computer.
echo.
echo  1. Install it from  https://www.python.org/downloads/
echo  2. IMPORTANT: on the FIRST screen of the installer, tick the box
echo        "Add python.exe to PATH"
echo     (this is the step everyone misses - nothing works without it)
echo  3. Then double-click this file again.
echo.

:done
pause
