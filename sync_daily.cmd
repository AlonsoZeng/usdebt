@echo off
REM 每日同步包装器：供 Windows 计划任务调用（注册命令见 README）
REM 作用：切到仓库根目录 → 跑 scripts\daily_sync.py → 追加日志
cd /d "%~dp0"
if not exist logs mkdir logs
echo [%date% %time%] ---- start ---- >> logs\daily_sync.log
python scripts\daily_sync.py >> logs\daily_sync.log 2>&1
echo [%date% %time%] ---- exit=%ERRORLEVEL% ---- >> logs\daily_sync.log
