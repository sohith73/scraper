#  Scraper

Internal tool that scrapes jobs from **jobright.ai** against a Flashfire
client's onboarding profile and pushes matched jobs into the dashboard
backend. Vanilla HTML UI, Express API, Playwright for JR, gpt-4o-mini for
intent + relevance.

- Operator picks a client, sets N, clicks **Scrape**.
- Pipeline: profile → AI intent → JR search → AI relevance filter →
  preflight → `POST /addjob` into the client's tracker.
- All state + artifacts persisted under `runs/<runId>/`.

## Status — all phases complete

| Phase | Scope | Status |
|---|---|---|
| 0 | JR endpoint reconnaissance (no scroll / detail endpoint needed) | done |
| 1 | Scaffold (Express, zod env, pino, health, graceful shutdown) | done |
| 2 | Dashboard client (listClients / getProfile / getExclusions / pushJob) | done |
| 3 | Resume client (getResumeByEmail) | done |
| 4 | OpenAI client (gpt-4o-mini, json_schema strict, disk cache) | done |
| 5 | Profile summarizer → SearchIntent | done |
| 6 | Vanilla UI shell + `/api/clients/*` | done |
| 7 | Playwright session (persistent context + programmatic login + probe) | done |
| 8 | Generic API interceptor (`page.on('response')` w/ matchers) | done |
| 9 | Search runner (SearchIntent → JR filter → list → canonical Job[]) | done |
| 10 | AI relevance filter (batched gpt-4o-mini pick/score/reason) | done |
| 11 | Completeness gate (ready vs sparse partition) | done |
| 12 | Dashboard push (preflight + concurrent push + classification) | done |
| 13 | Run orchestrator + SSE (`POST /api/runs`, persistent state) | done |
| 14 | Run UI (live phase timeline, picks table, abort) | done |
| 15 | Observability (per-run JSON log, error/summary artifacts) | done |
| 16 | Hardening (429/403 cooldown guard + trace.zip on search failure) | done |
| 17 | Docs + memory (README, CLAUDE.md, backend-changes.md, memory refresh) | done |

**351 unit tests pass. Full pipeline live-verified against real dashboard + real JR + real OpenAI.**

## Quickstart

```bash
cd "DASH/scraper"
cp .env.example .env        # populate OPENAI_API_KEY + JR creds
npm install
npx playwright install chromium    # one-time browser download
npm run dev                 # boots on http://localhost:8092
```

Then:

```bash
# 1. Log in to JR once (session persists in storage/)
curl -X POST http://localhost:8092/api/admin/login

# 2. Check session
curl http://localhost:8092/api/admin/session-status

# 3. Open the UI
open http://localhost:8092/
```

## First-login alternatives

The scraper attempts programmatic login using `JOBRIGHT_EMAIL` /
`JOBRIGHT_PASSWORD` from `.env`. If JR starts challenging us (CAPTCHA /
bot-wall), fall back to the headed browser:

```bash
curl -X POST http://localhost:8092/api/admin/first-login
```

This opens a visible Chromium window; an operator completes login manually.
The persistent profile under `storage/` captures cookies + localStorage so
future runs reuse the session silently.

## Environment (`.env`)

Required for full functionality:

| Key | Purpose |
|---|---|
| `OPENAI_API_KEY` | AI intent + relevance filter |
| `JOBRIGHT_EMAIL` | Programmatic login |
| `JOBRIGHT_PASSWORD` | **Must quote if it contains `#`** — Node `--env-file` treats `#` as comment |

Optional / defaulted (see `.env.example` for full list):

| Key | Default | Purpose |
|---|---|---|
| `PORT` | 8092 | HTTP listen port |
| `NODE_ENV` | development | dev/production/test |
| `LOG_LEVEL` | info | pino level |
| `HEADLESS` | true | Chromium mode |
| `STEALTH` | 0 | Playwright stealth plugin (deferred; placeholder) |
| `DEBUG_CAPTURE` | 0 | When 1, runs save Playwright trace.zip on failure |
| `DRY_RUN` | 0 | When 1, `pushJob` logs payloads instead of POSTing |
| `DASHBOARD_BASE` | http://localhost:8086 | Flashfire dashboard backend |
| `RESUME_BASE` | http://localhost:8001 | gemini-resume backend |
| `JOBRIGHT_BASE` | https://jobright.ai | JR origin |
| `JOBRIGHT_COOLDOWN_MS` | 900000 | 15 min cooldown after 429/403 |
| `STORAGE_DIR` | ./storage | Playwright persistent profile |
| `RUNS_DIR` | ./runs | Per-run artifacts |
| `AI_CACHE_DIR` | ./ai-cache | OpenAI prompt cache |
| `OPENAI_MODEL` | gpt-4o-mini | Change at your wallet's peril |

## HTTP API

### Read

- `GET  /api/health` — liveness + version
- `GET  /api/clients` — every client the dashboard knows
- `GET  /api/clients/:email/profile` — profile + exclusions
- `GET  /api/admin/session-status` — JR session probe
- `GET  /api/runs` — list all runs (summary view)
- `GET  /api/runs/:id` — one run (full)
- `GET  /api/runs/:id/events` — **SSE** stream of state transitions
- `GET  /api/runs/:id/log?lines=N` — NDJSON run log tail
- `GET  /api/runs/:id/artifacts` — per-run file listing
- `GET  /api/runs/cooldown` — active cooldown record + human message

