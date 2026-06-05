#!/usr/bin/env bash
# Bootstrap and start the scraper with .env (via npm start → --env-file-if-exists=.env).
# Usage: ./run.sh
# Optional: VERBOSE=1 ./run.sh  — bash trace (set -x) to stderr
# Optional: LOG_FILE=path ./run.sh — append all stdout/stderr to a file as well as the terminal
# Optional: SKIP_PLAYWRIGHT=1 ./run.sh — skip browser install
# Optional: PLAYWRIGHT_WITH_DEPS=1 ./run.sh — same as Render: npx playwright install --with-deps chromium (may need sudo / apt)
# Optional: SKIP_FREE_PORT=1 ./run.sh — do not kill whatever is already listening on PORT
# Optional: RUN_FOREGROUND=1 ./run.sh — stay attached (default: background via nohup, survives closing SSH)
# Optional: SERVER_LOG=path ./run.sh — server stdout/stderr when background (default: $ROOT/server.log)

# No `set -u`: nvm.sh and other sourced tools use unset variables; nounset breaks `nvm use`.
set -eo pipefail

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

# Same default as src/config/env.js (8092). PORT env wins; else first line PORT= in .env.
resolve_listen_port() {
    if [[ -n "${PORT:-}" ]]; then
        echo "$PORT"
        return
    fi
    if [[ -f "$ROOT/.env" ]]; then
        local from_env
        from_env="$(cd "$ROOT" && node --env-file-if-exists=.env -e "process.stdout.write(String(process.env.PORT || ''))" 2>/dev/null || true)"
        if [[ -n "$from_env" && "$from_env" =~ ^[0-9]+$ ]]; then
            echo "$from_env"
            return
        fi
    fi
    echo "8092"
}

# Stop orphaned server from a closed terminal so this run can bind PORT again.
free_listen_port() {
    local port="$1"
    if ! [[ "$port" =~ ^[0-9]+$ ]]; then
        log "WARN: invalid port '$port', skip freeing port"
        return 0
    fi
    local pid_list=()
    if command -v lsof >/dev/null 2>&1; then
        mapfile -t pid_list < <(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u)
    elif command -v ss >/dev/null 2>&1; then
        mapfile -t pid_list < <(ss -lptn 2>/dev/null | grep -E "[:.]${port}\\b" | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u)
    elif command -v fuser >/dev/null 2>&1; then
        log "Using fuser -k on port $port"
        fuser -k -TERM "${port}/tcp" 2>/dev/null || true
        sleep 1
        fuser -k -KILL "${port}/tcp" 2>/dev/null || true
        return 0
    else
        log "WARN: no lsof, ss, or fuser — cannot free port $port automatically"
        return 0
    fi
    if [[ ${#pid_list[@]} -eq 0 || -z "${pid_list[0]:-}" ]]; then
        log "Port $port is free (no TCP listener)"
        return 0
    fi
    log "Stopping old listener(s) on port $port: ${pid_list[*]}"
    kill -TERM "${pid_list[@]}" 2>/dev/null || true
    sleep 1
    kill -KILL "${pid_list[@]}" 2>/dev/null || true
}

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

wait_for_apt_locks() {
    local timeout_sec="${APT_LOCK_TIMEOUT_SEC:-900}"
    local interval_sec="${APT_LOCK_POLL_SEC:-5}"
    local started now elapsed lock busy
    local locks=(
        /var/lib/apt/lists/lock
        /var/lib/dpkg/lock
        /var/lib/dpkg/lock-frontend
    )

    if ! command -v fuser >/dev/null 2>&1 && ! command -v lsof >/dev/null 2>&1; then
        log "WARN: neither fuser nor lsof available — skipping apt lock wait"
        return 0
    fi

    started="$(date +%s)"
    while :; do
        busy=""
        for lock in "${locks[@]}"; do
            if command -v fuser >/dev/null 2>&1; then
                if fuser "$lock" >/dev/null 2>&1; then
                    busy="$lock"
                    break
                fi
            elif command -v lsof >/dev/null 2>&1; then
                if lsof "$lock" >/dev/null 2>&1; then
                    busy="$lock"
                    break
                fi
            fi
        done

        if [[ -z "$busy" ]]; then
            return 0
        fi

        now="$(date +%s)"
        elapsed=$((now - started))
        if (( elapsed >= timeout_sec )); then
            log "ERROR: apt lock still busy after ${timeout_sec}s: $busy"
            return 1
        fi

        log "Waiting for apt lock to clear: $busy (${elapsed}s/${timeout_sec}s)"
        sleep "$interval_sec"
    done
}

install_playwright_chromium() {
    if [[ "${PLAYWRIGHT_WITH_DEPS:-0}" == 1 ]]; then
        log "npx playwright install --with-deps chromium (Render build parity)"
        if ! wait_for_apt_locks; then
            return 1
        fi
        if ! npx playwright install --with-deps chromium; then
            log "WARN: Playwright deps install failed, checking apt locks and retrying once"
            wait_for_apt_locks || return 1
            npx playwright install --with-deps chromium
        fi
    else
        log "npx playwright install chromium"
        npx playwright install chromium
    fi
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
    install_playwright_chromium
else
    log "SKIP_PLAYWRIGHT=1 — skipping Playwright Chromium install"
fi

LISTEN_PORT="$(resolve_listen_port)"
if [[ "${SKIP_FREE_PORT:-0}" != 1 ]]; then
    free_listen_port "$LISTEN_PORT"
else
    log "SKIP_FREE_PORT=1 — not killing listeners on port $LISTEN_PORT"
fi

log "Starting server on port $LISTEN_PORT (loads .env if present: npm run start)"

if [[ "${RUN_FOREGROUND:-0}" == 1 ]]; then
    log "RUN_FOREGROUND=1 — attached to terminal (Ctrl+C stops the server)"
    exec npm start
fi

SERVER_LOG="${SERVER_LOG:-$ROOT/server.log}"
mkdir -p "$(dirname "$SERVER_LOG")"
nohup npm start >>"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
log "Server running in background (PID $SERVER_PID). Close this terminal safely."
log "Tail logs: tail -f $SERVER_LOG"
log "Stop: kill $SERVER_PID   or re-run ./run.sh (frees port then starts a new instance)"
