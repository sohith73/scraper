#!/usr/bin/env bash
# docker.sh — one-shot bring-up for the FlashFire JR scraper.
#
# What it does:
#   1. Detects OS + installs Docker Engine + Compose v2 if missing.
#   2. Installs Node 20 LTS host-side (optional — container ships its own).
#   3. Adds current user to `docker` group.
#   4. Bootstraps `.env` from `.env.example` if absent.
#   5. Builds + brings the stack up. The Playwright base image has Chromium
#      preinstalled so `npx playwright install` is NOT required.
#   6. Waits for /api/health → "healthy", tails logs.
#
# Usage:
#   ./docker.sh             # bootstrap deps + build + up + wait
#   ./docker.sh up          # build + up
#   ./docker.sh down        # stop + remove
#   ./docker.sh restart     # restart container
#   ./docker.sh logs        # follow logs
#   ./docker.sh ps          # status
#   ./docker.sh status      # health probe + container state
#   ./docker.sh shell       # bash inside container
#   ./docker.sh first-login # interactive headed JR login (one-time)
#   ./docker.sh nuke        # down -v + system prune (DESTRUCTIVE)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---- pretty logging --------------------------------------------------------
if [ -t 1 ]; then
    BOLD='\033[1m'; RED='\033[31m'; GREEN='\033[32m'; YELLOW='\033[33m'; BLUE='\033[34m'; DIM='\033[2m'; RESET='\033[0m'
else
    BOLD=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; DIM=''; RESET=''
fi
log()    { printf "${BLUE}▸ %s${RESET}\n" "$*"; }
ok()     { printf "${GREEN}✓ %s${RESET}\n" "$*"; }
warn()   { printf "${YELLOW}! %s${RESET}\n" "$*"; }
err()    { printf "${RED}✗ %s${RESET}\n" "$*" >&2; }
section(){ printf "\n${BOLD}== %s ==${RESET}\n" "$*"; }

require_cmd() { command -v "$1" >/dev/null 2>&1; }
sudo_cmd()    { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# ---- OS detection ----------------------------------------------------------
detect_os() {
    if [ -f /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        OS_ID="${ID:-unknown}"; OS_LIKE="${ID_LIKE:-}"
    else
        OS_ID="unknown"; OS_LIKE=""
    fi
}

# ---- Docker install --------------------------------------------------------
install_docker() {
    if require_cmd docker && docker --version >/dev/null 2>&1; then
        ok "Docker present: $(docker --version)"
        return 0
    fi
    section "Installing Docker"
    case "$OS_ID" in
        ubuntu|debian|rhel|centos|fedora|rocky|almalinux|amzn|ol)
            log "Running official get-docker.sh"
            curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
            sudo_cmd sh /tmp/get-docker.sh
            rm -f /tmp/get-docker.sh
            ;;
        alpine)
            sudo_cmd apk add --no-cache docker docker-cli-compose
            sudo_cmd rc-update add docker default || true
            sudo_cmd service docker start || true
            ;;
        arch|manjaro)
            sudo_cmd pacman -Sy --noconfirm docker docker-compose
            ;;
        *)
            err "Unsupported OS '$OS_ID'. Install Docker manually: https://docs.docker.com/engine/install/"
            exit 1
            ;;
    esac
    sudo_cmd systemctl enable --now docker 2>/dev/null || true
    ok "Docker installed: $(docker --version || echo pending)"
}

# ---- Compose v2 check ------------------------------------------------------
ensure_compose() {
    if docker compose version >/dev/null 2>&1; then
        ok "Compose v2: $(docker compose version | head -n1)"
        return 0
    fi
    section "Installing Compose v2 plugin"
    case "$OS_ID" in
        ubuntu|debian)
            sudo_cmd apt-get update -y
            sudo_cmd apt-get install -y docker-compose-plugin ;;
        rhel|centos|fedora|rocky|almalinux|amzn|ol)
            sudo_cmd dnf install -y docker-compose-plugin || sudo_cmd yum install -y docker-compose-plugin ;;
        *)  warn "Cannot auto-install compose v2 on '$OS_ID' — install manually." ;;
    esac
}

