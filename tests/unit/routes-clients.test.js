// Route tests for src/routes/clients.js. Every test injects a fake
// container so the router runs against deterministic Results — no Mongo,
// no OpenAI, no network.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildApp } from '../../src/server.js';

// Re-implementation of ok/err (can't import via alias here without ESM tricks).
const ok = (value) => ({ ok: true, value });
const err = (code, message, extras = {}) => ({
    ok: false,
    error: { code, message, ...extras },
});

// makeContainer: returns a frozen container shape matching buildContainer's
// contract. `overrides` replaces any default entry.
function makeContainer(overrides = {}) {
    const defaults = {
        env: { DRY_RUN: false },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        dashboard: {
            listClients: async () => ok({ clients: [], count: 0 }),
            getProfile: async () => ok({ profile: {}, removedJobsCount: 0 }),
            getExclusions: async () =>
                ok({ excludedCompanies: [], excludedLocations: [] }),
            updateExclusions: async (args) =>
                ok({ excludedCompanies: args.companies || [], excludedLocations: args.locations || [] }),
            pushJob: async () => ok({ outcome: 'created', createdJobId: 'x' }),
        },
        resume: {
            getByEmail: async () => ok({ found: false, reason: 'no-resume' }),
        },
        ai: null,
        summariser: async () => err('NO_OPENAI_KEY', 'no key'),
        session: {
            probeSession: async () => ok({ loggedIn: false, status: 0 }),
            ensureLoggedIn: async () => ok({ action: 'noop' }),
        },
        runs: {
            start: () => ({ id: 'r1' }),
            get: () => null,
            list: () => [],
            subscribe: () => () => {},
            abort: () => null,
            runDir: () => '/tmp',
        },
    };
    return { ...defaults, ...overrides };
}

async function startEphemeral(container) {
    const app = buildApp({ container });
    const server = createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => server.close(() => r())),
            });
        });
    });
}

// ------------------ GET /api/clients -----------------------------------

