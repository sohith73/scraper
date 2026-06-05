#!/usr/bin/env bash
# cluster.sh — auto-containerize + horizontally scale the FlashFire JR scraper
# behind a built-in nginx load balancer. One script: builds the image, spawns
# N identical scraper containers, generates the LB config, brings it all up.
#
#   ./cluster.sh              # bootstrap: build + up N replicas + LB + wait
#   ./cluster.sh up           # (re)generate config, build, up, health-wait
#   ./cluster.sh down         # stop + remove the whole cluster
#   ./cluster.sh restart      # restart every scraper + the LB
#   ./cluster.sh logs [svc]   # follow logs (all, or e.g. scraper-2 / lb)
#   ./cluster.sh ps           # container status
#   ./cluster.sh status       # per-replica health + LB probe
#   ./cluster.sh scale N      # change replica count → regenerate + up
#   ./cluster.sh gen          # only (re)generate compose + nginx.conf, no up
#   ./cluster.sh nuke         # down -v + prune (DESTRUCTIVE)
#
# Knobs (env):
#   REPLICAS=3        how many scraper containers (default 3)
#   LB_PORT=8092      host port the load balancer publishes (default = .env PORT or 8092)
#   LB_METHOD=ip_hash nginx upstream method: ip_hash (sticky, default) | roundrobin
#   IMAGE=flashfire-scraper:latest
#
# WHY a generator instead of `docker compose --scale`:
#   The scraper holds a Playwright *persistent context* (Chromium userDataDir).
#   Two containers on the SAME storage dir corrupt the profile (CLAUDE.md
#   gotcha #9). `--scale` clones identical volume mounts → all replicas would
#   share ./storage → corruption. So each replica gets its OWN storage dir
#   (./cluster/storage-N). runs/ + ai-cache/ are per-run-unique / atomic-write,
#   so they're SHARED (cross-replica cache hits, readable run snapshots).
#
# STICKINESS:
#   Run state + SSE emitters live in memory per container (runStore.js). The LB
#   uses ip_hash so a given operator's browser pins to one replica → the run it
#   starts there is the one it polls/streams. Different operators spread across
#   replicas = the actual load balancing. Set LB_METHOD=roundrobin only if you
#   don't use the live SSE progress stream.
#
# CAVEAT — shared JobRight account:
#   All replicas log into JR with the same JOBRIGHT_EMAIL/PASSWORD (separate
#   storage = separate login each). JR may throttle concurrent sessions. True
#   multi-account rotation is still deferred (CLAUDE.md "What's NOT here").

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REPLICAS="${REPLICAS:-3}"
LB_METHOD="${LB_METHOD:-ip_hash}"
IMAGE="${IMAGE:-flashfire-scraper:latest}"
CLUSTER_DIR="$SCRIPT_DIR/cluster"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.cluster.yml"
NGINX_CONF="$CLUSTER_DIR/nginx.conf"
PROJECT="flashfire-cluster"
CONTAINER_PORT=8092   # internal listen port inside every scraper container

# ---- pretty logging --------------------------------------------------------
if [ -t 1 ]; then
    BOLD='\033[1m'; RED='\033[31m'; GREEN='\033[32m'; YELLOW='\033[33m'; BLUE='\033[34m'; RESET='\033[0m'
else
    BOLD=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; RESET=''
fi
log()     { printf "${BLUE}▸ %s${RESET}\n" "$*"; }
ok()      { printf "${GREEN}✓ %s${RESET}\n" "$*"; }
warn()    { printf "${YELLOW}! %s${RESET}\n" "$*"; }
err()     { printf "${RED}✗ %s${RESET}\n" "$*" >&2; }
section() { printf "\n${BOLD}== %s ==${RESET}\n" "$*"; }

# ---- resolve published LB port (arg > env > .env PORT > 8092) ---------------
resolve_lb_port() {
    if [ -n "${LB_PORT:-}" ]; then echo "$LB_PORT"; return; fi
    local p=""
    if [ -f .env ]; then
        p="$(grep -E '^PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2 | tr -d '"' | tr -d "'" || true)"
    fi
    [[ "$p" =~ ^[0-9]+$ ]] && echo "$p" || echo "8092"
}

