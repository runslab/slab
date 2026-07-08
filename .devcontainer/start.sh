#!/usr/bin/env bash
# Runs on every codespace start: bring the daemon up and seed the rack.
set -uo pipefail

if ! curl -fsS -m 2 http://127.0.0.1:7766/v1/health >/dev/null 2>&1; then
  echo "── starting the slab daemon…"
  nohup node "$PWD/dist/daemon.js" > /tmp/slab-daemon.log 2>&1 &
  for _ in $(seq 1 40); do
    curl -fsS -m 1 http://127.0.0.1:7766/v1/health >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

# seed the rack so the dashboard isn't empty on first open (idempotent)
if ! slab list 2>/dev/null | grep -q hello-fn; then
  echo "── seeding the rack…"
  slab deploy "$PWD/examples/hello-fn" >/dev/null 2>&1 || true
  slab deploy "$PWD/examples/mario" >/dev/null 2>&1 || true
fi

# lifecycle hooks sometimes run without the codespace env — recover it from a login shell
if [ -z "${CODESPACE_NAME:-}" ]; then
  eval "$(bash -lc 'echo CODESPACE_NAME=${CODESPACE_NAME:-}; echo GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN=${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}' 2>/dev/null)" || true
fi

DASH="http://localhost:7766"
if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
  DASH="https://${CODESPACE_NAME}-7766.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
fi

cat <<EOF

  ┌──────────────────────────────────────────────────────────┐
  │  slab is running — the rack is live.                     │
  └──────────────────────────────────────────────────────────┘

  dashboard (open in a browser tab):
  ${DASH}

  try:
    slab list
    slab deploy dockersamples/linux_tweet_app
    slab run . -- echo hello from a job
    slab expose mario        # public https url, playable anywhere

EOF
