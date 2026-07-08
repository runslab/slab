#!/usr/bin/env bash
# Printed at the top of every interactive terminal in a codespace (wired into
# ~/.bashrc by setup.sh) — the user must never hunt for the dashboard URL.
DASH="http://localhost:7766"
if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
  DASH="https://${CODESPACE_NAME}-7766.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
fi
if curl -fsS -m 1 http://127.0.0.1:7766/v1/health >/dev/null 2>&1; then
  STATE="the rack is live"
else
  STATE="daemon starts with your first slab command"
fi

printf '\n  \033[1mslab\033[0m — %s\n' "$STATE"
printf '  dashboard: \033[4m%s\033[0m\n\n' "$DASH"
printf '  try:  slab list · slab deploy dockersamples/linux_tweet_app\n'
printf '        slab run . -- echo hello · slab expose mario\n\n'
