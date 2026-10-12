#!/bin/bash

# MCP Browser - Chrome 启动脚本
# 启动带远程调试端口的 Chrome 浏览器

PORT="9222"
if [[ $# -gt 0 ]]; then
    PORT="$1"
    shift
fi
PROFILE_DIR="${HOME}/.chrome-mcp-profile"

echo "Starting Chrome with remote debugging on port $PORT..."
echo "Profile directory: $PROFILE_DIR"

# 检测操作系统
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    if command -v google-chrome &> /dev/null; then
        CHROME_PATH="google-chrome"
    elif command -v google-chrome-stable &> /dev/null; then
        CHROME_PATH="google-chrome-stable"
    elif command -v chromium &> /dev/null; then
        CHROME_PATH="chromium"
    elif command -v chromium-browser &> /dev/null; then
        CHROME_PATH="chromium-browser"
    else
        echo "Error: Chrome/Chromium not found"
        exit 1
    fi
else
    echo "Error: Unsupported OS"
    exit 1
fi

# 启动 Chrome
"$CHROME_PATH" \
    --remote-debugging-port="$PORT" \
    --user-data-dir="$PROFILE_DIR" \
    --no-first-run \
    --no-default-browser-check \
    "$@"
