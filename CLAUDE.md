# Scraper — architecture map + extension guide

Orientation doc for future engineers + LLM assistants touching this repo.
If you're looking for operator-facing docs, start at `README.md`. If you
want phase-by-phase historical context, read
`/home/bsc/.claude/plans/hi-we-want-binary-storm.md`.

## Core idea

A Flashfire operator picks one client, enters `N`, clicks `Scrape`. The
pipeline below runs end-to-end and deposits (up to) `N` relevant jobs into
the client's dashboard tracker:

```
client pick
    │
    ▼
profile + exclusions + resume    (dashboard + gemini-resume)
    │
    ▼
SearchIntent                     (gpt-4o-mini, JSON schema strict)
    │
    ▼
JR filter update + list fetch    (Playwright, persistent context)
    │
    ▼
AI relevance filter              (gpt-4o-mini, batched 20/call)
    │
    ▼
Completeness gate                (validate title / company / apply / desc)
    │
    ▼
Preflight                        (dashboard exclusions + local dedupe)
    │
    ▼
POST /addjob                     (bounded concurrency 2)
```

Every phase produces a typed `Result<T, E>`. A shared state machine moves
the run through phases and emits SSE updates to the UI.

## Service graph

```
src/container.js
      │
      ├─ env              (src/config/env.js           — zod-validated config)
      ├─ logger           (src/config/logger.js        — pino, pretty/JSON)
      ├─ dashboard.*      (src/clients/dashboard/*     — list/getProfile/getExclusions/pushJob)
      ├─ resume.getByEmail(src/clients/resume/*        — gemini-resume)
      ├─ ai               (src/ai/openaiClient.js      — gpt-4o-mini + disk cache)
      ├─ summariser       (src/services/intent/*       — profile → SearchIntent)
      ├─ browser          (src/playwright/browser.js   — persistent-context singleton)
      ├─ mutex            (src/playwright/mutex.js     — FIFO promise chain)
      ├─ session          (src/playwright/session.js   — probe + ensureLoggedIn)
      └─ runs             (src/services/runner/*       — orchestrator + store + SSE)
```

Routes (`src/routes/*.js`) accept the container as a prop and delegate to
services. Every service function takes dependencies via injection so tests
can provide fakes with zero SDK / network coupling.

## Folder map

```
src/
  config/
    env.js                   zod schema; path-aware errors via ctx.addIssue
    logger.js                pino (pretty in dev, NDJSON in prod; redacts secrets)
  middleware/
    requestId.js             echo X-Request-Id, else random UUID
    errorHandler.js          404 + central error JSON
  routes/
    health.js                GET /api/health
    clients.js               GET /api/clients* + CODE_TO_STATUS policy map
    admin.js                 session-status + login + first-login
    runs.js                  runs REST + SSE + log + artifacts + cooldown
  clients/
    common/
      httpClient.js          generic fetch wrapper (retry, timeout, service token)
      result.js              Result<T,E> helpers
    dashboard/               listClients, getProfile, getExclusions, pushJob
    resume/                  getResumeByEmail
  ai/
    openaiClient.js          SDK wrapper; retry + classification + optional cache
    cache.js                 disk cache, atomic tmp-then-rename, corrupt-file auto-evict
    keyHash.js               sha256(model + schemaName + system + user) w/ \x1f separator
  services/
    intent/                  Phase 5 — AiIntent zod + JSON schema + summarizer
    search/                  Phase 9 — filterMapper + runSearch
    relevance/               Phase 10 — batched pick/score/reason filter
    detail/                  Phase 11 — completeness gate
    push/                    Phase 12 — preflight + bounded-concurrency push runner
    runner/                  Phase 13/15/16 — state, store, pipeline, runs, logger, cooldown
  playwright/
    browser.js               launchPersistentContext singleton, mode recycle
    mutex.js                 zero-dep FIFO mutex
    session.js               JR probe + form-login w/ API response observer
    intercept.js             page.on('response') capture + waitFor + buffered
    pageFetch.js             page.evaluate(fetch) helper for same-origin calls
  adapters/
    jobright.js              JR JSON → canonical Job + toDashboardJob
  server.js                  buildApp({container}) + graceful shutdown
  container.js               service graph factory (overrides for tests)
```

