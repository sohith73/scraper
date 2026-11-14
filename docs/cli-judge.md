# CLI judge — judge JobRight jobs on your subscription, not the paid API

## What this is

The scraper's relevance filter (Phase 10) is the single biggest server-side AI cost.
It makes one `gpt-4o-mini` call per batch of jobs to decide pick / skip / score, and a full run judges up to ~300 jobs.

The CLI judge swaps that paid call for a local coding-agent CLI, `claude -p` (Claude Code) or `codex exec` (Codex), which runs on the box's existing Max / ChatGPT subscription.
Per-job judging then costs about zero in API spend.

It is wired in behind a flag and defaults ON (`JUDGE_BACKEND=claude`).
The paid OpenAI path is always kept as an automatic fallback, so a missing or broken CLI never fails a run.

## What it does and does NOT touch

It routes ONLY the relevance judge (the per-job keep / skip decision in `src/services/relevance/filter.js`).

It does NOT touch:

- The intent summariser (profile to SearchIntent). That stays on OpenAI.
- The dashboard backend's Adzuna API judge (`apiJudge.js`).
- The JobRight browser extension's own judge. That runs in a Chrome service worker and cannot shell out to a CLI at all. See "Not covered yet" below.

So the only thing this changes is how the scraper's server-side JobRight batches get judged.

## Turn it on or off

One env var on the scraper (`.env`, read by `src/config/env.js`):

```
# claude  -> Claude Code CLI  (default)
# codex   -> Codex CLI
# api     -> paid OpenAI only, no CLI (use this to run pure API while evaluating)
JUDGE_BACKEND=claude
```

To stay on the pure paid path during the evaluation period, set `JUDGE_BACKEND=api` and nothing else changes.

### Requirement: the CLI must be installed AND logged in on the box that runs the scraper

`claude -p` / `codex exec` only work where that CLI is authenticated.
Your dev box is logged in.
A production / Contabo box is probably NOT, unless you ran `claude` (or `codex`) there and signed in once.

If the CLI is missing or unauthenticated, every judge call simply falls back to the API (see Fallback).
It will not crash, it just will not save you anything until the CLI is set up there.

## All the knobs

| Env var | Default | What it does |
|---|---|---|
| `JUDGE_BACKEND` | `claude` | `claude` / `codex` / `api`. Picks the primary judge. |
| `JUDGE_CLI_MODEL` | `` (CLI default) | Model id handed to the CLI, e.g. `claude-haiku-5-5`. Empty lets the CLI pick. |
| `JUDGE_CLI_EXTRA_ARGS` | `` | Extra CLI flags, space-separated, appended verbatim. e.g. `--allowedTools ` to forbid tool use. |
| `JUDGE_CLI_TIMEOUT_MS` | `60000` | Per-batch wall-clock budget. On timeout the batch falls back to the API. |
| `JUDGE_CLI_CONCURRENCY` | `2` | Max CLI processes at once. The pipeline fans batches out in parallel; keep this low, CLI judging is heavy. |
| `JUDGE_CLI_MAX_CALLS` | `0` | Per-process CLI call budget. `0` = unlimited. A ceiling to protect your weekly usage pool on a heavy day; calls past it use the API. |
| `JUDGE_CLI_MAX_FAILURES` | `3` | Consecutive CLI failures before the CLI is disabled for the rest of the process and everything uses the API. |

## Fallback — why correctness is never at risk

The flag only chooses the PRIMARY judge.
Any of these failures hands that exact batch to the paid OpenAI client instead, with the same prompt and schema:

- CLI binary missing (`ENOENT`) or unauthenticated.
- Non-zero exit.
- Timeout.
- Output that is not JSON, or JSON that fails the decision schema.
- CLI call budget (`JUDGE_CLI_MAX_CALLS`) exhausted.

Two guard rails keep a broken box from being slow:

- A missing binary disables the CLI immediately for the whole process.
- `JUDGE_CLI_MAX_FAILURES` consecutive failures disables it too.

After either, every batch goes straight to the API with no wasted spawn.
A single success resets the failure counter.

CLI results are cached on disk under their own namespace (`cli:<backend>`), so an identical batch replays at zero cost and never collides with a cached OpenAI decision.

## Confirm it is actually running

On boot the scraper logs:

```
relevance judge: CLI backend active (API fallback armed)   backend=claude
```

Per run, the per-run log (`runs/<id>/run.log`) will show `cli-judge:` warnings whenever a batch falls back, and the run's cost ledger will read near zero for the batches the CLI judged (CLI spend is plan-billed, so it reports 0 tokens).

If you see every batch falling back, the CLI is not installed or not logged in on that box.

## Cost and speed tradeoff

- Cost: API spend on JobRight judging drops to about zero. You spend subscription usage instead of dollars.
- Speed: the CLI is slower per batch than the API. Measured on this box: `claude -p` judged a 3-job batch in about 6.6s, versus roughly 1 to 2s for an OpenAI batch. With `JUDGE_CLI_CONCURRENCY=2`, a 300-job run adds a few minutes of judging time.
- Usage pool: CLI judging draws from the SAME weekly Max / ChatGPT allowance you code with. A heavy autopilot day can eat into it. Use `JUDGE_CLI_MAX_CALLS` to cap it, or `JUDGE_BACKEND=api` on days you need the allowance for coding.

## Not covered yet (phase 2)

The JobRight browser lane (the autopilot driving the Chrome extension) judges inside a Chrome service worker, which cannot run a CLI.
Giving that path a CLI judge needs a small backend endpoint that shells out to the CLI, which the extension would POST to in place of its direct OpenAI call, plus an extension rebuild and ship.
That is deliberately left out of this first cut.
This cut covers the server-side scraper lane, which is where the big batches and the real cost are.

## Files

- `src/ai/cliJudgeClient.js` — the CLI judge client (same `completeJson` contract as the OpenAI client, with fallback, latch, concurrency cap, budget, cache).
- `src/container.js` — builds `judgeAi` (CLI primary + OpenAI fallback) when `JUDGE_BACKEND` is a CLI, else plain `ai`.
- `src/services/runner/pipeline.js` — the relevance filter uses `judgeAi`; everything else still uses `ai`.
- `src/config/env.js` — the `JUDGE_*` env vars above.
- `tests/unit/ai-cli-judge-client.test.js` — fallback, latch, budget, cache, parsing.