# ---- compose helper (sudo fallback like docker.sh) -------------------------
COMPOSE() {
    if [ "$(id -u)" -eq 0 ] || id -nG "$USER" 2>/dev/null | grep -qw docker; then
        docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
    else
        sudo docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
    fi
}
DOCKER() {
    if [ "$(id -u)" -eq 0 ] || id -nG "$USER" 2>/dev/null | grep -qw docker; then
        docker "$@"
    else
        sudo docker "$@"
    fi
}

# ---- env bootstrap ---------------------------------------------------------
ensure_env() {
    if [ -f .env ]; then return 0; fi
    if [ -f .env.example ]; then
        cp .env.example .env
        warn "Created .env from .env.example — fill OPENAI_API_KEY, JOBRIGHT_*, DASHBOARD_BASE, MONGO_URI."
    else
        warn "No .env / .env.example — replicas boot with empty env."
        : > .env
    fi
}

validate_replicas() {
    if ! [[ "$REPLICAS" =~ ^[0-9]+$ ]] || [ "$REPLICAS" -lt 1 ]; then
        err "REPLICAS must be a positive integer (got '$REPLICAS')"; exit 1
    fi
    if [ "$REPLICAS" -gt 20 ]; then
        warn "REPLICAS=$REPLICAS is high — each is a full Chromium (~0.5-2GB). Continuing."
    fi
}

# ---- generate per-replica storage dirs -------------------------------------
ensure_dirs() {
    mkdir -p runs ai-cache "$CLUSTER_DIR"
    local i
    for i in $(seq 1 "$REPLICAS"); do
        mkdir -p "$CLUSTER_DIR/storage-$i"
        chmod 0700 "$CLUSTER_DIR/storage-$i" 2>/dev/null || true
    done
}

# ---- generate nginx.conf ---------------------------------------------------
gen_nginx_conf() {
    local method_line="    ip_hash;"
    [ "$LB_METHOD" = "roundrobin" ] && method_line="    # round-robin (nginx default)"

    {
        printf '# AUTO-GENERATED by cluster.sh — edits are overwritten on `up`/`gen`.\n'
        printf 'worker_processes auto;\n'
        printf 'events { worker_connections 4096; }\n\n'
        printf 'http {\n'
        printf '    access_log off;\n'
        printf '    upstream scraper_pool {\n'
        printf '%s\n' "$method_line"
        local i
        for i in $(seq 1 "$REPLICAS"); do
            printf '        server scraper-%s:%s max_fails=3 fail_timeout=15s;\n' "$i" "$CONTAINER_PORT"
        done
        printf '        keepalive 64;\n'
        printf '    }\n\n'
        printf '    # SSE-friendly proxy: no buffering, long read timeout, HTTP/1.1 keepalive.\n'
        printf '    server {\n'
        printf '        listen 80;\n'
        printf '        client_max_body_size 25m;\n\n'
        printf '        # LB-level liveness — returns 200 without hitting a replica.\n'
        printf '        location = /lb-health { return 200 "lb ok\\n"; }\n\n'
        printf '        location / {\n'
        printf '            proxy_pass http://scraper_pool;\n'
        printf '            proxy_http_version 1.1;\n'
        printf '            proxy_set_header Host $host;\n'
        printf '            proxy_set_header X-Real-IP $remote_addr;\n'
        printf '            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
        printf '            proxy_set_header X-Forwarded-Proto $scheme;\n'
        printf '            proxy_set_header Connection "";\n\n'
        printf '            # Server-Sent Events (/api/runs/:id/events) must stream live.\n'
        printf '            proxy_buffering off;\n'
        printf '            proxy_cache off;\n'
        printf '            chunked_transfer_encoding on;\n'
        printf '            proxy_read_timeout 3600s;\n'
        printf '            proxy_send_timeout 3600s;\n'
        printf '        }\n'
        printf '    }\n'
        printf '}\n'
    } > "$NGINX_CONF"
    ok "Generated $NGINX_CONF (method=$LB_METHOD, $REPLICAS upstreams)"
}

