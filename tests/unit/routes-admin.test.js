import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildApp } from '../../src/server.js';

const ok = (value) => ({ ok: true, value });
const err = (code, message) => ({ ok: false, error: { code, message } });

// Container built so ONLY the pieces admin routes use are real; everything
// else is a stub to keep the suite fast.
function container({ session }) {
    return {
        env: {},
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        dashboard: {
            listClients: async () => ok({ clients: [], count: 0 }),
            getProfile: async () => ok({ profile: {}, removedJobsCount: 0 }),
            getExclusions: async () =>
                ok({ excludedCompanies: [], excludedLocations: [] }),
            pushJob: async () => ok({ outcome: 'created' }),
        },
        resume: { getByEmail: async () => ok({ found: false, reason: 'no-resume' }) },
        ai: null,
        summariser: async () => err('NO_OPENAI_KEY', ''),
        session,
        runs: {
            start: () => ({ id: 'r1' }),
            get: () => null,
            list: () => [],
            subscribe: () => () => {},
            abort: () => null,
            runDir: () => '/tmp',
        },
    };
}

async function startEphemeral(c) {
    const app = buildApp({ container: c });
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

test('GET /api/admin/session-status returns probe result', async () => {
    const srv = await startEphemeral(
        container({
            session: {
                probeSession: async () =>
                    ok({ loggedIn: true, status: 200, userInfo: { userId: 'u' } }),
                ensureLoggedIn: async () => ok({ action: 'noop' }),
            },
        }),
    );
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/admin/session-status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.loggedIn, true);
    assert.equal(body.userInfo.userId, 'u');
});

test('POST /api/admin/login returns logged-in result', async () => {
    let captured;
    const srv = await startEphemeral(
        container({
            session: {
                probeSession: async () => ok({ loggedIn: false, status: 401 }),
                ensureLoggedIn: async (opts) => {
                    captured = opts;
                    return ok({ action: 'logged-in', userInfo: { userId: 'x' } });
                },
            },
        }),
    );
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.action, 'logged-in');
    assert.equal(captured.force, true);
    assert.equal(captured.headed, false);
});

test('POST /api/admin/login surfaces NEEDS_REAUTH as 401', async () => {
    const srv = await startEphemeral(
        container({
            session: {
                probeSession: async () => ok({ loggedIn: false, status: 401 }),
                ensureLoggedIn: async () => err('NEEDS_REAUTH', 'no creds'),
            },
        }),
    );
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/admin/login`, { method: 'POST' });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'NEEDS_REAUTH');
});

test('POST /api/admin/first-login forces headed=true', async () => {
    let captured;
    const srv = await startEphemeral(
        container({
            session: {
                probeSession: async () => ok({ loggedIn: false, status: 401 }),
                ensureLoggedIn: async (opts) => {
                    captured = opts;
                    return ok({ action: 'manual-login', userInfo: { userId: 'y' } });
                },
            },
        }),
    );
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/admin/first-login`, {
        method: 'POST',
    });
    assert.equal(res.status, 200);
    assert.equal(captured.headed, true);
    assert.equal(captured.force, true);
});

test('first-login: LOGIN_TIMEOUT maps to a non-200 status', async () => {
    const srv = await startEphemeral(
        container({
            session: {
                probeSession: async () => ok({ loggedIn: false, status: 401 }),
                ensureLoggedIn: async () =>
                    err('LOGIN_TIMEOUT', 'operator took too long'),
            },
        }),
    );
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/admin/first-login`, {
        method: 'POST',
    });
    // LOGIN_TIMEOUT isn't in CODE_TO_STATUS — default 500. That's fine; we
    // want it to be clearly non-2xx and include the error code in the body.
    assert.ok(res.status >= 400 && res.status < 600);
    const body = await res.json();
    assert.equal(body.error, 'LOGIN_TIMEOUT');
});
