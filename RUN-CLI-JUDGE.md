# Run the scraper with the CLI judge

This source bundle contains the Flashfire JobRight scraper and its optional CLI relevance judge. Node.js 22 LTS is recommended. Dashboard and resume services must be reachable; they are separate services and are not included.

## Install and configure

Extract the ZIP, open a terminal in its `scraper-cli-judge` folder, then run:

```bash
npm ci --include=dev
npx playwright install --with-deps chromium
cp .env.example .env
```

Edit `.env` and set `OPENAI_API_KEY`, `JOBRIGHT_EMAIL`, `JOBRIGHT_PASSWORD`, `DASHBOARD_BASE`, and `RESUME_BASE` for your environment. Quote values containing `#`. Keep the OpenAI key configured: intent summarization still uses it, and it supplies the judge fallback. MongoDB and Discord settings are optional; see `.env.example`.

## Choose the judge

Set one of these values in `.env`:

```dotenv
JUDGE_BACKEND=claude
# Alternatives: codex, api
JUDGE_CLI_TIMEOUT_MS=60000
JUDGE_CLI_CONCURRENCY=2
JUDGE_CLI_MAX_CALLS=0
JUDGE_CLI_MAX_FAILURES=3
```

`claude` is the default. Install and authenticate the selected CLI on the machine running the scraper, under the same OS user that starts it. Verify that `claude --version` or `codex --version` works and complete that CLI's interactive sign-in before starting the service. Existing subscription access and usage limits determine whether calls succeed; CLI judging consumes that account's allowance. Authentication or subscription failures use the OpenAI fallback.

`api` disables the CLI path. Missing binaries, timeouts, nonzero exits, or invalid judge JSON also trigger the paid OpenAI fallback. A missing binary disables CLI attempts immediately; repeated failures disable them until the scraper restarts. Fallback requires a valid OpenAI key and available API service.

## Start and check

```bash
npm start
```

In another terminal:

```bash
curl -fsS http://localhost:8092/api/health
curl -X POST http://localhost:8092/api/admin/login
curl -fsS http://localhost:8092/api/admin/session-status
```

Open http://localhost:8092/ to select a client and start a run. Or start a run directly (replace the email with a real dashboard client):

```bash
curl -X POST http://localhost:8092/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"clientEmail":"client@example.com","count":10}'
```

Runs can push real jobs into the configured dashboard. Set `DRY_RUN=true` in `.env` before starting the service to log push payloads instead during an initial check.

The startup log reports `relevance judge: CLI backend active (API fallback armed)` when a CLI backend is selected. This means the path is configured, not that authentication has been verified. Look for `cli-judge: falling back to API` warnings in logs to detect fallback. Restart after changing `.env`. Stop a terminal-run service with Ctrl+C.

## Docker and production

The supplied Docker image does not install Claude Code or Codex and does not contain your CLI authentication. A CLI installed on the host is not automatically available inside a container. With the stock image, set `JUDGE_BACKEND=api`, or separately provision the chosen CLI and authentication for the container's `pwuser` before expecting CLI judging. Do not put account credentials in source or the ZIP.

See `DEPLOY.prod.md` for the production deployment layout and `docs/cli-judge.md` for judge settings. Keep API access restricted to trusted callers as described in the deployment docs.

## Verification and bundle contents

```bash
npm test
```

The bundle includes source, public assets, tests, locked dependencies, deployment scripts, `.env.example`, and this guide. It excludes `.env`, dependencies, Git metadata, browser sessions, run artifacts, caches, and local diagnostic files. Install dependencies on the target machine; existing authenticated browser profiles are not shipped.