# ---- docker group ----------------------------------------------------------
ensure_docker_group() {
    if [ "$(id -u)" -eq 0 ]; then return 0; fi
    if id -nG "$USER" 2>/dev/null | grep -qw docker; then
        ok "User '$USER' already in docker group"; return 0
    fi
    log "Adding '$USER' to docker group (re-login required)"
    sudo_cmd usermod -aG docker "$USER" || warn "Could not add to docker group; commands will use sudo"
    NEED_RELOGIN=1
}

# ---- Node host-side (optional) --------------------------------------------
install_node() {
    if require_cmd node && node -v | grep -Eq '^v(2[0-9]|[3-9][0-9])'; then
        ok "Node present: $(node -v)"; return 0
    fi
    section "Installing Node 20 LTS (host-side, optional — container has its own)"
    case "$OS_ID" in
        ubuntu|debian)
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo_cmd -E bash -
            sudo_cmd apt-get install -y nodejs ;;
        rhel|centos|fedora|rocky|almalinux|amzn|ol)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo_cmd -E bash -
            sudo_cmd dnf install -y nodejs || sudo_cmd yum install -y nodejs ;;
        alpine) sudo_cmd apk add --no-cache nodejs npm ;;
        arch|manjaro) sudo_cmd pacman -Sy --noconfirm nodejs npm ;;
        *) warn "Skipping host-side Node install on '$OS_ID'." ;;
    esac
}

# ---- env bootstrap ---------------------------------------------------------
ensure_env() {
    if [ -f .env ]; then ok ".env present"; return 0; fi
    if [ -f .env.example ]; then
        cp .env.example .env
        warn "Created .env from .env.example — fill in OPENAI_API_KEY, JOBRIGHT_EMAIL/PASSWORD, DASHBOARD_BASE, etc."
    else
        warn "No .env or .env.example found — container will boot with empty env."
        : > .env
    fi
}

ensure_dirs() {
    mkdir -p storage runs ai-cache
    chmod 0700 storage 2>/dev/null || true
}

# ---- compose helper --------------------------------------------------------
COMPOSE() {
    if docker compose version >/dev/null 2>&1; then
        if [ "$(id -u)" -eq 0 ] || id -nG "$USER" 2>/dev/null | grep -qw docker; then
            docker compose "$@"
        else
            sudo docker compose "$@"
        fi
    else
        if [ "$(id -u)" -eq 0 ] || id -nG "$USER" 2>/dev/null | grep -qw docker; then
            docker-compose "$@"
        else
            sudo docker-compose "$@"
        fi
    fi
}

# ---- actions ---------------------------------------------------------------
cmd_up() {
    section "Building image (Playwright base — Chromium pre-installed)"
    COMPOSE build --pull
    section "Starting container (detached, restart=always)"
    COMPOSE up -d --remove-orphans
    section "Waiting for healthcheck"
    local tries=40 cid status
    cid="$(COMPOSE ps -q scraper 2>/dev/null || true)"
    [ -z "$cid" ] && { err "container not found after up"; COMPOSE logs --tail=50 scraper; exit 1; }
    while [ "$tries" -gt 0 ]; do
        status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo unknown)"
        case "$status" in
            healthy)  ok "Container healthy"; return 0 ;;
            starting) printf '.'; sleep 2 ;;
            unhealthy)
                err "Container reported unhealthy. Last 100 log lines:"
                COMPOSE logs --tail=100 scraper
                exit 1 ;;
            *) printf '?'; sleep 2 ;;
        esac
        tries=$((tries - 1))
    done
    warn "Healthcheck did not reach 'healthy' in 80s. Container is still running. Logs:"
    COMPOSE logs --tail=100 scraper
}