# ---- generate docker-compose.cluster.yml -----------------------------------
gen_compose() {
    local lb_port; lb_port="$(resolve_lb_port)"
    {
        printf '# AUTO-GENERATED by cluster.sh (REPLICAS=%s) — do not hand-edit.\n' "$REPLICAS"
        printf '# Each scraper-N has an ISOLATED storage dir (Chromium profile); runs/ +\n'
        printf '# ai-cache/ are shared. nginx `lb` fronts them on host port %s.\n\n' "$lb_port"
        printf 'services:\n'

        local i deps=""
        for i in $(seq 1 "$REPLICAS"); do
            printf '  scraper-%s:\n' "$i"
            printf '    image: %s\n' "$IMAGE"
            printf '    build:\n'
            printf '      context: .\n'
            printf '      dockerfile: Dockerfile\n'
            printf '    container_name: %s-scraper-%s\n' "$PROJECT" "$i"
            printf '    expose:\n'
            printf '      - "%s"\n' "$CONTAINER_PORT"
            printf '    environment:\n'
            printf '      - NODE_ENV=${NODE_ENV:-production}\n'
            printf '      - PORT=%s\n' "$CONTAINER_PORT"
            printf '      - STORAGE_DIR=/app/storage\n'
            printf '      - RUNS_DIR=/app/runs\n'
            printf '      - AI_CACHE_DIR=/app/ai-cache\n'
            printf '      - HEADLESS=true\n'
            printf '      - REPLICA_ID=%s\n' "$i"
            printf '    env_file:\n'
            printf '      - .env\n'
            printf '    volumes:\n'
            printf '      - ./cluster/storage-%s:/app/storage\n' "$i"
            printf '      - ./runs:/app/runs\n'
            printf '      - ./ai-cache:/app/ai-cache\n'
            printf '    restart: always\n'
            printf '    stop_grace_period: 30s\n'
            printf '    shm_size: 1gb\n'
            printf '    security_opt:\n'
            printf '      - seccomp:unconfined\n'
            printf '    healthcheck:\n'
            printf '      test: ["CMD", "curl", "-fsS", "http://localhost:%s/api/health"]\n' "$CONTAINER_PORT"
            printf '      interval: 30s\n'
            printf '      timeout: 5s\n'
            printf '      retries: 3\n'
            printf '      start_period: 40s\n'
            printf '    logging:\n'
            printf '      driver: json-file\n'
            printf '      options: { max-size: "20m", max-file: "5" }\n'
            printf '    deploy:\n'
            printf '      resources:\n'
            printf '        limits: { memory: 2048M }\n'
            printf '        reservations: { memory: 512M }\n\n'
            deps="${deps}      scraper-${i}:\n        condition: service_healthy\n"
        done

        # ---- load balancer ----
        printf '  lb:\n'
        printf '    image: nginx:1.27-alpine\n'
        printf '    container_name: %s-lb\n' "$PROJECT"
        printf '    ports:\n'
        printf '      - "%s:80"\n' "$lb_port"
        printf '    volumes:\n'
        printf '      - ./cluster/nginx.conf:/etc/nginx/nginx.conf:ro\n'
        printf '    depends_on:\n'
        printf '%b' "$deps"
        printf '    restart: always\n'
        printf '    healthcheck:\n'
        printf '      test: ["CMD", "wget", "-qO-", "http://localhost/lb-health"]\n'
        printf '      interval: 30s\n'
        printf '      timeout: 5s\n'
        printf '      retries: 3\n'
        printf '    logging:\n'
        printf '      driver: json-file\n'
        printf '      options: { max-size: "20m", max-file: "3" }\n\n'

        printf 'networks:\n'
        printf '  default:\n'
        printf '    name: %s-network\n' "$PROJECT"
    } > "$COMPOSE_FILE"
    ok "Generated $COMPOSE_FILE (LB host port $lb_port → $REPLICAS replicas)"
}

gen_all() {
    validate_replicas
    ensure_env
    ensure_dirs
    gen_nginx_conf
    gen_compose
}

