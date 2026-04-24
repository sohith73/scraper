// Run routes:
//   POST /api/runs                     start a new run, returns {runId, state}
//   GET  /api/runs                     list all runs (summary view)
//   GET  /api/runs/:id                 snapshot of one run
//   GET  /api/runs/:id/events          SSE stream of state transitions
//   POST /api/runs/:id/abort           cooperative cancel

import { Router } from 'express';
import { readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resultCodeToStatus } from './clients.js';

function respondOk(res, req, value, status = 200) {
    res.status(status).json({ success: true, requestId: req.id, ...value });
}
function respondErr(res, req, code, message) {
    res.status(resultCodeToStatus(code)).json({
        success: false,
        error: code,
        message,
        requestId: req.id,
    });
}

// summariseRun: condensed projection for list endpoints + the SSE wire so
// clients don't receive multi-KB payloads on every progress tick.
function summariseRun(r) {
    return {
        id: r.id,
        phase: r.phase,
        clientEmail: r.clientEmail,
        clientName: r.clientName,
        requestedCount: r.requestedCount,
        abortRequested: r.abortRequested,
        progress: r.progress,
        picksCount: Array.isArray(r.picks) ? r.picks.length : 0,
        error: r.error,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        durationMs: r.durationMs,
        eventSeq: r.eventSeq,
        resumedFrom: r.resumedFrom || null,
    };
}

