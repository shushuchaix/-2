@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   ============================================
echo      简历岗位雷达  Resume Job Radar
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 未检测到 Node.js，请先安装 Node.js 20 或更高版本：
  echo          https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   [首次运行] 正在安装依赖，请稍候...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [错误] 依赖安装失败，请检查网络后重试。
    echo.
    pause
    exit /b 1
  )
  echo.
)

if not exist "config.json" (
  if exist "config.example.json" copy /y "config.example.json" "config.json" >nul
  echo   [提示] 已生成 config.json。
  echo          如需启用全网搜索，请在其中填入 Tavily/博查/Serper 的 API Key。
  echo.
)

echo   正在启动服务，浏览器将自动打开...
echo   关闭本窗口即可停止服务。
echo.

start "" http://127.0.0.1:3210
node src/server.mjs

echo.
echo   服务已停止。
pause
