#!/bin/bash

# MCP Browser - Chrome 无头模式启动脚本
# 启动无头 Chrome（适合服务器环境）

PORT="9222"
if [[ $# -gt 0 ]]; then
    PORT="$1"
    shift
fi

echo "Starting Chrome in headless mode on port $PORT..."

# 检测操作系统和 Chrome 路径
if [[ "$OSTYPE" == "darwin"* ]]; then
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v google-chrome &> /dev/null; then
        CHROME_PATH="google-chrome"
    elif command -v google-chrome-stable &> /dev/null; then
        CHROME_PATH="google-chrome-stable"
    elif command -v chromium &> /dev/null; then
        CHROME_PATH="chromium"
    else
        echo "Error: Chrome/Chromium not found"
        exit 1
    fi
else
    echo "Error: Unsupported OS"
    exit 1
fi

# 启动无头 Chrome
"$CHROME_PATH" \
    --headless=new \
    --remote-debugging-port="$PORT" \
    --disable-gpu \
    --no-sandbox \
    --disable-dev-shm-usage \
    --window-size=1920,1080 \
    "$@"
