// CLI-backed judge client — a drop-in for the OpenAI `completeJson` seam that
// runs the relevance decision through a local coding-agent CLI (Claude Code
// `claude -p`, or `codex exec`) instead of the paid OpenAI/Gemini API.
//
// Why : the CLI runs on the operator's existing Max / ChatGPT subscription,
//       so per-job judging costs ~$0 in API spend. The scraper's relevance
//       filter is the single biggest server-side API consumer (up to ~300
//       jobs/run), so routing just that call through the CLI is where the
//       saving lives.
//
// Contract: exposes the EXACT shape the relevance filter consumes —
//   completeJson({ system, user, schema?, schemaName?, zodSchema? })
//     -> Result<{ value, cacheHit, key, usage, backend }>
// so `filterJobsByRelevance` and `src/ai/openaiClient.js` stay untouched.
//
// Safety rails (all configurable via env, see src/config/env.js):
//   - FALLBACK: any CLI failure (missing binary, non-zero exit, timeout,
//     non-JSON output, schema mismatch) delegates to the injected OpenAI
//     client. The paid path is always the safety net — a bad CLI never
//     fails a run, it just costs a normal API call.
//   - LATCH: after N consecutive CLI failures (default 3) the CLI is
//     disabled for the rest of the process and every call goes straight to
//     the fallback. Stops a misconfigured / unauthenticated box from
//     slow-failing every single batch for hours.
//   - CONCURRENCY: a semaphore caps simultaneous CLI processes (default 2).
//     CLI judging is heavy; the pipeline fans out batches in parallel and we
//     don't want 80 `claude` processes at once.
//   - BUDGET: an optional per-process call cap (default 0 = unlimited).
//   - CACHE: CLI results are cached under their own namespace (model key
//     `cli:<backend>`), so identical batches replay at zero cost AND never
//     collide with cached OpenAI decisions.

import { spawn } from 'node:child_process';
import { ok, err } from '../clients/common/result.js';
import { hashPromptKey } from './keyHash.js';

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

// buildPrompt: fold the two-message (system + user) OpenAI shape into a
// single prompt string and bolt on a hard "JSON only, matching this schema"
// instruction, since a CLI has no structured-output enforcement.
function buildPrompt({ system, user, schema }) {
    const schemaBlock = schema
        ? `\n\nYour reply MUST be a single JSON object that validates against this JSON Schema:\n${JSON.stringify(schema)}`
        : '';
    return (
        `${system}\n\n` +
        `=== TASK ===\n${user}${schemaBlock}\n\n` +
        `=== OUTPUT CONTRACT ===\n` +
        `Respond with ONLY the JSON object. No prose, no explanation, no markdown, ` +
        `no code fences. Start your reply with "{" and end it with "}".`
    );
}

// extractJsonObject: pull the first balanced top-level {...} out of arbitrary
// CLI stdout (which may wrap the answer in prose or ```json fences). Brace
// counting is string- and escape-aware so a "}" inside a JSON string value
// never closes the object early. Returns the JSON substring or null.
export function extractJsonObject(text) {
    if (typeof text !== 'string') return null;
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inStr) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

// createSemaphore: minimal counting semaphore. acquire() resolves when a slot
// is free; the returned release() frees it and wakes the next waiter.
function createSemaphore(max) {
    const limit = Math.max(1, Number(max) || 1);
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= limit || queue.length === 0) return;
        active += 1;
        const resolve = queue.shift();
        resolve();
    };
    return {
        async acquire() {
            await new Promise((resolve) => {
                queue.push(resolve);
                next();
            });
            let released = false;
            return () => {
                if (released) return;
                released = true;
                active -= 1;
                next();
            };
        },
    };
}

// argvFor: the spawn argv for each supported backend. The prompt is passed on
// STDIN (not argv) so large batches never hit the OS arg-length ceiling.
//   - claude : `claude -p [--model M] [extra...]`  (print / headless mode)
//   - codex  : `codex exec [--model M] [extra...] -`  (non-interactive, stdin)
function argvFor({ backend, model, extraArgs }) {
    const extra = Array.isArray(extraArgs) ? extraArgs : [];
    if (backend === 'codex') {
        const args = ['exec'];
        if (model) args.push('--model', model);
        return { bin: 'codex', args: [...args, ...extra, '-'] };
    }
    // default: claude
    const args = ['-p'];
    if (model) args.push('--model', model);
    return { bin: 'claude', args: [...args, ...extra] };
}

// runCli: spawn the CLI once, feed `prompt` on stdin, collect stdout with a
// hard timeout. Resolves { code, stdout, stderr, timedOut, spawnError }.
// Never rejects — all failure modes come back as fields. This is the default
// `runFn`; tests inject a fake with the same shape for determinism.
export function runCli({ bin, args, prompt, timeoutMs, logger }) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: e });
            return;
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const finish = (payload) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(payload);
        };

        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, Math.max(1000, Number(timeoutMs) || 60000));

        child.on('error', (e) => {
            // ENOENT (binary missing) and friends land here.
            finish({ code: null, stdout, stderr, timedOut, spawnError: e });
        });
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', (code) => {
            finish({ code, stdout, stderr, timedOut, spawnError: null });
        });

        // Feed the prompt, then close stdin so the CLI starts work.
        try {
            child.stdin.write(prompt);
            child.stdin.end();
        } catch (e) {
            logger?.debug?.({ err: e?.message }, 'cli-judge: stdin write failed');
        }
    });
}

