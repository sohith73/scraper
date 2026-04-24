import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPush } from '../../src/services/push/pushRunner.js';

// A canonical Job stub with just enough for toDashboardJob to succeed.
const mkJob = (id) => ({
    id,
    title: 'Backend Engineer',
    companyName: 'Co',
    jobLocation: 'Remote',
    description: 'full description',
    applyUrl: `https://co/${id}`,
});

const ok = (value) => ({ ok: true, value });
const err = (code, message, extras = {}) => ({
    ok: false,
    error: { code, message, ...extras },
});

// fakeDashboard: pushJob implementation is a per-test script. Tracks calls.
function makeDashboard({ handler }) {
    const calls = [];
    return {
        calls,
        async pushJob(args) {
            calls.push(args);
            return handler(args, calls.length);
        },
    };
}

// ------------------ validation -----------------------------------------

test('BAD_INPUT: missing dashboard', async () => {
    const r = await runPush({ clientEmail: 'a@b.com', jobs: [] });
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('BAD_INPUT: invalid clientEmail', async () => {
    const r = await runPush({
        dashboard: makeDashboard({ handler: () => ok({ outcome: 'created' }) }),
        clientEmail: 'nope',
        jobs: [],
    });
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('BAD_INPUT: non-array jobs', async () => {
    const r = await runPush({
        dashboard: makeDashboard({ handler: () => ok({}) }),
        clientEmail: 'a@b.com',
        jobs: 'nope',
    });
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('BAD_INPUT: concurrency out of range', async () => {
    const d = makeDashboard({ handler: () => ok({ outcome: 'created' }) });
    const r1 = await runPush({ dashboard: d, clientEmail: 'a@b.com', jobs: [], concurrency: 0 });
    const r2 = await runPush({ dashboard: d, clientEmail: 'a@b.com', jobs: [], concurrency: 6 });
    assert.equal(r1.error.code, 'BAD_INPUT');
    assert.equal(r2.error.code, 'BAD_INPUT');
});

// ------------------ classification -------------------------------------

test('classifies created → pushed bucket with createdJobId', async () => {
    const dashboard = makeDashboard({
        handler: () => ok({ outcome: 'created', createdJobId: 'dj-1' }),
    });
    const r = await runPush({
        dashboard,
        clientEmail: 'a@b.com',
        jobs: [mkJob('j1')],
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.pushed.length, 1);
    assert.equal(r.value.pushed[0].createdJobId, 'dj-1');
    assert.equal(r.value.pushed[0].code, 'CREATED');
});

test('classifies outcome=duplicate → duplicates bucket', async () => {
    const dashboard = makeDashboard({
        handler: () => ok({ outcome: 'duplicate' }),
    });
    const r = await runPush({
        dashboard,
        clientEmail: 'a@b.com',
        jobs: [mkJob('j1')],
    });
    assert.equal(r.value.duplicates.length, 1);
});

test('classifies outcome=dry-run → pushed bucket w/ DRY_RUN code', async () => {
    const dashboard = makeDashboard({
        handler: () => ok({ outcome: 'dry-run', payload: { ok: true } }),
    });
    const r = await runPush({
        dashboard,
        clientEmail: 'a@b.com',
        jobs: [mkJob('j1')],
    });
    assert.equal(r.value.pushed.length, 1);
    assert.equal(r.value.pushed[0].code, 'DRY_RUN');
});

test('classifies BLOCKED_COMPANY → blocked bucket', async () => {
    const dashboard = makeDashboard({
        handler: () => err('BLOCKED_COMPANY', 'Blocked by exclusion'),
    });
    const r = await runPush({
        dashboard,
        clientEmail: 'a@b.com',
        jobs: [mkJob('j1')],
    });
    assert.equal(r.value.blocked.length, 1);
    assert.equal(r.value.blocked[0].code, 'BLOCKED_COMPANY');
});

test('classifies BLOCKED_LOCATION → blocked bucket', async () => {
    const dashboard = makeDashboard({
        handler: () => err('BLOCKED_LOCATION', 'Blocked loc'),
    });
    const r = await runPush({
        dashboard,
        clientEmail: 'a@b.com',
        jobs: [mkJob('j1')],
    });
    assert.equal(r.value.blocked.length, 1);
});

test('classifies CLIENT_LOCKED → blocked bucket', async () => {
    const dashboard = makeDashboard({
        handler: () => err('CLIENT_LOCKED', 'locked'),
    });
    const r = await runPush({
        dashboard,
        clientEmail: 'a@b.com',
        jobs: [mkJob('j1')],
    });
    assert.equal(r.value.blocked.length, 1);
});

test('classifies NETWORK / BAD_STATUS → errors bucket', async () => {
    const dashboard = makeDashboard({
        handler: (_args, n) =>
            n === 1 ? err('NETWORK', 'fetch failed') : err('BAD_STATUS', 'boom'),
    });
    const r = await runPush({
        dashboard,
        clientEmail: 'a@b.com',
        jobs: [mkJob('j1'), mkJob('j2')],
    });
    assert.equal(r.value.errors.length, 2);
});

test('classifies unknown outcome → errors with UNKNOWN_OUTCOME', async () => {
    const dashboard = makeDashboard({
        handler: () => ok({ outcome: 'weird' }),
    });
    const r = await runPush({
        dashboard,
        clientEmail: 'a@b.com',
        jobs: [mkJob('j1')],
    });
    assert.equal(r.value.errors.length, 1);
    assert.equal(r.value.errors[0].code, 'UNKNOWN_OUTCOME');
});

test('thrown exception during pushJob → errors bucket with code=THREW', async () => {
    const dashboard = {
        async pushJob() {
            throw new Error('boom');
        },
    };
    const r = await runPush({
        dashboard,
        clientEmail: 'a@b.com',
        jobs: [mkJob('j1')],
    });
    assert.equal(r.value.errors.length, 1);
    assert.equal(r.value.errors[0].code, 'THREW');
});

// ------------------ payload mapping + concurrency ----------------------

test('calls dashboard.pushJob with toDashboardJob payload + correct email', async () => {
    const dashboard = makeDashboard({ handler: () => ok({ outcome: 'created', createdJobId: 'x' }) });
    await runPush({
        dashboard,
        clientEmail: 'client@co.com',
        clientName: 'Client',
        jobs: [mkJob('j1')],
    });
    const call = dashboard.calls[0];
    assert.equal(call.clientEmail, 'client@co.com');
    assert.equal(call.clientName, 'Client');
    // toDashboardJob shape (Phase 9 contract):
    assert.deepEqual(Object.keys(call.job).sort(), [
        'companyName',
        'jobDescription',
        'jobLocation',
        'jobTitle',
        'joblink',
    ]);
});

test('respects concurrency cap — at most N parallel invocations', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const dashboard = {
        async pushJob() {
            inflight += 1;
            if (inflight > maxInflight) maxInflight = inflight;
            await new Promise((r) => setTimeout(r, 15));
            inflight -= 1;
            return ok({ outcome: 'created', createdJobId: 'x' });
        },
    };
    const jobs = Array.from({ length: 6 }, (_, i) => mkJob(`j${i}`));
    await runPush({
        dashboard,
        clientEmail: 'a@b.com',
        jobs,
        concurrency: 2,
    });
    assert.ok(maxInflight <= 2, `expected ≤2 inflight, saw ${maxInflight}`);
    assert.ok(maxInflight >= 1);
});

test('mixed outcomes aggregate into correct buckets + stats', async () => {
    let n = 0;
    const dashboard = {
        async pushJob() {
            n += 1;
            if (n === 1) return ok({ outcome: 'created', createdJobId: 'a' });
            if (n === 2) return ok({ outcome: 'duplicate' });
            if (n === 3) return err('BLOCKED_COMPANY', 'blocked');
            if (n === 4) return err('NETWORK', 'down');
            return ok({ outcome: 'created', createdJobId: 'e' });
        },
    };
    const jobs = Array.from({ length: 5 }, (_, i) => mkJob(`j${i}`));
    const r = await runPush({ dashboard, clientEmail: 'a@b.com', jobs });
    assert.equal(r.value.pushed.length, 2);
    assert.equal(r.value.duplicates.length, 1);
    assert.equal(r.value.blocked.length, 1);
    assert.equal(r.value.errors.length, 1);
    assert.equal(r.value.stats.total, 5);
    assert.equal(r.value.stats.durationMs >= 0, true);
});

test('empty jobs → empty buckets + no dashboard calls', async () => {
    const dashboard = makeDashboard({ handler: () => ok({ outcome: 'created' }) });
    const r = await runPush({ dashboard, clientEmail: 'a@b.com', jobs: [] });
    assert.equal(r.ok, true);
    assert.equal(r.value.stats.total, 0);
    assert.equal(dashboard.calls.length, 0);
});
