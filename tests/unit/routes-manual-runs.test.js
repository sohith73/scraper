// Routes for /api/manual-runs.

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

function baseStubs() {
    return {
        env: {},
        logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {} },
        dashboard: {
            listClients: async () => ok({ clients: [], count: 0 }),
            getProfile: async () => ok({ profile: {}, removedJobsCount: 0 }),
            getExclusions: async () => ok({ excludedCompanies: [], excludedLocations: [] }),
            pushJob: async () => ok({ outcome: 'created', createdJobId: 'x' }),
        },
        resume: { getByEmail: async () => ok({ found: false, reason: 'no-resume' }) },
        ai: null,
        summariser: async () => ({ ok: false, error: { code: 'NO_OPENAI_KEY', message: '' } }),
        session: { probeSession: async () => ok({ loggedIn: false, status: 0 }) },
    };
}

async function buildSrv({ runsDir } = {}) {
    const container = baseStubs();
    container.runs = createRunsService({
        container,
        runsDir,
        logger: container.logger,
        manualPipelineImpl: async ({ store, runId }) => {
            store.update(runId, { phase: PHASES.SEARCHING });
            store.update(runId, { phase: PHASES.DONE, picks: [{ jobId: 'p1' }] });
        },
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

test('POST /api/manual-runs starts a run and returns 201', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-routes-'));
    const srv = await buildSrv({ runsDir });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    const res = await fetch(`${srv.url}/api/manual-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            clientEmail: 'a@b.com',
            clientName: 'A',
            capturedJobs: [
                { jobResult: { jobId: 'j1' }, companyResult: { companyName: 'X' } },
            ],
        }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.run.id);
    assert.equal(body.run.clientEmail, 'a@b.com');
});

test('POST /api/manual-runs rejects missing clientEmail', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-routes-'));
    const srv = await buildSrv({ runsDir });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    const res = await fetch(`${srv.url}/api/manual-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capturedJobs: [{ jobResult: { jobId: 'j1' } }] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'BAD_INPUT');
});

test('POST /api/manual-runs rejects empty capturedJobs', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-routes-'));
    const srv = await buildSrv({ runsDir });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    const res = await fetch(`${srv.url}/api/manual-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEmail: 'a@b.com', capturedJobs: [] }),
    });
    assert.equal(res.status, 400);
});

test('POST /api/manual-runs accepts a chrome-extension origin', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-routes-'));
    const srv = await buildSrv({ runsDir });
    after(async () => {
        await srv.close();
        await rm(runsDir, { recursive: true, force: true });
    });
    const res = await fetch(`${srv.url}/api/manual-runs`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            origin: 'chrome-extension://abc123def456',
        },
        body: JSON.stringify({
            clientEmail: 'a@b.com',
            capturedJobs: [
                { jobResult: { jobId: 'j1' }, companyResult: { companyName: 'X' } },
            ],
        }),
    });
    assert.equal(res.status, 201);
    assert.equal(
        res.headers.get('access-control-allow-origin'),
        'chrome-extension://abc123def456',
    );
});

test('runsService.startManual: requires non-empty array', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-svc-'));
    after(() => rm(runsDir, { recursive: true, force: true }));
    const container = baseStubs();
    const runs = createRunsService({
        container,
        runsDir,
        manualPipelineImpl: async () => {},
    });
    assert.throws(
        () => runs.startManual({ clientEmail: 'a@b.com', capturedJobs: [] }),
        /non-empty/,
    );
    assert.throws(
        () => runs.startManual({ clientEmail: 'a@b.com', capturedJobs: 'not-array' }),
        /non-empty/,
    );
    assert.throws(
        () => runs.startManual({ capturedJobs: [{}] }),
        /clientEmail/,
    );
});

test('runsService.startManual: caps at 1000 jobs', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-svc-'));
    after(() => rm(runsDir, { recursive: true, force: true }));
    const container = baseStubs();
    const runs = createRunsService({
        container, runsDir, manualPipelineImpl: async () => {},
    });
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({ jobResult: { jobId: `j${i}` } }));
    assert.throws(
        () => runs.startManual({ clientEmail: 'a@b.com', capturedJobs: tooMany }),
        /1000/,
    );
});