cmd_down()    { COMPOSE down --remove-orphans; }
cmd_restart() { COMPOSE restart scraper; }
cmd_logs()    { COMPOSE logs -f --tail=100 scraper; }
cmd_ps()      { COMPOSE ps; }
cmd_shell()   { COMPOSE exec scraper bash; }

cmd_status() {
    section "Container status"
    COMPOSE ps
    section "Health"
    local cid
    cid="$(COMPOSE ps -q scraper 2>/dev/null || true)"
    if [ -n "$cid" ]; then
        docker inspect -f '  state:    {{.State.Status}}
  health:   {{.State.Health.Status}}
  started:  {{.State.StartedAt}}
  restarts: {{.RestartCount}}' "$cid" || true
    else
        warn "No scraper container."
    fi
    section "Quick health probe"
    local port
    port="$(grep -E '^PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2 || true)"
    port="${port:-8092}"
    if curl -fsS "http://localhost:${port}/api/health" >/dev/null 2>&1; then
        ok "GET /api/health → 200 (port ${port})"
    else
        warn "GET /api/health did not return 200 on port ${port}"
    fi
}

# ---- first-login (interactive headed Chromium) ----------------------------
# Container is headless by default. To do the one-time JR login, mount X11
# socket + DISPLAY into a temporary headed run. Linux + X11 only. On a
# remote box, set JOBRIGHT_EMAIL/PASSWORD in .env instead — the scraper's
# session.js will form-login programmatically.
cmd_first_login() {
    section "First-login (headed Chromium via X11 forwarding)"
    if [ -z "${DISPLAY:-}" ]; then
        warn "No DISPLAY env. On a remote box, set JOBRIGHT_EMAIL + JOBRIGHT_PASSWORD in .env and let the scraper auto-login."
        exit 1
    fi
    xhost +local:docker 2>/dev/null || warn "xhost not available — clipboard/cookie save may fail"
    local cid
    cid="$(COMPOSE ps -q scraper 2>/dev/null || true)"
    if [ -z "$cid" ]; then
        err "Container not running. Run './docker.sh up' first."
        exit 1
    fi
    docker exec -it \
        -e DISPLAY="$DISPLAY" \
        -e HEADLESS=false \
        -v /tmp/.X11-unix:/tmp/.X11-unix:ro \
        "$cid" bash -lc 'cd /app && node recon/jobright-recon.mjs || npm run recon'
}

cmd_nuke() {
    warn "About to: docker compose down -v + system prune. Press Ctrl+C in 5s to abort."
    sleep 5
    COMPOSE down -v --remove-orphans
    docker system prune -f
}

# ---- main ------------------------------------------------------------------
main() {
    detect_os
    local action="${1:-bootstrap}"
    case "$action" in
        bootstrap|"")
            section "Bootstrapping FlashFire scraper on $OS_ID"
            install_docker
            ensure_compose
            ensure_docker_group
            install_node
            ensure_env
            ensure_dirs
            cmd_up
            section "Done"
            local port
            port="$(grep -E '^PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2 || echo 8092)"
            ok "Scraper running at http://localhost:${port:-8092}"
            log "Tail logs:    ./docker.sh logs"
            log "Stop:         ./docker.sh down"
            log "Restart:      ./docker.sh restart"
            log "Status:       ./docker.sh status"
            log "Shell:        ./docker.sh shell"
            log "First-login:  ./docker.sh first-login   (X11 only — else use env-based login)"
            if [ "${NEED_RELOGIN:-0}" = "1" ]; then
                warn "User added to 'docker' group — log out and back in (or 'newgrp docker') so non-sudo docker works."
            fi ;;
        up)          cmd_up ;;
        down)        cmd_down ;;
        restart)     cmd_restart ;;
        logs)        cmd_logs ;;
        ps)          cmd_ps ;;
        status)      cmd_status ;;
        shell)       cmd_shell ;;
        first-login) cmd_first_login ;;
        nuke)        cmd_nuke ;;
        *)  err "Unknown command: $action"; sed -n '3,25p' "$0"; exit 1 ;;
    esac
}

main "$@"
