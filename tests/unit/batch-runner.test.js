// Unit tests for createBatchRunner. Runs the batch against a fake
// runsService so we exercise the sequential walk + subscribe/unsubscribe
// + terminal-phase classification without booting Playwright / OpenAI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBatchRunner } from '../../src/services/runner/batchRunner.js';

// fakeRunsService: minimal surface. start() records the call + returns a
// run state; subscribe() lets the test drive terminal transitions.
function fakeRunsService({ scripts = {} } = {}) {
    let nextRunId = 1;
    const emitters = new Map();
    const aborted = new Set();
    const started = [];
    const service = {
        start({ clientEmail, clientName, requestedCount }) {
            const runId = `run-${nextRunId++}`;
            const em = new EventEmitter();
            emitters.set(runId, em);
            started.push({ runId, clientEmail, clientName, requestedCount });
            const initial = {
                id: runId, phase: 'queued', clientEmail, clientName, requestedCount,
                progress: {}, picks: [],
            };
            // Drive terminal transition based on the test's script for this email.
            const terminal = scripts[clientEmail] || {
                phase: 'done',
                pushed: requestedCount,
            };
            setImmediate(() => {
                if (terminal.awaitingRelaxation) {
                    em.emit('state', { ...initial, phase: 'awaiting-relaxation', pendingRelaxation: { plans: [{}] } });
                    // Simulate auto-decline → terminal:
                    setImmediate(() => {
                        em.emit('state', {
                            ...initial,
                            phase: terminal.phaseAfterDecline || 'done',
                            progress: { pushed: { pushed: terminal.pushed || 0 } },
                            error: terminal.error || null,
                        });
                    });
                    return;
                }
                em.emit('state', {
                    ...initial,
                    phase: terminal.phase,
                    progress: { pushed: { pushed: terminal.pushed || 0 } },
                    error: terminal.error || null,
                });
            });
            return initial;
        },
        subscribe(runId, handler) {
            const em = emitters.get(runId);
            em.on('state', handler);
            return () => em.off('state', handler);
        },
        abort(runId) {
            aborted.add(runId);
            const em = emitters.get(runId);
            em?.emit('state', { id: runId, phase: 'aborted', progress: {}, error: null });
        },
        _store: {
            update: () => {},
        },
        _started: started,
        _aborted: aborted,
    };
    return service;
}

function waitForBatchComplete(batchRunner, batchId) {
    return new Promise((resolve) => {
        const unsub = batchRunner.subscribe(batchId, (state) => {
            if (state.status !== 'running') {
                unsub();
                resolve(state);
            }
        });
    });
}

test('batch: validates input shape', () => {
    const runner = createBatchRunner({ runsService: fakeRunsService() });
    assert.throws(() => runner.start({ clients: [] }), /non-empty/);
    assert.throws(
        () => runner.start({ clients: [{ email: 'not-an-email', count: 3 }] }),
        /invalid client entry/,
    );
    assert.throws(
        () => runner.start({ clients: [{ email: 'a@x', count: 0 }] }),
        /invalid count/,
    );
});

test('batch: dedupes duplicate emails silently', () => {
    const runner = createBatchRunner({ runsService: fakeRunsService() });
    const batch = runner.start({
        clients: [
            { email: 'A@X.com', count: 3 },
            { email: 'a@x.com', count: 5 }, // dup
            { email: 'b@x.com', count: 7 },
        ],
    });
    assert.equal(batch.items.length, 2);
    assert.equal(batch.items[0].email, 'a@x.com');
    assert.equal(batch.items[1].email, 'b@x.com');
});

test('batch: refuses a second concurrent batch', () => {
    const rs = fakeRunsService({ scripts: { 'slow@x.com': { phase: 'done', pushed: 1 } } });
    const runner = createBatchRunner({ runsService: rs });
    runner.start({ clients: [{ email: 'slow@x.com', count: 1 }] });
    assert.throws(
        () => runner.start({ clients: [{ email: 'other@x.com', count: 1 }] }),
        /another batch/i,
    );
});