## Canonical data types

**SearchIntent** (`src/services/intent/schema.js`):
```ts
{
  roles: string[];
  locations: string[];
  seniority: 'intern' | 'entry' | 'mid' | 'senior' | 'lead' | 'exec';
  companies: string[];
  workAuth: string;
  narrative: string;
  futurePreferences: string;
  exclusions: { companies: string[]; locations: string[] };
}
```

**Job** (`src/adapters/jobright.js`):
```ts
{
  id: string;           // JR jobId — stable dedup key
  impId: string;
  title: string;
  companyName: string;
  jobLocation: string;
  workModel: 'Remote' | 'Onsite' | 'Hybrid' | '';
  isRemote: boolean;
  employmentType: string;
  seniority: string;
  minYearsOfExperience: number;
  publishedAt: string;
  publishedAtRelative: string;
  applicantsCount: number;
  applyUrl: string;                    // → dashboard.joblink
  description: string;                 // composed — → dashboard.jobDescription
  requirements: { must: string[]; preferred: string[] };
  tags: string[];
  flags: { h1bSponsor, citizenOnly, clearanceRequired, workAuthRequired };
  score: { raw: number; label: string };
  company: { name, size, description, categories, linkedinUrl, ... };
  raw: any;                            // original JR payload — debug only
}
```

**Run state** (`src/services/runner/state.js`):
```
phase ∈ {queued, loading-profile, loading-exclusions, loading-resume,
         summarising, searching, filtering, enriching, preflight, pushing,
         done | failed | aborted}
```

## Error codes → HTTP status

Single source of truth: `src/routes/clients.js → CODE_TO_STATUS`.

| Code | Status | Source |
|---|---|---|
| BAD_INPUT | 400 | every service's validation |
| AUTH | 401 | OpenAI 401 / NEEDS_REAUTH |
| NEEDS_REAUTH | 401 | runSearch session probe fails |
| BLOCKED_COMPANY / BLOCKED_LOCATION / CLIENT_LOCKED | 403 | dashboard /addjob |
| NOT_FOUND | 404 | dashboard getProfile / unknown runId |
| DUPLICATE | 409 | dashboard dedupe (also surfaces as ok:outcome=duplicate) |
| RATE_LIMITED / COOLDOWN | 429 | OpenAI 429 / JR 429 / active cooldown file |
| INTERNAL / UNEXPECTED | 500 | unclassified exceptions |
| NETWORK / SERVER_ERROR / BAD_SHAPE / BAD_JSON / BAD_STATUS | 502 | upstream failures |
| NO_OPENAI_KEY | 503 | env OPENAI_API_KEY empty |
| TIMEOUT | 504 | OpenAI / dashboard / JR timeout |

## Integration contracts

### Dashboard push (verified live)

Endpoint: `POST http://localhost:8086/addjob`

```js
{
  jobDetails: {
    userID: <client email — lowercased>,
    jobTitle: <≤50 chars>,
    companyName: ...,
    jobLocation: ...,
    jobDescription: ...,   // composed from JR list payload
    joblink: <apply URL>
  },
  userDetails: { email: <client email>, name: <client name> },
  role: 'operations',
  operationsEmail: 'scraper@flashfirehq',
  operationsName: 'JobRightScraper'
}
```

No patch to the dashboard backend is required. Duplicate detection +
exclusion enforcement happen server-side via `CheckForDuplicateJobs` and
`exclusionGuard`.

### JR endpoints (discovered in Phase 0 — `docs/reconnaissance.md`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/swan/recommend/list/jobs?position=0&count=N` | Fully hydrated job list (no detail endpoint needed) |
| POST | `/swan/filter/get/filter` | Fetch current server-side filter |
| POST | `/swan/filter/update/filter` | Push new filter |
| GET | `/swan/auth/newinfo` | Session probe (check `result.logined === true`) |
| POST | `/swan/auth/login/pwd` | Form submit — JR hashes password client-side |

## Gotchas — read these before editing the relevant area

1. **Node `--env-file` truncates at `#`.** `.env` values with literal `#`
   MUST be quoted: `JOBRIGHT_PASSWORD="Ls..U33Ey#2qhDU"`. Unquoted values
   silently become `Ls..U33Ey`. Documented in `.env.example`.

