# FlashFire scraper — production cluster (77.237.239.34, 8 GB / 4-core)

Deployed with `docker-compose.prod.yml` + `cluster/nginx.prod.conf`.
Repo lives at `/opt/flashfire-scraper` on the box.

## Topology

```
                     ┌─────────────────────────────┐
 dashboard / clients │  nginx lb  (127.0.0.1:8092)  │
      ──────────────▶│  path-split load balancing   │
                     └───────┬──────────────┬────────┘
        least_conn (stateless│   ip_hash (stateful runs/SSE)
        /extract, /fetch-jd) │              │
                     ┌────────▼───┐   ┌──────▼─────┐
                     │ scraper-1  │   │ scraper-2  │   each: JDFETCH_MAX_CONCURRENT=3
                     │  (healthy) │   │ (healthy)  │         nav timeout 35s, mem 2.5G, shm 512M
                     └────────────┘   └────────────┘
                     ┌──────────────────────────────┐
                     │ autoheal  — restarts any      │
                     │ container that goes unhealthy │
                     └──────────────────────────────┘
```

- **2 replicas** → 6 concurrent scrapes box-wide, redundancy + failover.
- **`restart: always`** on every container (crash + host reboot recovery; docker enabled on boot).
- **autoheal** restarts a container that is alive-but-unhealthy (hang) — the case `restart: always` misses.
- **LB bound to `127.0.0.1:8092`** — the scraper API is UNAUTHENTICATED, so it is NOT internet-exposed. See Cutover.

## Main port

**8092** (nginx LB → replicas' internal 8092). Currently localhost-only on the box.

## Everyday ops (run in /opt/flashfire-scraper)

```bash
# status
docker compose -f docker-compose.prod.yml ps

# live logs (all, or one replica)
docker compose -f docker-compose.prod.yml logs -f
docker logs -f flashfire-prod-scraper-1

# memory / cpu per container
docker stats --no-stream

# health
curl -fsS http://127.0.0.1:8092/lb-health          # LB itself
curl -fsS http://127.0.0.1:8092/api/health          # app (via LB → a replica)

# test a real scrape end-to-end (URL-encode the target)
curl "http://127.0.0.1:8092/extract/infor=https%3A%2F%2Fjobs.lever.co%2F..."

# restart / rebuild / stop
docker compose -f docker-compose.prod.yml restart
docker compose -f docker-compose.prod.yml up -d --build   # after code changes
docker compose -f docker-compose.prod.yml down            # stop the whole stack
```

## Observability / "what is happening"

- `GET /api/health` — per-app liveness + mongo connection + uptime (through the LB, hits a replica).
- `GET /lb-health` — LB liveness without touching a replica.
- `GET /api/runs` + `GET /api/runs/:id/events` (SSE) — JR pipeline run state / live log stream.
- `docker compose logs -f` — structured JSON app logs (NODE_ENV=production).
- `docker stats` — live memory/cpu; watch replicas stay well under the 2.5 GB cap.

## Tuning knobs (in `docker-compose.prod.yml`, per replica)

| Var | Value | Effect |
|---|---|---|
| `JDFETCH_MAX_CONCURRENT` | 3 | Chromium scrape pages per replica (×2 = 6 box-wide). Raise if CPU/RAM allow. |
| `JDFETCH_NAV_TIMEOUT_MS` | 35000 | page.goto timeout — higher lets slow ATS (Workday/iCIMS) finish. |
| `mem_limit` / `shm_size` | 2560m / 512m | Per-replica caps. |

To add a 3rd replica: copy a `scraper-N` service block, add `./cluster/storage-N`
(chown 1000:1000), add it to both upstreams in `cluster/nginx.prod.conf`.

## Cutover (make it live — NOT done yet)

Currently deployed ALONGSIDE the old scraper (34.100.143.80); the dashboard still
uses the old box. To switch production here:

1. Expose the port to the dashboard only (API is unauthenticated — do NOT open 0.0.0.0):
   - In `docker-compose.prod.yml`, change the `lb` port to `"8092:80"`.
   - `docker compose -f docker-compose.prod.yml up -d lb`
   - Firewall 8092 to the dashboard's egress IP only:
     `ufw allow from <DASHBOARD_IP> to any port 8092 proto tcp` (and deny others).
2. Point the dashboard backend at it: set `SCRAPER_BASE_URL=http://77.237.239.34:8092`
   in the dashboard's env, redeploy the dashboard backend.
3. Verify second-stage screening: the "couldn't open" rate should drop (6 slots + 35s nav).
4. Roll back = revert `SCRAPER_BASE_URL` to the old box; no data migration.
