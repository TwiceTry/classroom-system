@echo off
chcp 65001 >nul
title 课堂系统 · 局域网代理
cd /d "%~dp0"

rem ============================================================
rem  教学机上的「局域网 → 公网」代理
rem  监听端口 / 上游地址都可以在这里改；也可以用命令行传参：
rem    node lan-proxy.js --port 18799 --target https://your-public-host:45600
rem ============================================================

set PORT=18799
set TARGET=https://your-public-host:45600
rem 实时流量（投屏/点名/在线状态）走本机课堂系统，不出公网
set LOCAL_TARGET=http://127.0.0.1:18730
rem 有些环境会注入带新语法的 NODE_OPTIONS，老 Node 会报错，这里清掉
set NODE_OPTIONS=

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没找到 node.exe —— 先装 Node.js（Win7 64 位请装 12.22.12 LTS）：
  echo   https://nodejs.org/dist/v12.22.12/node-v12.22.12-win-x64.zip
  echo   解压到 C:\node12，把 C:\node12 放进 PATH，然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

node lan-proxy.js --port %PORT% --target %TARGET% --local-target %LOCAL_TARGET%
echo.
echo （代理已退出）
pause
