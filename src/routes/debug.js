// Debug routes — single-shot endpoints for remote inspection.
//
// Why : the standard run endpoints make sense for the UI (state +
// SSE), but a remote operator (or a Claude agent) trying to figure out
// "why did the run fail" needs the data flat and self-contained:
//   - intent + relatedRoles
//   - JR filter payload that was sent
//   - JR list URL that was hit
//   - per-page returned/fresh counts
//   - AI decisions table (jobId, title, score, reason)
//   - last N log lines
//   - error code + message
//
// This module exposes that bundle on a single GET so a deploy debugger
// can `curl <host>/api/debug/last-run` and read everything at once.
//
// Auth: optional X-Debug-Token header (env DEBUG_TOKEN). Empty token
// disables the gate — fine on a firewalled box; set the env var when
// the host is reachable from the public internet.
//
// Endpoints:
//   GET  /api/debug/snapshot          system overview (env redacted, cooldown,
//                                     mongo + browser status, last 5 runs)
//   GET  /api/debug/last-run          full debug bundle for the most recent run
//   GET  /api/debug/run/:id           same bundle for a specific run id
//   POST /api/debug/preview-filter    body {clientEmail} → returns the JR filter
//                                     payload + list URL that WOULD be sent
//                                     (no JR call, no scrape)
//   POST /api/debug/dry-search        body {clientEmail, count} → JR fetch only,
//                                     returns raw + normalised jobs (no AI, no push)

import { Router } from 'express';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readCooldown, describeCooldown } from '../services/runner/cooldown.js';
import { runSearch } from '../services/search/runSearch.js';
import { searchIntentToJRFilter } from '../services/search/filterMapper.js';

function ok(res, req, value, status = 200) {
    res.status(status).json({ success: true, requestId: req.id, ...value });
}
function fail(res, req, code, message, extras = {}) {
    const status = code === 'BAD_INPUT' ? 400
        : code === 'NOT_FOUND' ? 404
        : code === 'UNAUTHORIZED' ? 401
        : 500;
    res.status(status).json({
        success: false,
        error: code,
        message,
        requestId: req.id,
        ...extras,
    });
}

// redactEnv: keep operator-relevant flags, strip every secret. Used by
// /snapshot so the deployer can confirm config without leaking keys.
function redactEnv(env) {
    const present = (v) => (v && String(v).length > 0 ? `set (${String(v).length} chars)` : 'unset');
    return {
        PORT: env.PORT,
        NODE_ENV: env.NODE_ENV,
        LOG_LEVEL: env.LOG_LEVEL,
        HEADLESS: env.HEADLESS,
        STEALTH: env.STEALTH,
        DEBUG_CAPTURE: env.DEBUG_CAPTURE,
        DRY_RUN: env.DRY_RUN,
        DASHBOARD_BASE: env.DASHBOARD_BASE,
        DASHBOARD_SERVICE_TOKEN: present(env.DASHBOARD_SERVICE_TOKEN),
        RESUME_BASE: env.RESUME_BASE,
        OPENAI_API_KEY: present(env.OPENAI_API_KEY),
        OPENAI_MODEL: env.OPENAI_MODEL,
        JOBRIGHT_BASE: env.JOBRIGHT_BASE,
        JOBRIGHT_COOLDOWN_MS: env.JOBRIGHT_COOLDOWN_MS,
        JOBRIGHT_EMAIL: env.JOBRIGHT_EMAIL ? `${env.JOBRIGHT_EMAIL.slice(0, 3)}***` : 'unset',
        JOBRIGHT_PASSWORD: present(env.JOBRIGHT_PASSWORD),
        MONGO_URI: env.MONGO_URI ? `set (${env.MONGO_URI.replace(/\/\/[^@]+@/, '//***@').slice(0, 60)}...)` : 'unset',
        MONGO_DB: env.MONGO_DB,
        DISCORD_WEBHOOK_URL: present(env.DISCORD_WEBHOOK_URL),
        CORS_EXTRA_ORIGINS: env.CORS_EXTRA_ORIGINS,
        DEBUG_TOKEN: present(env.DEBUG_TOKEN),
        STORAGE_DIR: env.STORAGE_DIR,
        RUNS_DIR: env.RUNS_DIR,
        AI_CACHE_DIR: env.AI_CACHE_DIR,
    };
}

