#!/bin/bash
# SWU AI Self-Play Bot Launcher
# Starts the Forceteki server and two bot instances for self-play training

set -e

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$BOT_DIR")"

echo "=== Starting SWU AI Self-Play ==="
echo "Bot dir: $BOT_DIR"
echo "Repo dir: $REPO_DIR"

# 1. Start the data server (port 3456) - if exists
if [ -f "$REPO_DIR/server/index.js" ]; then
  echo "Starting data server..."
  node "$REPO_DIR/server/index.js" &
  DATA_PID=$!
  sleep 1
fi

# 2. Start the Forceteki game server
if [ -f "$REPO_DIR/forceteki/server/index.js" ]; then
  echo "Starting Forceteki game server..."
  cd "$REPO_DIR/forceteki"
  node server/index.js &
  GAME_PID=$!
  cd "$BOT_DIR"
  sleep 3
fi

# 3. Install dependencies if needed
if [ ! -d "$BOT_DIR/node_modules" ]; then
  echo "Installing bot dependencies..."
  cd "$BOT_DIR"
  npm install
fi

# 4. Start the bot(s)
echo "Starting bots..."
cd "$BOT_DIR"
SELF_PLAY=true node bot.js

# Cleanup on exit
cleanup() {
  echo "Shutting down..."
  kill $GAME_PID 2>/dev/null || true
  kill $DATA_PID 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

wait
