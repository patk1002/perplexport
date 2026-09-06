#!/usr/bin/env bash
set -euo pipefail

echo "== perplexport installer =="

# --- Node.js check ---
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js not found. Install Node 18+ before continuing." >&2
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "WARNING: Node $(node -v) detected; Node 18+ is recommended." >&2
fi

# --- npm/yarn check ---
if command -v yarn >/dev/null 2>&1; then
  PKG_MANAGER="yarn"
elif command -v npm >/dev/null 2>&1; then
  PKG_MANAGER="npm"
else
  echo "ERROR: Neither npm nor yarn found." >&2
  exit 1
fi
echo "Using package manager: $PKG_MANAGER"

# --- System libraries (Debian/Ubuntu only) ---
if command -v apt-get >/dev/null 2>&1; then
  echo "Detected apt-based system. Installing Chromium runtime dependencies..."
  sudo apt-get update
  sudo apt-get install -y \
    libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 \
    libxss1 libxshmfence1 libx11-xcb1 fonts-liberation
else
  echo "Non-apt system detected; skipping automatic system library install."
  echo "See PREREQUISITES.md for the equivalent packages on your platform."
fi

# --- GUI display check (best-effort, informational only) ---
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "WARNING: No DISPLAY or WAYLAND_DISPLAY detected." >&2
  echo "         Login requires a visible browser window. If you're on" >&2
  echo "         WSL2, make sure WSLg is enabled." >&2
fi

# --- Install and build ---
echo "Installing dependencies..."
if [ "$PKG_MANAGER" = "yarn" ]; then
  yarn install
else
  npm install
fi

echo "Building..."
npm run build

echo ""
echo "== Install complete =="
echo "Run with:"
echo "  node dist/cli.js -e <your-perplexity-email> -o ./conversations -d done.json"