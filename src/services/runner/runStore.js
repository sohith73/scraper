// In-memory run registry + disk persistence + pub-sub for SSE.
//
// Why : a run is a long-lived operation with observable state. Multiple
//       clients (the UI, tests, logs) need to watch it. An EventEmitter
//       gives us pub-sub for ~free; a per-run state.json on disk means an
//       Express restart doesn't lose history (running jobs are marked
//       `aborted-on-restart` on boot — added in Phase 15/16 hardening).

import { EventEmitter } from 'node:events';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { PHASES, isTerminal, makeInitialState } from './state.js';

// writeStateAtomic: tmp-then-rename so a crash mid-write never corrupts
// state.json. Swallows errors — persistence is best-effort; the in-memory
// map is the source of truth during a process's lifetime.
async function writeStateAtomic(filePath, state) {
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
        await rename(tmp, filePath);
    } catch {
        try {
            await unlink(tmp);
        } catch {
            /* ignore */
        }
    }
}

// createRunStore: factory. One per process; shared via the container.
// input  : { runsDir, logger?, idGen? }
// output : { create, get, update, list, subscribe, requestAbort, runDir }
export function createRunStore({
    runsDir,
    logger = null,
    idGen = () => randomUUID(),
} = {}) {
    if (!runsDir || typeof runsDir !== 'string') {
        throw new TypeError('createRunStore: runsDir is required');
    }
    const runs = new Map(); // runId → state object
    const emitters = new Map(); // runId → EventEmitter

    function ensureEmitter(runId) {
        let em = emitters.get(runId);
        if (!em) {
            em = new EventEmitter();
            em.setMaxListeners(0);
            emitters.set(runId, em);
        }
        return em;
    }

    // runDir: path for run artifacts. Exported so pipeline can write
    // side files (picks.json, summary.json) under the same dir.
    function runDir(runId) {
        return join(runsDir, runId);
    }

    function stateFile(runId) {
        return join(runDir(runId), 'state.json');
    }

    // create: mint a new run with a fresh id. Persists state.json + emits
    // an initial 'state' event so any immediate subscriber sees phase:queued.
    function create({ clientEmail, clientName, requestedCount, resumedFrom = null }) {
        const id = idGen();
        const state = makeInitialState({ id, clientEmail, clientName, requestedCount });
        if (resumedFrom) state.resumedFrom = resumedFrom;
        runs.set(id, state);
        // fire-and-forget persist
        writeStateAtomic(stateFile(id), state);
        ensureEmitter(id).emit('state', state);
        logger?.info?.({ runId: id, clientEmail }, 'run created');
        return state;
    }

    // get: returns the current state object (mutations are rejected because
    // update() is the only sanctioned write path; `Object.freeze` would break
    // JSON.stringify in some code paths so we just trust callers).
    function get(runId) {
        return runs.get(runId) || null;
    }

    // list: snapshot of every run. Useful for admin + restart-detection.
    function list() {
        return [...runs.values()];
    }

    // update: merge a patch into the run, bump updatedAt + eventSeq, persist,
    // emit. If the patch would illegally transition out of a terminal phase,
    // the update is skipped.
    function update(runId, patch) {
        const prev = runs.get(runId);
        if (!prev) return null;
        if (isTerminal(prev.phase) && patch.phase && patch.phase !== prev.phase) {
            logger?.warn?.(
                { runId, from: prev.phase, to: patch.phase },
                'update rejected: run already terminal',
            );
            return prev;
        }
        // Deep-ish merge: progress fields get replaced wholesale by design
        // (callers always pass the whole slice they want to update).
        const next = {
            ...prev,
            ...patch,
            progress: patch.progress
                ? { ...prev.progress, ...patch.progress }
                : prev.progress,
            updatedAt: new Date().toISOString(),
            eventSeq: prev.eventSeq + 1,
        };
        if (isTerminal(next.phase)) {
            next.durationMs = Date.parse(next.updatedAt) - Date.parse(next.createdAt);
        }
        runs.set(runId, next);
        writeStateAtomic(stateFile(runId), next);
        ensureEmitter(runId).emit('state', next);
        return next;
    }

    // subscribe: register a listener that receives every subsequent state
    // change for this run. Returns an unsubscribe function.
    function subscribe(runId, handler) {
        const em = ensureEmitter(runId);
        em.on('state', handler);
        return () => em.off('state', handler);
    }

    // requestAbort: cooperative — sets a flag the pipeline checks at phase
    // boundaries. We do NOT force-kill in-flight Playwright; that would risk
    // leaving the shared JR account in a weird state.
    function requestAbort(runId) {
        const prev = runs.get(runId);
        if (!prev) return null;
        if (isTerminal(prev.phase)) return prev;
        return update(runId, { abortRequested: true });
    }

    return {
        create,
        get,
        list,
        update,
        subscribe,
        requestAbort,
        runDir,
        // exposed for pipeline modules that want to stash artifacts
        runsDir,
        PHASES,
    };
}
