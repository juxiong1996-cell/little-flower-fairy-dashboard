@echo off
chcp 65001 >nul
title 小花仙签到台
cd /d "%~dp0"
if not exist "%~dp0runtime\node.exe" (
  echo 找不到随包附带的运行环境。请先完整解压整个压缩包，再双击此文件。
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0src\app\launcher.mjs"
if errorlevel 1 pause