// createCliJudgeClient: factory.
//   backend      : 'claude' | 'codex'
//   fallback     : an object with .completeJson (the OpenAI client). Required
//                  for the safety net; without it, CLI failures return err().
//   model        : model id passed to the CLI (''/null = CLI's own default)
//   extraArgs    : additional CLI flags (array) — e.g. ['--allowedTools','']
//   timeoutMs    : per-call wall-clock budget
//   concurrency  : max simultaneous CLI processes
//   maxCalls     : per-process CLI call budget (0 = unlimited)
//   maxFailures  : consecutive-failure latch before CLI is disabled
//   cache        : optional disk cache (reuses the AI cache; own namespace)
//   logger       : pino-ish
// Returns { completeJson }.
export function createCliJudgeClient({
    backend = 'claude',
    fallback = null,
    model = '',
    extraArgs = [],
    timeoutMs = 60000,
    concurrency = 2,
    maxCalls = 0,
    maxFailures = 3,
    cache = null,
    logger = null,
    runFn = runCli, // injectable spawn-and-collect; swapped by unit tests
} = {}) {
    const sem = createSemaphore(concurrency);
    const cacheModelKey = `cli:${backend}`;
    let cliDisabled = false; // latched off after too many failures / ENOENT
    let consecutiveFailures = 0;
    let callsMade = 0;

    // delegate: hand the exact same args to the paid fallback, tagging the
    // result so logs show the API caught it. Returns a clean err if there is
    // no fallback configured.
    async function delegate(args, why) {
        logger?.warn?.({ backend, why }, 'cli-judge: falling back to API');
        if (!fallback || typeof fallback.completeJson !== 'function') {
            return err('CLI_JUDGE_FAILED', `CLI judge failed (${why}) and no API fallback is configured`);
        }
        const r = await fallback.completeJson(args);
        if (r.ok) r.value.backend = 'api-fallback';
        return r;
    }

    // noteFailure: bump the latch; disable the CLI entirely once it trips, so
    // the rest of the process skips the slow spawn-and-fail loop.
    function noteFailure(hard = false) {
        consecutiveFailures += 1;
        if (hard || consecutiveFailures >= maxFailures) {
            if (!cliDisabled) {
                logger?.error?.(
                    { backend, consecutiveFailures, hard },
                    'cli-judge: disabling CLI for this process — all judging now uses the API fallback',
                );
            }
            cliDisabled = true;
        }
    }

    async function completeJson(args = {}) {
        const { system, user, schema = null, schemaName = 'Output', zodSchema = null } = args;
        if (typeof system !== 'string' || typeof user !== 'string') {
            return err('BAD_INPUT', 'system and user must be strings');
        }

        // Latched off (or over budget) → straight to the paid path.
        if (cliDisabled) return delegate(args, 'cli-disabled');
        if (maxCalls > 0 && callsMade >= maxCalls) return delegate(args, 'budget-exhausted');

        // --- cache read (CLI namespace) --------------------------------
        const key = hashPromptKey({ model: cacheModelKey, system, user, schemaName });
        if (cache) {
            const hit = await cache.get(key);
            if (hit !== null && hit !== undefined) {
                return ok({ value: hit, cacheHit: true, key, usage: ZERO_USAGE, backend });
            }
        }

        const prompt = buildPrompt({ system, user, schema });
        const { bin, args: cliArgs } = argvFor({ backend, model, extraArgs });

        callsMade += 1;
        const release = await sem.acquire();
        let res;
        try {
            res = await runFn({ bin, args: cliArgs, prompt, timeoutMs, logger });
        } finally {
            release();
        }

        // --- spawn / exit failures → fallback --------------------------
        if (res.spawnError) {
            const enoent = res.spawnError.code === 'ENOENT';
            logger?.[enoent ? 'error' : 'warn']?.(
                { backend, bin, err: res.spawnError.message },
                enoent ? 'cli-judge: binary not found' : 'cli-judge: spawn error',
            );
            noteFailure(enoent); // missing binary = hard-disable immediately
            return delegate(args, enoent ? 'binary-missing' : 'spawn-error');
        }
        if (res.timedOut) {
            noteFailure();
            return delegate(args, 'timeout');
        }
        if (res.code !== 0) {
            logger?.warn?.(
                { backend, code: res.code, stderr: res.stderr.slice(0, 300) },
                'cli-judge: non-zero exit',
            );
            noteFailure();
            return delegate(args, `exit-${res.code}`);
        }

        // --- parse + validate ------------------------------------------
        const jsonText = extractJsonObject(res.stdout);
        if (!jsonText) {
            logger?.warn?.({ backend, sample: res.stdout.slice(0, 300) }, 'cli-judge: no JSON object in output');
            noteFailure();
            return delegate(args, 'no-json');
        }
        let parsed;
        try {
            parsed = JSON.parse(jsonText);
        } catch {
            noteFailure();
            return delegate(args, 'bad-json');
        }
        if (zodSchema) {
            const check = zodSchema.safeParse(parsed);
            if (!check.success) {
                logger?.warn?.({ backend, issues: check.error?.issues?.length }, 'cli-judge: schema mismatch');
                noteFailure();
                return delegate(args, 'schema-mismatch');
            }
            parsed = check.data;
        }

        // success — reset the latch and cache the decision.
        consecutiveFailures = 0;
        if (cache) await cache.set(key, parsed);
        logger?.debug?.({ backend, key: key.slice(0, 10) }, 'cli-judge: decision ok');
        return ok({ value: parsed, cacheHit: false, key, usage: ZERO_USAGE, backend });
    }

    return { completeJson, backend };
}
