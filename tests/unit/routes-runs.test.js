// Routes for /api/runs. The runs service is stubbed via a pipelineImpl
// that just drives state transitions synchronously — no Playwright, no AI.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server.js';
import { createRunsService } from '../../src/services/runner/index.js';
import { PHASES } from '../../src/services/runner/state.js';

const ok = (v) => ({ ok: true, value: v });
const err = (code, message) => ({ ok: false, error: { code, message } });

function baseContainerStubs() {
    return {
        env: {},
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        dashboard: {
            listClients: async () => ok({ clients: [], count: 0 }),
            getProfile: async () => ok({ profile: {}, removedJobsCount: 0 }),
            getExclusions: async () =>
                ok({ excludedCompanies: [], excludedLocations: [] }),
            pushJob: async () => ok({ outcome: 'created', createdJobId: 'x' }),
        },
        resume: { getByEmail: async () => ok({ found: false, reason: 'no-resume' }) },
        ai: null,
        summariser: async () => err('NO_OPENAI_KEY', ''),
        session: {
            probeSession: async () => ok({ loggedIn: false, status: 0 }),
            ensureLoggedIn: async () => ok({ action: 'noop' }),
        },
    };
}

async function buildSrv({ pipelineImpl, runsDir } = {}) {
    const container = baseContainerStubs();
    container.runs = createRunsService({
        container,
        runsDir,
        logger: container.logger,
        pipelineImpl:
            pipelineImpl
            || (async ({ store, runId }) => {
                // Drive a simple happy path so we get consistent state for tests.
                store.update(runId, { phase: PHASES.LOADING_PROFILE });
                store.update(runId, { phase: PHASES.DONE, picks: [{ jobId: 'j1' }] });
            }),
    });
    const app = buildApp({ container });
    const server = createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => server.close(() => r())),
                container,
            });
        });
    });
}

test('POST /api/runs starts a run and returns 201 + runId', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'scraper-runs-'));
    const srv = await buildSrv({ runsDir });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });

    const res = await fetch(`${srv.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEmail: 'a@b.com', count: 5 }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.run.id);
    assert.equal(body.run.clientEmail, 'a@b.com');
    assert.equal(body.run.requestedCount, 5);
});

test('POST /api/runs rejects missing clientEmail', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'scraper-runs-'));
    const srv = await buildSrv({ runsDir });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    const res = await fetch(`${srv.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count: 5 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'BAD_INPUT');
});

test('POST /api/runs rejects invalid count', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'scraper-runs-'));
    const srv = await buildSrv({ runsDir });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    const res = await fetch(`${srv.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEmail: 'a@b.com', count: 200 }),
    });
    assert.equal(res.status, 400);
});

test('GET /api/runs lists runs', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'scraper-runs-'));
    const srv = await buildSrv({ runsDir });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    await fetch(`${srv.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEmail: 'a@b.com', count: 3 }),
    });
    const res = await fetch(`${srv.url}/api/runs`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.runs.length >= 1);
});

test('GET /api/runs/:id returns full run or 404', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'scraper-runs-'));
    const srv = await buildSrv({ runsDir });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    const created = await (await fetch(`${srv.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEmail: 'a@b.com', count: 3 }),
    })).json();
    const gotRes = await fetch(`${srv.url}/api/runs/${created.run.id}`);
    assert.equal(gotRes.status, 200);
    const got = await gotRes.json();
    assert.equal(got.run.clientEmail, 'a@b.com');

    const missRes = await fetch(`${srv.url}/api/runs/nope`);
    assert.equal(missRes.status, 404);
});

test('POST /api/runs/:id/resume spawns a new run from a failed one', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'scraper-runs-'));
    // Pipeline records how each run was invoked so we can assert the
    // resume carried state forward.
    const calls = [];
    const srv = await buildSrv({
        runsDir,
        pipelineImpl: async ({ store, runId, resumeFrom }) => {
            calls.push({ runId, resumeFrom });
            if (calls.length === 1) {
                // First run fails after recording some progress.
                store.update(runId, {
                    phase: PHASES.FAILED,
                    error: { code: 'RATE_LIMITED', message: 'boom' },
                    picks: [{ jobId: 'a' }, { jobId: 'b' }],
                    progress: {
                        intent: { roles: ['SWE'] },
                        seenJrIds: ['a', 'b', 'c'],
                    },
                });
            } else {
                store.update(runId, { phase: PHASES.DONE, picks: [] });
            }
        },
    });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });

    const first = await (await fetch(`${srv.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEmail: 'a@b.com', count: 5 }),
    })).json();

    // Wait for the first run to land in 'failed'.
    for (let i = 0; i < 40; i += 1) {
        const cur = await (await fetch(`${srv.url}/api/runs/${first.run.id}`)).json();
        if (cur.run.phase === 'failed') break;
        await new Promise((r) => setTimeout(r, 10));
    }

    const res = await fetch(`${srv.url}/api/runs/${first.run.id}/resume`, {
        method: 'POST',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.run.resumedFrom, first.run.id);
    assert.equal(body.run.requestedCount, 3); // 5 - 2 already pushed

    // Second pipeline call must have received the carried state.
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].resumeFrom.seenJrIds, ['a', 'b', 'c']);
    assert.equal(calls[1].resumeFrom.prevRunId, first.run.id);
    assert.equal(calls[1].resumeFrom.prevPushed, 2);
});

