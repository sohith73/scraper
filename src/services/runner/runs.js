// Runs service — the public facade wired into the container.
//
// The store holds state + subscribers; the pipeline does work; the service
// glues them so route handlers can be one-liners:
//    const run = runs.start({ clientEmail, count });
//    runs.subscribe(run.id, onChange);
//    runs.abort(run.id);

import { createRunStore } from './runStore.js';
import { runPipeline } from './pipeline.js';
import { runManualPipeline } from './manualPipeline.js';
import {
    readCooldown,
    isCooldownActive,
    describeCooldown,
    clearCooldown,
} from './cooldown.js';

// createRunsService: factory.
// input  : { container, runsDir, logger, runPipeline? }
//          runPipeline is injectable so tests can swap in a stub that
//          doesn't need Playwright / OpenAI / etc.
// output : { start, get, list, subscribe, abort, runDir }
export function createRunsService({
    container,
    runsDir,
    logger = null,
    pipelineImpl = runPipeline,
    manualPipelineImpl = runManualPipeline,
} = {}) {
    if (!container) throw new TypeError('createRunsService: container is required');
    const store = createRunStore({ runsDir, logger });

    // Cooldown cache: the pipeline writes `.cooldown.json` when JR throttles
    // or blocks us. We re-read it after each pipeline run and before every
    // start() attempt so a fresh operator hit gets the authoritative state.
    let cooldownCache = null;

    async function refreshCooldown() {
        cooldownCache = await readCooldown(runsDir);
        if (cooldownCache && !isCooldownActive(cooldownCache)) {
            await clearCooldown(runsDir);
            cooldownCache = null;
        }
        return cooldownCache;
    }
    // Prime the cache at construction — don't block the caller on it.
    refreshCooldown().catch(() => {});

    async function cooldownStatus() {
        const record = await refreshCooldown();
        return {
            active: Boolean(record),
            record,
            message: record ? describeCooldown(record) : '',
        };
    }

    // start: synchronous — the run is created in memory immediately and
    // the pipeline is kicked off fire-and-forget.
    //
    // Refuses up-front when a cooldown is active; the route maps that
    // to HTTP 429 so operators see the actual cooldown reason.
    function start({
        clientEmail,
        clientName = '',
        requestedCount,
        overrideIntent = null,
        overrideFields = null,
        resumeFrom = null,
    }) {
        if (typeof clientEmail !== 'string' || !clientEmail.includes('@')) {
            throw new Error('clientEmail required');
        }
        if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 100) {
            throw new Error('requestedCount must be an integer in [1,100]');
        }
        if (isCooldownActive(cooldownCache)) {
            const err = new Error(describeCooldown(cooldownCache));
            err.code = 'COOLDOWN';
            err.cooldown = cooldownCache;
            throw err;
        }
        const run = store.create({
            clientEmail,
            clientName,
            requestedCount,
            resumedFrom: resumeFrom?.prevRunId || null,
        });
        Promise.resolve()
            .then(() =>
                pipelineImpl({
                    store,
                    runId: run.id,
                    container,
                    overrideIntent,
                    overrideFields,
                    resumeFrom,
                }),
            )
            .then(() => refreshCooldown())
            .catch((err) => {
                logger?.error?.({ runId: run.id, err: err.message }, 'pipeline promise rejected');
            });
        return run;
    }

    // resume: spawn a NEW run that picks up where a failed one left off.
    // Preloads seenJrIds so pagination skips jobs already scanned, and
    // subtracts previously-pushed jobs from the target count.
    function resume(prevRunId) {
        const prev = store.get(prevRunId);
        if (!prev) {
            const e = new Error('run not found');
            e.code = 'NOT_FOUND';
            throw e;
        }
        if (prev.phase !== 'failed') {
            const e = new Error(`run is ${prev.phase}, not failed — cannot resume`);
            e.code = 'BAD_INPUT';
            throw e;
        }
        const alreadyPushed = Array.isArray(prev.picks) ? prev.picks.length : 0;
        const remaining = Math.max(1, (prev.requestedCount || 1) - alreadyPushed);
        const intent = prev.progress?.intent || null;
        const seenJrIds = Array.isArray(prev.progress?.seenJrIds)
            ? prev.progress.seenJrIds
            : [];
        return start({
            clientEmail: prev.clientEmail,
            clientName: prev.clientName,
            requestedCount: remaining,
            overrideIntent: intent,
            resumeFrom: {
                prevRunId,
                seenJrIds,
                prevPushed: alreadyPushed,
            },
        });
    }

    // startManual: launch a run that consumes operator-captured raw JR
    // payloads (from the browser extension) instead of fetching from JR
    // ourselves. Skips summariser + search; enters at relevance filter.
    //
    // input  : { clientEmail, clientName?, capturedJobs:RawJrJob[] }
    // output : run state object (same shape as start())
    function startManual({
        clientEmail,
        clientName = '',
        capturedJobs = [],
    }) {
        if (typeof clientEmail !== 'string' || !clientEmail.includes('@')) {
            throw new Error('clientEmail required');
        }
        if (!Array.isArray(capturedJobs) || capturedJobs.length === 0) {
            throw new Error('capturedJobs (non-empty array) required');
        }
        if (capturedJobs.length > 1000) {
            throw new Error('capturedJobs cap is 1000 per run');
        }
        if (isCooldownActive(cooldownCache)) {
            const err = new Error(describeCooldown(cooldownCache));
            err.code = 'COOLDOWN';
            err.cooldown = cooldownCache;
            throw err;
        }
        const run = store.create({
            clientEmail,
            clientName,
            requestedCount: capturedJobs.length,
        });
        // Tag the run as manual-mode immediately so subscribers see the
        // mode before the pipeline transitions phases.
        store.update(run.id, { progress: { mode: 'manual' } });
        Promise.resolve()
            .then(() =>
                manualPipelineImpl({
                    store,
                    runId: run.id,
                    container,
                    capturedJobs,
                }),
            )
            .then(() => refreshCooldown())
            .catch((err) => {
                logger?.error?.(
                    { runId: run.id, err: err.message },
                    'manual pipeline promise rejected',
                );
            });
        return run;
    }

    return {
        start,
        startManual,
        resume,
        get: (id) => store.get(id),
        list: () => store.list(),
        subscribe: (id, handler) => store.subscribe(id, handler),
        abort: (id) => store.requestAbort(id),
        runDir: (id) => store.runDir(id),
        cooldownStatus,
        refreshCooldown,
        // Escape-hatch used by the /expand route to inject the operator's
        // relaxation decision into the run state; the pipeline's poll loop
        // picks it up within 500ms and resumes.
        _store: store,
    };
}