2. **`/swan/auth/newinfo` returns a populated object for anonymous sessions
   too** (all fields null / `logined:false`). Never use `result !== null`
   as the login signal. Correct:
   `result.logined === true || result.userId?.length > 0`.

3. **JR hashes passwords client-side** before POSTing `/swan/auth/login/pwd`.
   Posting raw passwords direct to the API returns `errorCode: 20004`. The
   form-driven login in `session.js` is the only path — don't bypass.

4. **Node 22's `node --test` with a directory path errors.** Use the
   `"tests/unit/**/*.test.js"` glob from `package.json`'s `test` script.

5. **Probe page must navigate before `fetch()`ing.** A fresh page starts on
   `about:blank`; same-origin fetches to `jobright.ai` get blocked. See
   `probeViaPage` in `session.js` — navigates first if URL is `about:*`.

6. **`.finally` on a rejecting promise creates unhandled rejection.** Chain
   `.finally` off `tail.catch(()=>{})`, never off a raw rejecting promise.
   See `src/playwright/mutex.js` for the pattern.

7. **Spread-then-method loses state.** Playwright fakes in tests should
   return plain objects with real methods, not spread a factory output.

8. **`timer.unref()` causes Node's test runner to exit early** when the
   test itself is the only thing awaiting. Don't unref in code under test.
   See `src/playwright/intercept.js`'s `waitFor` — NO unref.

9. **Playwright persistent context is singleton per userDataDir.** Two
   Chromium processes on the same dir corrupt it. `browser.js` recycles the
   context when mode (headless ↔ headed) changes.

10. **`runsService.start` is synchronous.** Don't make it async —
    route handlers call it sync and destructure `.id` immediately. The
    pipeline itself is fire-and-forget.

## Extending — common patterns

### Add a new error code

1. `src/clients/common/result.js` — no change (codes are free-form strings).
2. `src/routes/clients.js → CODE_TO_STATUS` — add the HTTP mapping.
3. The service raising it: `return err('NEW_CODE', message, extras)`.
4. Add a test asserting the HTTP status for that code.

### Add a new pipeline phase

1. `src/services/runner/state.js → PHASES` — add the enum member.
2. `public/app.js → PHASE_SEQUENCE` — add label (keeps timeline in order).
3. `src/services/runner/pipeline.js` — insert the call via `phaseTimer(name, fn)`.
4. `src/services/runner/pipeline.js` — check abort after, fail-run on err.
5. Add a progress sub-line in `public/app.js → phaseSubline()` if useful.

### Add a new backend integration

1. New module under `src/clients/<target>/` with `httpClient` reuse.
2. Export typed `Result<T, E>` from every function.
3. Wire into `src/container.js` with a stub-friendly surface.
4. Tests: inject a fake `http` with `{get, postJson, putJson}` shape.

### Add a new UI element

No build step. `public/app.js` is vanilla ES modules loaded directly by
the browser. Add HTML in `public/index.html`, styles in `public/styles.css`,
behaviour in `public/app.js`. Re-run `npm run dev`; refresh browser.

## What's NOT here (and deferred)

- **Playwright stealth plugin** — login + search work against real JR
  account without it; adding `playwright-extra` is speculative complexity.
  Revisit if JR starts blocking us.
- **Resume-from-failed** (`POST /api/runs/:id/resume`) — needs a "deferred
  picks" bucket in the pipeline. Not urgent; operators can just re-run.
- **HAR recording** — same structural constraint as trace.zip but more
  intrusive. Trace covers our current debugging needs.
- **Per-pick override toggle in UI** — no-op today; the push path doesn't
  have a "defer" bucket.
- **Multi-account JR rotation** — one shared account is sufficient for the
  current load. Horizontal scale would need a BullMQ + Redis rework.

## Conventions

- JS-ESM everywhere; no TypeScript (matches the dashboard backend).
- Node 20+ required; tests are `node --test` native.
- Functions opened with a one-paragraph header: what / why / input / output.
- `Result<T, E>` at every cross-module boundary — throws are reserved for
  programmer errors (missing constructor args, invariant violations).
- Integration testing done via re-runnable smoke scripts in `scripts/`, not
  in the unit suite. Unit tests never hit the network.
