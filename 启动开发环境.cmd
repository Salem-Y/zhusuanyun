@echo off
chcp 65001 >nul
title AI造价平台 - 启动预览
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-dev.ps1"
