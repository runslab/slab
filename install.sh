#!/usr/bin/env bash
# slab installer — the localhost hyperscaler
#
#   curl -fsSL https://raw.githubusercontent.com/jasonmimick/slab/master/install.sh | bash
#
# What it does: checks prerequisites (git, node >= 20, docker), clones slab
# to ~/.slab/src (or pulls if already there), builds it, puts `slab` on your
# PATH, and starts the daemon. Re-running upgrades in place.
#
# Overrides: SLAB_REPO (git url), SLAB_HOME (default ~/.slab), SLAB_NO_START=1
set -euo pipefail

REPO="${SLAB_REPO:-https://github.com/jasonmimick/slab.git}"
SLAB_HOME="${SLAB_HOME:-$HOME/.slab}"
SRC="$SLAB_HOME/src"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; AMB=$'\033[33m'; RST=$'\033[0m'
say()  { printf '%s\n' "${1-}"; }
ok()   { say "  ${GRN}✓${RST} $1"; }
warn() { say "  ${AMB}!${RST} $1"; }
die()  {
  say ""; say "  ${RED}✗ $1${RST}"
  if [ -n "${2-}" ]; then say "    ${DIM}fix:${RST} $2"; fi
  say ""; exit 1
}

say ""
say "${BOLD}  slab${RST} ${DIM}— the localhost hyperscaler${RST}"
say ""

# ── prerequisites ─────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "unsupported OS: $(uname -s)" "slab runs on macOS and Linux (on Windows, use WSL2)" ;;
esac

HAVE_BREW=""
if command -v brew >/dev/null 2>&1; then HAVE_BREW=1; fi

command -v git >/dev/null 2>&1 \
  || die "git is not installed" "$([ -n "$HAVE_BREW" ] && echo 'brew install git' || echo 'https://git-scm.com/downloads')"
ok "git $(git --version | awk '{print $3}')"

if ! command -v node >/dev/null 2>&1; then
  die "node is not installed (slab needs Node.js >= 20)" \
      "$([ -n "$HAVE_BREW" ] && echo 'brew install node' || echo 'https://nodejs.org — or your package manager')"
fi
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
[ "$NODE_MAJOR" -ge 20 ] \
  || die "node $(node --version) is too old (need >= 20)" \
         "$([ -n "$HAVE_BREW" ] && echo 'brew upgrade node' || echo 'https://nodejs.org')"
ok "node $(node --version)"

command -v docker >/dev/null 2>&1 \
  || die "docker is not installed" \
         "$(if [ "$(uname -s)" = Darwin ]; then echo 'https://docker.com/products/docker-desktop (or: brew install --cask docker)'; else echo 'curl -fsSL https://get.docker.com | sh'; fi)"
if docker info >/dev/null 2>&1; then
  ok "docker $(docker info --format '{{.ServerVersion}}' 2>/dev/null || echo '(engine up)')"
else
  die "docker is installed but the engine isn't running" \
      "$(if [ "$(uname -s)" = Darwin ]; then echo 'start Docker Desktop, then re-run this installer'; else echo 'sudo systemctl start docker'; fi)"
fi

if command -v cloudflared >/dev/null 2>&1; then
  ok "cloudflared (public tunnels via slab expose)"
else
  warn "cloudflared not found — optional; only needed for ${BOLD}slab expose${RST} ${DIM}($([ -n "$HAVE_BREW" ] && echo 'brew install cloudflared' || echo 'https://github.com/cloudflare/cloudflared'))${RST}"
fi

# ── fetch + build ─────────────────────────────────────────────────────────────
say ""
mkdir -p "$SLAB_HOME"
if [ -d "$SRC/.git" ]; then
  say "  ${DIM}updating $SRC${RST}"
  git -C "$SRC" pull --ff-only --quiet
else
  say "  ${DIM}cloning $REPO -> $SRC${RST}"
  git clone --depth 1 --quiet "$REPO" "$SRC"
fi

say "  ${DIM}installing dependencies + building…${RST}"
(cd "$SRC" && npm ci --silent --no-fund --no-audit && npm run build --silent) \
  || die "build failed" "check the output above; re-run after fixing"
ok "built $(git -C "$SRC" rev-parse --short HEAD)"

# ── put `slab` on PATH ────────────────────────────────────────────────────────
chmod +x "$SRC/dist/cli.js"
BIN_DIR="/usr/local/bin"
[ -w "$BIN_DIR" ] || { BIN_DIR="$HOME/.local/bin"; mkdir -p "$BIN_DIR"; }
ln -sf "$SRC/dist/cli.js" "$BIN_DIR/slab"
ok "slab -> $BIN_DIR/slab"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add:  ${BOLD}export PATH=\"$BIN_DIR:\$PATH\"${RST}" ;;
esac

# ── start the daemon ──────────────────────────────────────────────────────────
if [ -n "${SLAB_NO_START-}" ]; then
  warn "SLAB_NO_START set — start it yourself:  node $SRC/dist/daemon.js"
elif curl -fsS -m 2 http://127.0.0.1:7766/v1/health >/dev/null 2>&1; then
  warn "a slab daemon is already running — pick up this version with:  ${BOLD}slab upgrade${RST}"
else
  say "  ${DIM}starting the daemon…${RST}"
  nohup node "$SRC/dist/daemon.js" > "$SLAB_HOME/daemon.log" 2>&1 &
  for _ in $(seq 1 40); do
    curl -fsS -m 1 http://127.0.0.1:7766/v1/health >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -fsS -m 2 http://127.0.0.1:7766/v1/health >/dev/null 2>&1 \
    || die "daemon did not come up" "see $SLAB_HOME/daemon.log"
  ok "daemon up — api :7766, ingress :8080 ${DIM}(log: $SLAB_HOME/daemon.log)${RST}"
fi

say ""
say "  ${BOLD}done.${RST} next moves:"
say ""
say "    ${BOLD}open http://localhost:7766${RST}        ${DIM}the rack${RST}"
say "    slab deploy owner/repo             ${DIM}any github repo with a Dockerfile${RST}"
say "    slab run . -- npm test             ${DIM}one-shot job in a container${RST}"
say "    slab list · slab jobs · slab status"
say ""