// tailLog: read the last `lines` lines from runs/<id>/run.log without
// loading the whole file. NDJSON-parsed, malformed lines kept as raw text
// so a partial write doesn't lose context.
async function tailLog(runDir, lines = 100) {
    const path = join(runDir, 'run.log');
    let raw;
    try { raw = await readFile(path, 'utf8'); }
    catch { return []; }
    const all = raw.split(/\n+/).filter((l) => l.trim().length > 0);
    const tail = all.slice(-lines);
    return tail.map((line) => {
        try { return JSON.parse(line); }
        catch { return { raw: line }; }
    });
}

// tryMongoPing: best-effort liveness check. Returns 'ok' | error string |
// 'not-configured'. Never throws.
async function tryMongoPing(mongo) {
    if (!mongo?.ping) return 'not-configured';
    try { await mongo.ping(); return 'ok'; }
    catch (e) { return `error: ${e.message}`; }
}

// listArtifacts: directory listing with size + mtime so the operator can
// see at a glance which run produced trace.zip / error.json / picks.json.
async function listArtifacts(runDir) {
    let entries;
    try { entries = await readdir(runDir); }
    catch { return []; }
    const out = [];
    for (const name of entries) {
        try {
            const st = await stat(join(runDir, name));
            if (!st.isFile()) continue;
            out.push({ name, size: st.size, mtime: st.mtime.toISOString() });
        } catch { /* skip */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

// buildRunBundle: compose the single-shot debug payload for one run.
// Pulls state from the in-memory store + log tail + artifacts list +
// pre-extracts the most useful slices (intent, filter, JR URL, decisions,
// applied relaxations) onto the top level so a 1s curl gives 90% of what
// you need.
async function buildRunBundle({ runs, runId, env, logger, logLines = 100 }) {
    const r = runs.get(runId);
    if (!r) return null;
    const runDir = runs.runDir(runId);
    const [logTail, artifacts] = await Promise.all([
        tailLog(runDir, logLines),
        listArtifacts(runDir),
    ]);
    const progress = r.progress || {};
    const searched = progress.searched || {};
    return {
        run: {
            id: r.id,
            phase: r.phase,
            clientEmail: r.clientEmail,
            clientName: r.clientName,
            requestedCount: r.requestedCount,
            picksCount: Array.isArray(r.picks) ? r.picks.length : 0,
            error: r.error,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            durationMs: r.durationMs,
            abortRequested: r.abortRequested,
        },
        intent: progress.intent || null,
        appliedRelaxations: progress.appliedRelaxations || [],
        // Per-client architecture telemetry: which JR account did the run
        // log in as? `mode === 'client'` means we used the candidate's
        // own JR creds + their personalised recommender. `'shared'` means
        // we fell back to the Sohith account.
        sessionMode: progress.mode || 'shared',
        clientLogin: progress.clientLogin || null,
        // Most important debugging slice: what JR actually saw.
        jobright: {
            lastListUrl: searched.lastListUrl || null,
            lastFilterPayload: searched.lastFilterPayload || null,
            totalReturned: searched.totalReturned || 0,
            totalNormalized: searched.totalNormalized || 0,
            pages: searched.pages || 0,
            linkedInSkipped: searched.linkedInSkipped || 0,
            durationMs: searched.durationMs || 0,
        },
        ai: {
            stats: progress.filtered || null,
            cost: progress.cost || null,
            // Up to 200 most recent decisions {jobId,title,company,applyUrl,pick,score,reason}
            decisions: Array.isArray(progress.decisions) ? progress.decisions : [],
        },
        push: {
            preflight: progress.preflight || null,
            pushed: progress.pushed || null,
            picks: Array.isArray(r.picks) ? r.picks : [],
        },
        artifacts: artifacts.map((a) => ({
            ...a,
            url: `/api/runs/${r.id}/artifacts/${encodeURIComponent(a.name)}`,
        })),
        logTail,
        runDir,
    };
}

export function debugRouter({ container }) {
    if (!container?.runs) throw new Error('debugRouter: container.runs is required');
    const router = Router();
    const { env, logger, runs, browser, mutex, session, mongo } = container;

    // --- auth gate ---------------------------------------------------------
    router.use((req, res, next) => {
        const expected = env.DEBUG_TOKEN || '';
        if (!expected) return next(); // gate disabled
        const got = req.get('x-debug-token') || '';
        if (got !== expected) {
            return fail(res, req, 'UNAUTHORIZED', 'X-Debug-Token header missing or wrong');
        }
        return next();
    });

    // --- /snapshot ---------------------------------------------------------
    router.get('/debug/snapshot', async (req, res) => {
        try {
            const cooldownRecord = await readCooldown(env.RUNS_DIR);
            const cooldown = describeCooldown(cooldownRecord);
            // Session probe (cheap — JR /swan/auth/newinfo). Wrap in mutex so
            // we don't fight a live scrape.
            let sessionStatus = { error: 'not-checked' };
            try {
                const probe = await session.probeSession();
                sessionStatus = probe?.ok ? probe.value : { error: probe?.error };
            } catch (e) {
                sessionStatus = { error: e.message };
            }
            // Recent runs.
            const recent = runs.list().slice(-5).map((r) => ({
                id: r.id,
                phase: r.phase,
                clientEmail: r.clientEmail,
                requestedCount: r.requestedCount,
                picksCount: Array.isArray(r.picks) ? r.picks.length : 0,
                error: r.error?.code || null,
                durationMs: r.durationMs || null,
                createdAt: r.createdAt,
            })).reverse();
            ok(res, req, {
                env: redactEnv(env),
                cooldown,
                session: sessionStatus,
                mongo: { configured: !!env.MONGO_URI, ping: await tryMongoPing(mongo) },
                browser: browser?.status?.() ?? null,
                recentRuns: recent,
                tip: 'GET /api/debug/last-run for full per-run debug bundle.',
            });
        } catch (e) {
            logger?.error?.({ err: e.message, stack: e.stack }, 'debug.snapshot failed');
            fail(res, req, 'INTERNAL', e.message);
        }
    });

    // --- /last-run ---------------------------------------------------------
    router.get('/debug/last-run', async (req, res) => {
        try {
            const list = runs.list();
            if (list.length === 0) return fail(res, req, 'NOT_FOUND', 'no runs yet');
            const newest = list.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
            const lines = Number.parseInt(req.query.lines, 10);
            const bundle = await buildRunBundle({
                runs, runId: newest.id, env, logger,
                logLines: Number.isInteger(lines) ? Math.min(Math.max(lines, 10), 5000) : 100,
            });
            if (!bundle) return fail(res, req, 'NOT_FOUND', 'run vanished mid-fetch');
            ok(res, req, bundle);
        } catch (e) {
            logger?.error?.({ err: e.message, stack: e.stack }, 'debug.last-run failed');
            fail(res, req, 'INTERNAL', e.message);
        }
    });

    // --- /run/:id ----------------------------------------------------------
    router.get('/debug/run/:id', async (req, res) => {
        try {
            const lines = Number.parseInt(req.query.lines, 10);
            const bundle = await buildRunBundle({
                runs, runId: req.params.id, env, logger,
                logLines: Number.isInteger(lines) ? Math.min(Math.max(lines, 10), 5000) : 100,
            });
            if (!bundle) return fail(res, req, 'NOT_FOUND', `run ${req.params.id} not found`);
            ok(res, req, bundle);
        } catch (e) {
            logger?.error?.({ err: e.message, stack: e.stack, runId: req.params.id }, 'debug.run failed');
            fail(res, req, 'INTERNAL', e.message);
        }
    });

    // --- /preview-filter ---------------------------------------------------
    // Body: { clientEmail }  → uses the saved/persisted intent
    //       { intent: {...} } → preview directly from a hand-supplied intent
    // Returns the JR filter payload + the list URL that WOULD be sent. No
    // network calls to JR. Useful to confirm "did the mapper produce the
    // right body" without burning a real run.
    router.post('/debug/preview-filter', async (req, res) => {
        try {
            const { intent: bodyIntent, clientEmail } = req.body || {};
            let intent = bodyIntent;
            if (!intent && clientEmail) {
                // Pull persisted intent from the most recent run for this client.
                const list = runs.list().filter((r) => r.clientEmail === clientEmail);
                if (list.length === 0) {
                    return fail(res, req, 'NOT_FOUND', `no runs found for ${clientEmail} — pass intent in body to preview from scratch`);
                }
                const newest = list.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
                intent = newest.progress?.intent;
                if (!intent) return fail(res, req, 'NOT_FOUND', 'last run had no recorded intent');
            }
            if (!intent || typeof intent !== 'object') {
                return fail(res, req, 'BAD_INPUT', 'pass {intent} or {clientEmail} in body');
            }
            const filter = searchIntentToJRFilter({ intent, existing: null });
            const listUrl = `${env.JOBRIGHT_BASE.replace(/\/+$/, '')}/swan/recommend/list/jobs?refresh=true&sortCondition=0&position=0&count=10&syncRerank=false`;
            // Curl reproducer — operator can paste into terminal with the
            // right cookie jar and confirm JR's response shape.
            const curl = [
                `# 1) push the filter`,
                `curl -s '${env.JOBRIGHT_BASE.replace(/\/+$/, '')}/swan/filter/update/filter' \\`,
                `  -H 'content-type: application/json' \\`,
                `  -H 'cookie: <session>' \\`,
                `  -d '${JSON.stringify(filter).replace(/'/g, "'\\''")}'`,
                ``,
                `# 2) fetch the list`,
                `curl -s '${listUrl}' -H 'cookie: <session>'`,
            ].join('\n');
            ok(res, req, { intent, filter, listUrl, curl });
        } catch (e) {
            logger?.error?.({ err: e.message, stack: e.stack }, 'debug.preview-filter failed');
            fail(res, req, 'INTERNAL', e.message);
        }
    });

    // --- /dry-search -------------------------------------------------------
    // Body: { clientEmail, count? } — uses last-run intent to fire a real
    // JR list query; returns raw + normalised jobs but DOES NOT run AI or
    // push to dashboard. Lets the operator answer "is JR even returning
    // matching candidates for this client" in isolation.
    router.post('/debug/dry-search', async (req, res) => {
        try {
            const { clientEmail, intent: bodyIntent, count } = req.body || {};
            const n = Number.isInteger(count) ? Math.min(Math.max(count, 1), 10) : 10;
            let intent = bodyIntent;
            if (!intent) {
                if (!clientEmail) return fail(res, req, 'BAD_INPUT', 'pass clientEmail or intent');
                const list = runs.list().filter((r) => r.clientEmail === clientEmail);
                if (list.length === 0) return fail(res, req, 'NOT_FOUND', `no runs for ${clientEmail}`);
                const newest = list.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
                intent = newest.progress?.intent;
                if (!intent) return fail(res, req, 'NOT_FOUND', 'last run had no recorded intent');
            }
            const result = await runSearch({
                browser, mutex, env, logger,
                intent,
                count: n,
                position: 0,
            });
            if (!result.ok) {
                return fail(res, req, result.error.code, result.error.message, {
                    detail: result.error,
                });
            }
            const v = result.value;
            ok(res, req, {
                intent,
                listUrl: v.listUrl,
                filter: v.filter,
                totalReturned: v.totalReturned,
                durationMs: v.durationMs,
                jobs: v.jobs.map((j) => ({
                    id: j.id,
                    title: j.title,
                    company: j.companyName,
                    location: j.jobLocation,
                    workModel: j.workModel,
                    applyUrl: j.applyUrl,
                    seniority: j.seniority,
                    minYearsOfExperience: j.minYearsOfExperience,
                    score: j.score,
                    flags: j.flags,
                    descriptionLength: (j.description || '').length,
                })),
            });
        } catch (e) {
            logger?.error?.({ err: e.message, stack: e.stack }, 'debug.dry-search failed');
            fail(res, req, 'INTERNAL', e.message);
        }
    });

    return router;
}