# ---- actions ---------------------------------------------------------------
cmd_up() {
    gen_all
    section "Building image $IMAGE"
    COMPOSE build --pull
    section "Starting cluster: $REPLICAS scraper(s) + nginx LB"
    COMPOSE up -d --remove-orphans
    wait_healthy
    local lb_port; lb_port="$(resolve_lb_port)"
    section "Cluster up"
    ok "Load balancer: http://localhost:${lb_port}  (method=$LB_METHOD, $REPLICAS replicas)"
    log "Logs:    ./cluster.sh logs"
    log "Status:  ./cluster.sh status"
    log "Scale:   ./cluster.sh scale <N>"
    log "Stop:    ./cluster.sh down"
}

wait_healthy() {
    section "Waiting for replicas to report healthy"
    local i cid status tries
    for i in $(seq 1 "$REPLICAS"); do
        cid="$(COMPOSE ps -q "scraper-$i" 2>/dev/null || true)"
        if [ -z "$cid" ]; then warn "scraper-$i not found"; continue; fi
        tries=40
        while [ "$tries" -gt 0 ]; do
            status="$(DOCKER inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo unknown)"
            case "$status" in
                healthy)   ok "scraper-$i healthy"; break ;;
                unhealthy) err "scraper-$i unhealthy"; COMPOSE logs --tail=40 "scraper-$i"; break ;;
                *)         printf '.'; sleep 2 ;;
            esac
            tries=$((tries - 1))
        done
        [ "$tries" -eq 0 ] && warn "scraper-$i not healthy in 80s (still running)"
    done
}

cmd_status() {
    section "Cluster status"
    COMPOSE ps
    section "Per-replica health"
    local i cid
    for i in $(seq 1 "$REPLICAS"); do
        cid="$(COMPOSE ps -q "scraper-$i" 2>/dev/null || true)"
        if [ -n "$cid" ]; then
            printf '  scraper-%s: %s (restarts=%s)\n' "$i" \
                "$(DOCKER inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo unknown)" \
                "$(DOCKER inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo ?)"
        else
            printf '  scraper-%s: absent\n' "$i"
        fi
    done
    section "Load balancer probe"
    local lb_port; lb_port="$(resolve_lb_port)"
    if curl -fsS "http://localhost:${lb_port}/lb-health" >/dev/null 2>&1; then
        ok "GET /lb-health → 200 (port $lb_port)"
    else
        warn "LB not answering on port $lb_port"
    fi
    if curl -fsS "http://localhost:${lb_port}/api/health" >/dev/null 2>&1; then
        ok "GET /api/health → 200 via LB (a replica answered)"
    else
        warn "/api/health not reachable through LB"
    fi
}

cmd_scale() {
    local n="${1:-}"
    if ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$n" -lt 1 ]; then
        err "Usage: ./cluster.sh scale <positive-int>"; exit 1
    fi
    REPLICAS="$n"
    log "Scaling to $REPLICAS replicas (regenerate + up; removes orphaned replicas)"
    cmd_up
}

cmd_down()    { [ -f "$COMPOSE_FILE" ] && COMPOSE down --remove-orphans || warn "No cluster compose file."; }
cmd_restart() { COMPOSE restart; }
cmd_logs()    { COMPOSE logs -f --tail=100 ${1:+"$1"}; }
cmd_ps()      { COMPOSE ps; }

cmd_nuke() {
    warn "down -v + docker system prune. Ctrl+C in 5s to abort."
    sleep 5
    [ -f "$COMPOSE_FILE" ] && COMPOSE down -v --remove-orphans || true
    DOCKER system prune -f
}

# ---- main ------------------------------------------------------------------
action="${1:-bootstrap}"
case "$action" in
    bootstrap|"") cmd_up ;;
    up)           cmd_up ;;
    gen)          gen_all ;;
    down)         cmd_down ;;
    restart)      cmd_restart ;;
    logs)         shift || true; cmd_logs "${1:-}" ;;
    ps)           cmd_ps ;;
    status)       cmd_status ;;
    scale)        shift || true; cmd_scale "${1:-}" ;;
    nuke)         cmd_nuke ;;
    *)            err "Unknown command: $action"; sed -n '3,25p' "$0"; exit 1 ;;
esac
