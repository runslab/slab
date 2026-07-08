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

# greet every terminal with the dashboard url (postStart output is buried in
# the configuration log — the motd is what a demo user actually sees)
MOTD_LINE="bash $PWD/.devcontainer/motd.sh"
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  touch "$rc"
  grep -qF "devcontainer/motd.sh" "$rc" || printf '\n%s\n' "$MOTD_LINE" >> "$rc"
done

echo "── slab built. the daemon starts automatically (postStart)."
