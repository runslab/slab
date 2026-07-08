#!/usr/bin/env bash
# Codespace bootstrap: build slab, put it on PATH, grab cloudflared for `slab expose`.
set -euo pipefail

echo "── building slab…"
npm ci --silent --no-fund --no-audit
npm run build --silent
chmod +x dist/cli.js
sudo ln -sf "$PWD/dist/cli.js" /usr/local/bin/slab

# cloudflared: lets the demo expose apps to the real internet from a codespace
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "── installing cloudflared…"
  ARCH=$(dpkg --print-architecture)
  curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb"
  sudo dpkg -i /tmp/cloudflared.deb >/dev/null || true
fi

echo "── slab built. the daemon starts automatically (postStart)."