### Write

- `POST /api/clients/:email/summary` — build AI SearchIntent
- `POST /api/admin/login` — programmatic JR login
- `POST /api/admin/first-login` — headed JR login (operator completes manually)
- `POST /api/runs` — start a pipeline run (body: `{clientEmail, count, clientName?, overrideIntent?}`)
- `POST /api/runs/:id/abort` — cooperative cancel at the next phase boundary

### Response shape

Uniform envelope on every route:
```json
{ "success": true | false, "requestId": "...", "...domain-specific fields": ... }
```
On error:
```json
{ "success": false, "error": "CODE", "message": "...", "requestId": "..." }
```
`CODE` → HTTP status mapping lives in `src/routes/clients.js → CODE_TO_STATUS`.

## UI (http://localhost:8092/)

Three-pane layout:
- **Left** — client list + search
- **Middle** — selected client's preferences + exclusions + raw profile
  - `Build Summary` → AI SearchIntent (renders in right pane)
  - `Scrape N` → starts a full pipeline run
- **Right** — live Run Console
  - Animated phase timeline with per-phase sub-metrics (intent summary, jobs found, picks/skips, push results)
  - Error banner on failure
  - Picks table with apply links when done
  - Abort button during a run

## Runs directory layout

```
runs/
  <runId>/
    state.json     — current run state (refreshed on every phase transition)
    run.log        — NDJSON, one line per log call, every line tagged {runId}
    picks.json     — canonical picks + blocked + errored + search intent (on DONE)
    summary.json   — compact end-of-run summary (on DONE)
    error.json     — full state snapshot (on FAILED only)
    trace.zip      — Playwright trace (only if DEBUG_CAPTURE=1 and search failed)
  .cooldown.json   — present while JR-throttle cooldown is active
```

`chmod 0700` best-effort on each run dir — `trace.zip` and HAR can contain cookies.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `POST /api/admin/login` returns LOGIN_ERROR `Email or password is wrong` | `.env` password contains `#` and isn't quoted | Wrap value in quotes: `JOBRIGHT_PASSWORD="abc#def"` |
| `POST /api/admin/login` returns LOGIN_ERROR but JR dashboard shows login works in a normal browser | Bot detection on headless Chromium | Use headed flow: `POST /api/admin/first-login` |
| `POST /api/runs` returns 429 `COOLDOWN` | JR recently returned 429/403 to us | Wait for `until` timestamp or delete `runs/.cooldown.json` manually |
| Run fails at `summarising` with `BAD_SHAPE` | Client's profile has irregular fields (e.g. roles stored as one CSV string, not array) | Build a summary via UI first (same failure) OR pass `overrideIntent` in `POST /api/runs` body |
| Run fails at `searching` with `NEEDS_REAUTH` | JR session expired | Re-run `POST /api/admin/login` |
| JR returns `errorCode: 20004 "Email or password is wrong"` from the API | Same quoting issue as login row | See first row |
| `npm test` reports "Cannot find module tests/unit" | `node --test` needs a glob, not a dir | Use the provided `npm test` script (it handles the glob) |
| Server 404s on every API route | Another process holds port 8092 | `lsof -ti:8092 \| xargs kill`, then retry |
| Pipeline hangs at `loading-profile` | Dashboard backend is down on :8086 | Start `DASH/flashfire-dashboard-backend-main` |
| `intent`/`picks` cache never misses | Prompt hasn't changed; working as intended | `rm -rf ai-cache/` to force a full re-spend |

## Smoke scripts

Each phase has a re-runnable live check under `scripts/`:

```bash
node --env-file=.env scripts/smoke-phase5.mjs    # profile → AI intent, cache round-trip
node --env-file=.env scripts/smoke-phase9.mjs    # JR session → search → canonical Job[]
node --env-file=.env scripts/smoke-phase10.mjs   # full intent → search → AI relevance
node --env-file=.env scripts/smoke-phase12.mjs   # full pipeline + push to dashboard
```

Scripts print each step + elapsed time + outcome.

## Ports (full system)

| Service | Port |
|---|---|
| Dashboard backend | 8086 |
| Dashboard frontend | 3000 |
| Gemini-resume backend | 8001 |
| **Scraper (this)** | **8092** |

## Design docs

- **Architecture map + extension guide**: `CLAUDE.md`
- **Phase plan (history + rationale)**: `/home/bsc/.claude/plans/hi-we-want-binary-storm.md`
- **Dashboard-side optional patch**: `docs/backend-changes.md`
- **JR endpoint reconnaissance**: `docs/reconnaissance.md`
- **Recon tool instructions**: `recon/README.md`

## Tests

```bash
npm test           # 351 unit tests; ~3s
npm run test:watch # re-run on change
```

Uses Node's built-in test runner. Every IO boundary is injected so tests
never hit Playwright / OpenAI / the dashboard.
