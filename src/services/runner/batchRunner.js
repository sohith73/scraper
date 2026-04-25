// Batch runner — drives the "Scrape All" flow.
//
// Why  : the admin clicks one button to scrape N jobs for every Active +
//        Unpaused client. Runs MUST happen one-by-one (shared JR account,
//        same mutex the pipeline already uses). Running in parallel would
//        corrupt the server-side filter between requests.
//
// What : this service owns a list of "items" (one per client), walks them
//        sequentially, hands each off to runsService.start, waits for the
//        terminal phase via subscribe, records the outcome, and emits
//        progress events for SSE.
//
// State : in-memory only. Batches are ephemeral — once the progress modal
//         closes the operator rarely cares. If we ever need batch history
//         we'll layer a Mongo store under the same interface.
//
// No Redis: the sequential semantics + the existing per-run Playwright
// mutex give us all the serialisation we need.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isTerminal } from './state.js';

const MAX_PARALLEL_BATCHES = 1; // one batch at a time across the whole process

// createBatchRunner: factory.
// input  : { runsService, logger?, idGen? }
// output : { start, get, list, subscribe, cancel }
export function createBatchRunner({ runsService, logger = null, idGen = () => randomUUID() } = {}) {
    if (!runsService || typeof runsService.start !== 'function') {
        throw new TypeError('createBatchRunner: runsService is required');
    }

    const batches = new Map(); // batchId → state
    const emitters = new Map(); // batchId → EventEmitter
    let active = 0;

    function ensureEmitter(batchId) {
        let em = emitters.get(batchId);
        if (!em) {
            em = new EventEmitter();
            em.setMaxListeners(0);
            emitters.set(batchId, em);
        }
        return em;
    }

    function emit(batchId) {
        const state = batches.get(batchId);
        if (!state) return;
        state.updatedAt = new Date().toISOString();
        state.eventSeq = (state.eventSeq || 0) + 1;
        ensureEmitter(batchId).emit('state', snapshot(state));
    }

    // snapshot: strip internal handles + return a JSON-safe copy.
    function snapshot(state) {
        return {
            id: state.id,
            status: state.status,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
            completedAt: state.completedAt,
            cancelled: state.cancelled,
            currentIndex: state.currentIndex,
            totals: computeTotals(state),
            items: state.items.map((it) => ({
                email: it.email,
                name: it.name,
                count: it.count,
                status: it.status,
                runId: it.runId,
                startedAt: it.startedAt,
                completedAt: it.completedAt,
                pushed: it.pushed,
                requested: it.count,
                phase: it.phase,
                error: it.error,
                errorCode: it.errorCode,
                skippedReason: it.skippedReason,
                relaxationRounds: it.relaxationRounds,
            })),
            eventSeq: state.eventSeq || 0,
        };
    }

    function computeTotals(state) {
        const t = {
            clients: state.items.length,
            pending: 0,
            running: 0,
            done: 0,
            failed: 0,
            aborted: 0,
            skipped: 0,
            jobsPushed: 0,
            jobsRequested: 0,
        };
        for (const it of state.items) {
            t[it.status] = (t[it.status] || 0) + 1;
            t.jobsRequested += Number.isInteger(it.count) ? it.count : 0;
            t.jobsPushed += Number.isInteger(it.pushed) ? it.pushed : 0;
        }
        return t;
    }

    function validateClients(clients) {
        if (!Array.isArray(clients) || clients.length === 0) {
            throw new Error('clients must be a non-empty array');
        }
        if (clients.length > 100) {
            throw new Error('batch capped at 100 clients');
        }
        const seen = new Set();
        const out = [];
        for (const c of clients) {
            const email = typeof c?.email === 'string' ? c.email.trim().toLowerCase() : '';
            if (!email || !email.includes('@')) {
                throw new Error(`invalid client entry: email=${JSON.stringify(c?.email)}`);
            }
            if (seen.has(email)) continue; // dedupe silently
            seen.add(email);
            const n = Number.parseInt(c.count, 10);
            if (!Number.isInteger(n) || n < 1 || n > 50) {
                throw new Error(`invalid count for ${email}: ${c.count} (must be integer 1–50)`);
            }
            out.push({ email, name: typeof c.name === 'string' ? c.name : '', count: n });
        }
        return out;
    }

    // start: kick off a batch. Synchronous — the state is created in memory
    // + the first item begins dispatching on the next tick.
    function start({ clients }) {
        if (active >= MAX_PARALLEL_BATCHES) {
            const err = new Error('another batch is already running — wait for it to finish or cancel it');
            err.code = 'BATCH_BUSY';
            throw err;
        }
        const normalised = validateClients(clients);
        const id = idGen();
        const now = new Date().toISOString();
        const state = {
            id,
            status: 'running',
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            cancelled: false,
            currentIndex: -1,
            items: normalised.map((c) => ({
                email: c.email,
                name: c.name,
                count: c.count,
                status: 'pending',
                runId: null,
                startedAt: null,
                completedAt: null,
                pushed: null,
                phase: null,
                error: null,
                errorCode: null,
                skippedReason: null,
                relaxationRounds: 0,
            })),
        };
        batches.set(id, state);
        active += 1;
        logger?.info?.({ batchId: id, count: normalised.length }, 'batch started');
        emit(id); // first snapshot before the loop starts

        // Run on next tick so the HTTP response can return the batch id.
        Promise.resolve().then(() => runSequentially(id)).catch((err) => {
            logger?.error?.({ batchId: id, err: err.message }, 'batch loop crashed');
        });
        return snapshot(state);
    }

    async function runSequentially(batchId) {
        const state = batches.get(batchId);
        if (!state) return;

        for (let i = 0; i < state.items.length; i++) {
            if (state.cancelled) {
                // Mark remaining items as skipped
                for (let j = i; j < state.items.length; j++) {
                    if (state.items[j].status === 'pending') {
                        state.items[j].status = 'skipped';
                        state.items[j].skippedReason = 'batch cancelled';
                    }
                }
                emit(batchId);
                break;
            }
            state.currentIndex = i;
            const item = state.items[i];
            item.status = 'running';
            item.startedAt = new Date().toISOString();
            emit(batchId);

            try {
                await executeItem(batchId, item);
            } catch (err) {
                // Defensive — executeItem already maps known errors. Any
                // escape here is an unexpected crash in the runner itself.
                item.status = 'failed';
                item.error = err?.message || String(err);
                item.errorCode = err?.code || 'INTERNAL';
                item.completedAt = new Date().toISOString();
                logger?.error?.(
                    { batchId, email: item.email, err: item.error },
                    'batch item crashed',
                );
                emit(batchId);
            }
        }

        state.currentIndex = state.items.length;
        state.completedAt = new Date().toISOString();
        state.status = state.cancelled ? 'cancelled' : 'done';
        active = Math.max(0, active - 1);
        emit(batchId);
        logger?.info?.(
            { batchId, totals: computeTotals(state) },
            state.cancelled ? 'batch cancelled' : 'batch done',
        );
    }

    // executeItem: starts a run for one client + resolves when the run
    // reaches a terminal phase. Maps the run's final state into the batch
    // item record.
    function executeItem(batchId, item) {
        return new Promise((resolve) => {
            let run;
            try {
                run = runsService.start({
                    clientEmail: item.email,
                    clientName: item.name || '',
                    requestedCount: item.count,
                });
            } catch (err) {
                item.status = 'failed';
                item.errorCode = err?.code || 'BAD_INPUT';
                item.error = err?.message || String(err);
                item.completedAt = new Date().toISOString();
                emit(batchId);
                return resolve();
            }
            item.runId = run.id;
            emit(batchId);

            // Poll relaxation auto-decline: the batch runner cannot pause
            // for operator input. If a run hits awaiting-relaxation, auto-
            // decline so the run ends gracefully and the batch continues.
            let autoDeclineFired = false;

            const unsubscribe = runsService.subscribe(run.id, (state) => {
                // Relaxation gate: auto-decline once per run.
                if (state.phase === 'awaiting-relaxation' && !autoDeclineFired) {
                    autoDeclineFired = true;
                    try {
                        runsService._store?.update?.(state.id, {
                            pendingRelaxation: {
                                ...(state.pendingRelaxation || {}),
                                decision: { action: 'decline', reason: 'batch-auto-decline' },
                            },
                        });
                    } catch (e) {
                        logger?.warn?.({ runId: state.id, err: e.message }, 'auto-decline failed');
                    }
                    item.relaxationRounds = (item.relaxationRounds || 0) + 1;
                    emit(batchId);
                    return;
                }

                if (!isTerminal(state.phase)) return;

                unsubscribe();
                item.phase = state.phase;
                item.completedAt = new Date().toISOString();
                item.pushed = state.progress?.pushed?.pushed ?? 0;

                if (state.phase === 'done') {
                    item.status = 'done';
                } else if (state.phase === 'aborted') {
                    item.status = 'aborted';
                    item.error = 'aborted';
                } else {
                    item.status = 'failed';
                    item.errorCode = state.error?.code || 'FAILED';
                    item.error = state.error?.message || 'run failed';
                }
                emit(batchId);
                resolve();
            });
        });
    }

    function get(batchId) {
        const state = batches.get(batchId);
        return state ? snapshot(state) : null;
    }

    function list() {
        return [...batches.values()].map(snapshot);
    }

    function subscribe(batchId, handler) {
        const em = ensureEmitter(batchId);
        em.on('state', handler);
        return () => em.off('state', handler);
    }

    function cancel(batchId) {
        const state = batches.get(batchId);
        if (!state) return null;
        if (state.status !== 'running') return snapshot(state);
        state.cancelled = true;
        // Abort the currently-running underlying run so we don't sit idle
        // for the rest of its pipeline.
        const cur = state.items[state.currentIndex];
        if (cur?.runId) {
            try { runsService.abort(cur.runId); } catch { /* ignore */ }
        }
        emit(batchId);
        return snapshot(state);
    }

    return { start, get, list, subscribe, cancel };
}