export function runsRouter({ container }) {
    if (!container?.runs) {
        throw new Error('runsRouter: container.runs is required');
    }
    const router = Router();

    // POST /api/runs
    router.post('/runs', async (req, res, next) => {
        try {
            const { clientEmail, clientName, count, overrideIntent, overrideFields } = req.body || {};
            if (!clientEmail) return respondErr(res, req, 'BAD_INPUT', 'clientEmail required');
            const requestedCount = Number.isInteger(count) ? count : Number.parseInt(count, 10);
            try {
                const run = container.runs.start({
                    clientEmail,
                    clientName: clientName || '',
                    requestedCount,
                    overrideIntent: overrideIntent || null,
                    overrideFields: overrideFields || null,
                });
                respondOk(res, req, { run: summariseRun(run) }, 201);
            } catch (e) {
                if (e?.code === 'COOLDOWN') {
                    return res.status(429).json({
                        success: false,
                        error: 'COOLDOWN',
                        message: e.message,
                        cooldown: e.cooldown || null,
                        requestId: req.id,
                    });
                }
                respondErr(res, req, 'BAD_INPUT', e.message);
            }
        } catch (e) {
            next(e);
        }
    });

    // GET /api/runs
    router.get('/runs', (req, res) => {
        const runs = container.runs.list().map(summariseRun);
        respondOk(res, req, { runs });
    });

    // GET /api/runs/cooldown — operator-readable cooldown state.
    router.get('/runs/cooldown', async (req, res, next) => {
        try {
            if (typeof container.runs.cooldownStatus !== 'function') {
                return respondOk(res, req, { active: false, record: null, message: '' });
            }
            const status = await container.runs.cooldownStatus();
            respondOk(res, req, status);
        } catch (e) {
            next(e);
        }
    });

    // GET /api/runs/:id
    router.get('/runs/:id', (req, res) => {
        const run = container.runs.get(req.params.id);
        if (!run) return respondErr(res, req, 'NOT_FOUND', 'run not found');
        respondOk(res, req, { run });
    });

    // GET /api/runs/:id/log — tail the run.log (plain text, newline-delimited JSON).
    // Optional ?lines=200 to limit; default 500.
    router.get('/runs/:id/log', async (req, res, next) => {
        try {
            const runId = req.params.id;
            const run = container.runs.get(runId);
            if (!run) return respondErr(res, req, 'NOT_FOUND', 'run not found');
            const dir = container.runs.runDir(runId);
            const logPath = join(dir, 'run.log');
            try {
                await stat(logPath);
            } catch {
                return respondOk(res, req, { log: '', lines: 0 });
            }
            const maxLines = Math.min(
                Math.max(Number.parseInt(req.query.lines, 10) || 500, 1),
                5000,
            );
            const raw = await readFile(logPath, 'utf8');
            const all = raw.split('\n').filter(Boolean);
            const tail = all.slice(-maxLines);
            respondOk(res, req, { log: tail.join('\n'), lines: tail.length });
        } catch (e) {
            next(e);
        }
    });

    // GET /api/runs/:id/artifacts — list files in the run's directory so
    // operators can grab picks.json / summary.json / error.json etc.
    router.get('/runs/:id/artifacts', async (req, res, next) => {
        try {
            const runId = req.params.id;
            const run = container.runs.get(runId);
            if (!run) return respondErr(res, req, 'NOT_FOUND', 'run not found');
            const dir = container.runs.runDir(runId);
            let entries = [];
            try {
                const files = await readdir(dir);
                entries = await Promise.all(
                    files.map(async (name) => {
                        try {
                            const s = await stat(join(dir, name));
                            return {
                                name,
                                size: s.size,
                                modified: s.mtime.toISOString(),
                            };
                        } catch {
                            return null;
                        }
                    }),
                );
                entries = entries.filter(Boolean);
            } catch {
                /* empty dir */
            }
            respondOk(res, req, { dir, artifacts: entries });
        } catch (e) {
            next(e);
        }
    });

    // POST /api/runs/:id/abort
    router.post('/runs/:id/abort', (req, res) => {
        const run = container.runs.abort(req.params.id);
        if (!run) return respondErr(res, req, 'NOT_FOUND', 'run not found');
        respondOk(res, req, { run: summariseRun(run) });
    });

    // POST /api/runs/:id/resume — spawn a new run that picks up where a
    // failed run left off. Carries intent + seenJrIds forward so JR isn't
    // re-scanned. Target shrinks by the number of jobs already pushed.
    router.post('/runs/:id/resume', (req, res) => {
        try {
            const run = container.runs.resume(req.params.id);
            respondOk(res, req, { run: summariseRun(run) }, 201);
        } catch (e) {
            if (e.code === 'NOT_FOUND') return respondErr(res, req, 'NOT_FOUND', e.message);
            if (e.code === 'BAD_INPUT') return respondErr(res, req, 'BAD_INPUT', e.message);
            if (e.code === 'COOLDOWN') {
                res.status(429).json({
                    success: false,
                    error: 'COOLDOWN',
                    message: e.message,
                    cooldown: e.cooldown,
                    requestId: req.id,
                });
                return;
            }
            return respondErr(res, req, 'INTERNAL', e.message);
        }
    });

    // GET /api/runs/:id/events — SSE
    // The UI's EventSource hangs on this until the run reaches a terminal
    // phase, at which point we send one last event + close. A 15s
    // comment-heartbeat keeps the connection alive through proxy buffers.
    router.get('/runs/:id/events', (req, res) => {
        const runId = req.params.id;
        const current = container.runs.get(runId);
        if (!current) {
            res.status(404).json({
                success: false,
                error: 'NOT_FOUND',
                message: 'run not found',
            });
            return;
        }
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache, no-transform');
        res.setHeader('connection', 'keep-alive');
        res.setHeader('x-accel-buffering', 'no');
        res.flushHeaders?.();

        const send = (state) => {
            try {
                res.write(`id: ${state.eventSeq}\n`);
                res.write(`event: state\n`);
                res.write(`data: ${JSON.stringify(summariseRun(state))}\n\n`);
            } catch {
                /* client gone; cleanup happens via 'close' */
            }
        };
        send(current);

        // If the run is already terminal, close right after the snapshot.
        if (['done', 'failed', 'aborted'].includes(current.phase)) {
            res.end();
            return;
        }

        const unsubscribe = container.runs.subscribe(runId, (state) => {
            send(state);
            if (['done', 'failed', 'aborted'].includes(state.phase)) {
                res.end();
            }
        });
        const heartbeat = setInterval(() => {
            try {
                res.write(': ping\n\n');
            } catch {
                /* ignore */
            }
        }, 15_000);

        const cleanup = () => {
            clearInterval(heartbeat);
            unsubscribe();
        };
        req.on('close', cleanup);
        req.on('aborted', cleanup);
    });

    return router;
}
