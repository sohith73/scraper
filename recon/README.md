# Recon tool — Phase 0

Headed Playwright capture for discovering JobRight.ai's real endpoints.

## Prerequisites

```bash
cd "DASH/scraper"
npm install                # installs playwright as a devDep
npx playwright install chromium
```

## Run

```bash
npm run recon
# or with flags:
node recon/jobright-recon.mjs --url=https://jobright.ai/jobs/recommend
```

A Chromium window opens. A persistent profile lives in `recon/storage/` so the next run reuses your login.

### What to do in the browser

1. **Log in** (first run only).
2. Navigate to **/jobs/recommend**.
3. **Apply a filter** (e.g. switch Location, Role, Seniority, Date Posted). Toggle 2–3 different filters.
4. **Scroll** the list 3–4 pages so infinite-scroll triggers more page loads.
5. **Click** one or two job cards to open the detail panel.
6. **Ctrl-C** in the terminal.

### Output

Under `recon/samples/`:

- `index.jsonl` — one line per captured response (method, url, status, bytes, sample filename, redacted request headers).
- `<seq>-<METHOD>-<slug>.json` — raw JSON bodies (truncated at 512 KB by default).
- `summary.md` — endpoints ranked by hit count, written on Ctrl-C.

### Safety

- `Cookie`, `Set-Cookie`, and `Authorization` headers are stripped from `index.jsonl`.
- The persistent profile under `recon/storage/` is gitignored — contains your JobRight session.
- `recon/samples/` is gitignored (except `.gitkeep`) — payloads may contain PII.

## Next step

Open `docs/reconnaissance.md` and fill in the endpoint map based on `summary.md` + individual sample files. That document becomes the spec the Phase 9 search runner is built against.
