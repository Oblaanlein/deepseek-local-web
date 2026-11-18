@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [!] 没有在 PATH 里找到 node，尝试使用 DSH 自带的 Node...
  set "NODE=C:\Users\123456\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  if exist "%NODE%" (
    "%NODE%" server.mjs
  ) else (
    echo [x] 找不到 node.exe，请先安装 Node.js 18+ 或修改本文件里的路径。
    pause
  )
) else (
  node server.mjs
)
pause