test('GET /api/clients returns the list', async () => {
    const container = makeContainer({
        dashboard: {
            ...makeContainer().dashboard,
            listClients: async () =>
                ok({
                    clients: [{ email: 'a@b.com', name: 'A' }],
                    count: 1,
                }),
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.count, 1);
    assert.equal(body.clients[0].email, 'a@b.com');
    assert.match(body.requestId, /^[0-9a-f-]+$/i);
});

test('GET /api/clients surfaces BAD_STATUS as 502', async () => {
    const container = makeContainer({
        dashboard: {
            ...makeContainer().dashboard,
            listClients: async () => err('BAD_STATUS', 'dashboard 500'),
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'BAD_STATUS');
});

test('GET /api/clients surfaces NETWORK as 502', async () => {
    const container = makeContainer({
        dashboard: {
            ...makeContainer().dashboard,
            listClients: async () => err('NETWORK', 'ECONNREFUSED'),
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients`);
    assert.equal(res.status, 502);
});

// ------------------ GET /api/clients/:email/profile --------------------

test('GET /api/clients/:email/profile rejects malformed email', async () => {
    const srv = await startEphemeral(makeContainer());
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients/not-an-email/profile`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'BAD_INPUT');
});

test('GET /api/clients/:email/profile returns profile + exclusions', async () => {
    const container = makeContainer({
        dashboard: {
            ...makeContainer().dashboard,
            getProfile: async () =>
                ok({
                    profile: { firstName: 'Alice', preferredRoles: ['BE'] },
                    removedJobsCount: 2,
                }),
            getExclusions: async () =>
                ok({ excludedCompanies: ['acme'], excludedLocations: [] }),
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients/alice%40co.com/profile`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.profile.firstName, 'Alice');
    assert.equal(body.removedJobsCount, 2);
    assert.deepEqual(body.exclusions.excludedCompanies, ['acme']);
});

test('GET profile: getProfile 404 maps to HTTP 404', async () => {
    const container = makeContainer({
        dashboard: {
            ...makeContainer().dashboard,
            getProfile: async () => err('NOT_FOUND', 'no profile'),
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients/a@b.com/profile`);
    assert.equal(res.status, 404);
});

test('GET profile: exclusion failure does not hide the profile', async () => {
    const container = makeContainer({
        dashboard: {
            ...makeContainer().dashboard,
            getProfile: async () =>
                ok({ profile: { firstName: 'A' }, removedJobsCount: 0 }),
            getExclusions: async () => err('NETWORK', 'boom'),
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients/a@b.com/profile`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.profile.firstName, 'A');
    assert.deepEqual(body.exclusions, {
        excludedCompanies: [],
        excludedLocations: [],
    });
});

// ------------------ POST /api/clients/:email/summary -------------------

test('POST summary: happy path returns intent', async () => {
    const intent = {
        roles: ['BE'],
        locations: ['Remote'],
        seniority: 'senior',
        companies: [],
        workAuth: 'US citizen',
        narrative: 'n',
        futurePreferences: '',
        exclusions: { companies: [], locations: [] },
    };
    const container = makeContainer({
        dashboard: {
            ...makeContainer().dashboard,
            getProfile: async () =>
                ok({ profile: { firstName: 'A' }, removedJobsCount: 0 }),
            getExclusions: async () =>
                ok({ excludedCompanies: [], excludedLocations: [] }),
        },
        resume: {
            getByEmail: async () => ok({ found: true, resume: { summary: 'x' } }),
        },
        summariser: async (args) =>
            ok({ intent, cacheHit: false, key: 'abc' }),
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients/a@b.com/summary`, {
        method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.cacheHit, false);
    assert.equal(body.resumeFound, true);
    assert.equal(body.intent.seniority, 'senior');
});

test('POST summary: surfaces NO_OPENAI_KEY as 503', async () => {
    // default summariser returns NO_OPENAI_KEY. Resume presence required
    // now so the summariser is actually reached.
    const container = makeContainer({
        resume: {
            getByEmail: async () => ok({ found: true, resume: { summary: 'x' } }),
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients/a@b.com/summary`, {
        method: 'POST',
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'NO_OPENAI_KEY');
});

test('POST summary: RATE_LIMITED maps to 429', async () => {
    const container = makeContainer({
        resume: {
            getByEmail: async () => ok({ found: true, resume: { summary: 'x' } }),
        },
        summariser: async () => err('RATE_LIMITED', 'slow down'),
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients/a@b.com/summary`, {
        method: 'POST',
    });
    assert.equal(res.status, 429);
});

test('POST summary: missing resume → 422 RESUME_MISSING (before AI call)', async () => {
    let aiCalled = false;
    const container = makeContainer({
        dashboard: {
            ...makeContainer().dashboard,
            getProfile: async () =>
                ok({ profile: { firstName: 'A' }, removedJobsCount: 0 }),
        },
        resume: {
            getByEmail: async () => ok({ found: false, reason: 'no-resume' }),
        },
        summariser: async () => {
            aiCalled = true;
            return ok({ intent: {}, cacheHit: false, key: '' });
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients/a@b.com/summary`, {
        method: 'POST',
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'RESUME_MISSING');
    assert.match(body.message, /gemini-resume/i);
    assert.equal(aiCalled, false);
});

test('POST summary: missing profile 404s before AI call', async () => {
    let aiCalled = false;
    const container = makeContainer({
        dashboard: {
            ...makeContainer().dashboard,
            getProfile: async () => err('NOT_FOUND', 'no profile'),
        },
        summariser: async () => {
            aiCalled = true;
            return ok({ intent: {}, cacheHit: false, key: '' });
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients/a@b.com/summary`, {
        method: 'POST',
    });
    assert.equal(res.status, 404);
    assert.equal(aiCalled, false);
});

// ------------------ Feedback routes ------------------------------------

test('POST /api/clients/:email/feedback appends + echos entry', async () => {
    const events = [];
    const container = makeContainer({
        feedback: {
            append: async (email, body) => {
                events.push({ email, body });
                return { id: 'fb-1', ...body, ts: 't' };
            },
            list: async () => [],
            remove: async () => false,
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients/a@b.com/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            jobId: 'j1',
            title: 'Senior PM',
            company: 'Acme',
            verdict: 'bad_pick',
            aiPick: true,
            aiScore: 65,
            aiReason: 'adjacent role',
        }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.entry.id, 'fb-1');
    assert.equal(events.length, 1);
    assert.equal(events[0].email, 'a@b.com');
    assert.equal(events[0].body.verdict, 'bad_pick');
});

test('POST feedback surfaces verdict errors as 400', async () => {
    const container = makeContainer({
        feedback: {
            append: async () => {
                throw new Error('verdict must be one of bad_pick|good_pick|bad_skip|good_skip');
            },
            list: async () => [],
            remove: async () => false,
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());
    const res = await fetch(`${srv.url}/api/clients/a@b.com/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: 'j1', verdict: 'whatever' }),
    });
    assert.equal(res.status, 400);
});

test('GET feedback returns entries from the store', async () => {
    const container = makeContainer({
        feedback: {
            append: async () => ({}),
            list: async () => [{ id: '1', jobId: 'j1', verdict: 'bad_pick' }],
            remove: async () => false,
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());
    const res = await fetch(`${srv.url}/api/clients/a@b.com/feedback`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].verdict, 'bad_pick');
});

test('DELETE feedback/:id proxies to store.remove', async () => {
    let removedId = null;
    const container = makeContainer({
        feedback: {
            append: async () => ({}),
            list: async () => [],
            remove: async (email, id) => { removedId = id; return true; },
        },
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());
    const res = await fetch(`${srv.url}/api/clients/a@b.com/feedback/abc-id`, {
        method: 'DELETE',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.removed, true);
    assert.equal(removedId, 'abc-id');
});

test('POST summary: cacheHit propagates when resume is attached', async () => {
    const intent = {
        roles: [],
        locations: [],
        seniority: 'mid',
        companies: [],
        workAuth: '',
        narrative: '',
        futurePreferences: '',
        exclusions: { companies: [], locations: [] },
    };
    const container = makeContainer({
        dashboard: {
            ...makeContainer().dashboard,
            getProfile: async () =>
                ok({ profile: { firstName: 'A' }, removedJobsCount: 0 }),
        },
        resume: {
            getByEmail: async () => ok({ found: true, resume: { summary: 'x' } }),
        },
        summariser: async () => ok({ intent, cacheHit: true, key: 'k' }),
    });
    const srv = await startEphemeral(container);
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/clients/a@b.com/summary`, {
        method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resumeFound, true);
    assert.equal(body.cacheHit, true);
});