test('batch: walks clients sequentially, classifies outcomes', async () => {
    const rs = fakeRunsService({
        scripts: {
            'ok1@x.com': { phase: 'done', pushed: 3 },
            'fail@x.com': { phase: 'failed', error: { code: 'RESUME_MISSING', message: 'no resume' } },
            'ok2@x.com': { phase: 'done', pushed: 5 },
        },
    });
    const runner = createBatchRunner({ runsService: rs });
    const batch = runner.start({
        clients: [
            { email: 'ok1@x.com', count: 3 },
            { email: 'fail@x.com', count: 3 },
            { email: 'ok2@x.com', count: 5 },
        ],
    });
    const final = await waitForBatchComplete(runner, batch.id);
    assert.equal(final.status, 'done');
    assert.equal(final.items[0].status, 'done');
    assert.equal(final.items[0].pushed, 3);
    assert.equal(final.items[1].status, 'failed');
    assert.equal(final.items[1].errorCode, 'RESUME_MISSING');
    assert.equal(final.items[1].error, 'no resume');
    assert.equal(final.items[2].status, 'done');
    assert.equal(final.items[2].pushed, 5);
    assert.deepEqual(
        rs._started.map((s) => s.clientEmail),
        ['ok1@x.com', 'fail@x.com', 'ok2@x.com'],
    );
    assert.equal(final.totals.done, 2);
    assert.equal(final.totals.failed, 1);
    assert.equal(final.totals.jobsPushed, 8);
    assert.equal(final.totals.jobsRequested, 11);
});

test('batch: cancel marks remaining pending as skipped + aborts the current run', async () => {
    // First client: pending → running → awaitingRelaxation → phaseAfterDecline:'done'
    // Use a script with awaitingRelaxation to create a window for cancel().
    const rs = fakeRunsService({
        scripts: {
            'a@x.com': { awaitingRelaxation: true, phaseAfterDecline: 'aborted' },
            'b@x.com': { phase: 'done', pushed: 1 },
        },
    });
    const runner = createBatchRunner({ runsService: rs });
    const batch = runner.start({
        clients: [
            { email: 'a@x.com', count: 2 },
            { email: 'b@x.com', count: 2 },
        ],
    });
    // Cancel during the first item's relaxation step.
    setImmediate(() => {
        setImmediate(() => runner.cancel(batch.id));
    });
    const final = await waitForBatchComplete(runner, batch.id);
    assert.equal(final.status, 'cancelled');
    assert.equal(final.items[0].status, 'aborted');
    assert.equal(final.items[1].status, 'skipped');
    assert.equal(final.items[1].skippedReason, 'batch cancelled');
    assert.ok(rs._aborted.has(final.items[0].runId));
});

test('batch: awaiting-relaxation auto-declines + run continues to terminal', async () => {
    const rs = fakeRunsService({
        scripts: {
            'a@x.com': { awaitingRelaxation: true, phaseAfterDecline: 'done', pushed: 0 },
        },
    });
    const runner = createBatchRunner({ runsService: rs });
    const batch = runner.start({ clients: [{ email: 'a@x.com', count: 3 }] });
    const final = await waitForBatchComplete(runner, batch.id);
    assert.equal(final.items[0].status, 'done');
    assert.equal(final.items[0].relaxationRounds, 1);
});

test('batch: runs-service start() throwing is captured as failed item', async () => {
    const rs = {
        start() {
            const e = new Error('resume missing');
            e.code = 'RESUME_MISSING';
            throw e;
        },
        subscribe: () => () => {},
        abort: () => {},
        _store: { update: () => {} },
    };
    const runner = createBatchRunner({ runsService: rs });
    const batch = runner.start({ clients: [{ email: 'a@x.com', count: 1 }] });
    const final = await waitForBatchComplete(runner, batch.id);
    assert.equal(final.items[0].status, 'failed');
    assert.equal(final.items[0].errorCode, 'RESUME_MISSING');
    assert.match(final.items[0].error, /resume missing/);
});

test('batch: subscribe delivers state snapshots + unsubscribe cleanly', async () => {
    const rs = fakeRunsService({ scripts: { 'a@x.com': { phase: 'done', pushed: 1 } } });
    const runner = createBatchRunner({ runsService: rs });
    const seen = [];
    const batch = runner.start({ clients: [{ email: 'a@x.com', count: 1 }] });
    const unsub = runner.subscribe(batch.id, (s) => seen.push(s.status));
    await waitForBatchComplete(runner, batch.id);
    unsub();
    assert.ok(seen.includes('running'));
    assert.equal(seen[seen.length - 1], 'done');
});

test('batch: get() returns a snapshot; list() includes created batches', async () => {
    const rs = fakeRunsService({ scripts: { 'a@x.com': { phase: 'done', pushed: 1 } } });
    const runner = createBatchRunner({ runsService: rs });
    const batch = runner.start({ clients: [{ email: 'a@x.com', count: 1 }] });
    const snap = runner.get(batch.id);
    assert.equal(snap.id, batch.id);
    assert.equal(runner.list().length, 1);
    assert.equal(runner.get('missing'), null);
    await waitForBatchComplete(runner, batch.id);
});