test('POST /api/runs/:id/resume 400s when run is not failed', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'scraper-runs-'));
    const srv = await buildSrv({ runsDir });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    const first = await (await fetch(`${srv.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEmail: 'a@b.com', count: 1 }),
    })).json();
    // default pipelineImpl drives to DONE — wait for it.
    for (let i = 0; i < 40; i += 1) {
        const cur = await (await fetch(`${srv.url}/api/runs/${first.run.id}`)).json();
        if (cur.run.phase === 'done') break;
        await new Promise((r) => setTimeout(r, 10));
    }
    const res = await fetch(`${srv.url}/api/runs/${first.run.id}/resume`, {
        method: 'POST',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'BAD_INPUT');
});

test('POST /api/runs/:id/resume 404s for unknown run', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'scraper-runs-'));
    const srv = await buildSrv({ runsDir });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    const res = await fetch(`${srv.url}/api/runs/nope/resume`, { method: 'POST' });
    assert.equal(res.status, 404);
});

test('POST /api/runs/:id/abort flips abortRequested', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'scraper-runs-'));
    // Pipeline that stays paused so we can abort mid-flight
    let release;
    const wait = new Promise((r) => (release = r));
    const srv = await buildSrv({
        runsDir,
        pipelineImpl: async ({ store, runId }) => {
            store.update(runId, { phase: PHASES.SEARCHING });
            await wait;
            store.update(runId, { phase: PHASES.DONE });
        },
    });
    after(async () => {
        release();
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    const created = await (await fetch(`${srv.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEmail: 'a@b.com', count: 3 }),
    })).json();
    const abortRes = await fetch(`${srv.url}/api/runs/${created.run.id}/abort`, {
        method: 'POST',
    });
    assert.equal(abortRes.status, 200);
    const abortBody = await abortRes.json();
    assert.equal(abortBody.run.abortRequested, true);
});

test('GET /api/runs/:id/events streams state via SSE', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'scraper-runs-'));
    let release;
    const wait = new Promise((r) => (release = r));
    const srv = await buildSrv({
        runsDir,
        pipelineImpl: async ({ store, runId }) => {
            store.update(runId, { phase: PHASES.SEARCHING });
            await wait;
            store.update(runId, { phase: PHASES.DONE });
        },
    });
    after(async () => {
        release();
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    const created = await (await fetch(`${srv.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEmail: 'a@b.com', count: 3 }),
    })).json();

    // Connect SSE
    const sseRes = await fetch(`${srv.url}/api/runs/${created.run.id}/events`);
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type'), /event-stream/);

    // Release the pipeline — should push one more state event then end.
    release();

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let payload = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        payload += decoder.decode(value);
        if (payload.includes(`"phase":"${PHASES.DONE}"`)) break;
    }
    assert.match(payload, /event: state/);
    assert.match(payload, new RegExp(`"phase":"${PHASES.DONE}"`));
});

test('GET /api/runs/:id/events returns 404 for unknown run', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'scraper-runs-'));
    const srv = await buildSrv({ runsDir });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    const res = await fetch(`${srv.url}/api/runs/nope/events`);
    assert.equal(res.status, 404);
});
