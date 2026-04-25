#!/usr/bin/env bash
# Bootstrap and start the scraper with .env (via npm start → --env-file-if-exists=.env).
# Usage: ./run.sh
# Optional: VERBOSE=1 ./run.sh  — bash trace (set -x) to stderr
# Optional: LOG_FILE=path ./run.sh — append all stdout/stderr to a file as well as the terminal
# Optional: SKIP_PLAYWRIGHT=1 ./run.sh — skip browser install
# Optional: PLAYWRIGHT_WITH_DEPS=1 ./run.sh — same as Render: npx playwright install --with-deps chromium (may need sudo / apt)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

NODE_MIN_MAJOR="${NODE_MIN_MAJOR:-20}"
NVM_VERSION="${NVM_VERSION:-v0.40.1}"

log() {
    printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

if [[ -n "${LOG_FILE:-}" ]]; then
    mkdir -p "$(dirname "$LOG_FILE")"
    exec > >(tee -a "$LOG_FILE") 2>&1
    log "Tee active: appending stdout/stderr to $LOG_FILE"
fi

if [[ "${VERBOSE:-0}" == 1 ]]; then
    set -x
    PS4='+ [${BASH_SOURCE[0]}:${LINENO}] '
fi

log "Working directory: $ROOT"
log "PATH: $PATH"

need_node() {
    if ! command -v node >/dev/null 2>&1; then
        return 0
    fi
    local major
    major="$(node -p "parseInt(process.versions.node.split('.')[0], 10)" 2>/dev/null || echo 0)"
    if [[ "$major" -lt "$NODE_MIN_MAJOR" ]]; then
        log "Node $(node -v 2>/dev/null || true) is below required >= ${NODE_MIN_MAJOR}"
        return 0
    fi
    return 1
}

install_node_lts_nvm() {
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
        log "Installing nvm ($NVM_VERSION) under $NVM_DIR"
        curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
    fi
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    log "Installing Node LTS via nvm (required: >= ${NODE_MIN_MAJOR})"
    nvm install --lts
    nvm use --lts
    hash -r 2>/dev/null || true
}

if need_node; then
    install_node_lts_nvm
fi

if ! command -v node >/dev/null 2>&1; then
    log "ERROR: node still not on PATH after install attempt"
    exit 1
fi

log "Node $(command -v node) — $(node -v)"
log "npm $(command -v npm) — $(npm -v)"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    GIT_ROOT="$(git rev-parse --show-toplevel)"
    log "git fetch origin (toplevel: $GIT_ROOT)"
    (cd "$GIT_ROOT" && git fetch origin)
    log "git fetch finished"
else
    log "Not inside a git work tree; skipping git fetch"
fi

log "npm install"
npm install

if [[ "${SKIP_PLAYWRIGHT:-0}" != 1 ]]; then
    if [[ "${PLAYWRIGHT_WITH_DEPS:-0}" == 1 ]]; then
        log "npx playwright install --with-deps chromium (Render build parity)"
        npx playwright install --with-deps chromium
    else
        log "npx playwright install chromium"
        npx playwright install chromium
    fi
else
    log "SKIP_PLAYWRIGHT=1 — skipping Playwright Chromium install"
fi

log "Starting server (loads .env if present: npm run start)"
exec npm start
