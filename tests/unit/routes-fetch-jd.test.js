import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildApp } from '../../src/server.js';

function makeContainer(overrides = {}) {
    return {
        env: {},
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        dashboard: {
            listClients: async () => ({ ok: true, value: { clients: [], count: 0 } }),
            getProfile: async () => ({ ok: true, value: { profile: {}, removedJobsCount: 0 } }),
            getExclusions: async () => ({ ok: true, value: { excludedCompanies: [], excludedLocations: [] } }),
            pushJob: async () => ({ ok: true, value: { outcome: 'created' } }),
        },
        resume: { getByEmail: async () => ({ ok: true, value: { found: false } }) },
        summariser: async () => ({ ok: false, error: { code: 'NO_OPENAI_KEY', message: 'no key' } }),
        session: {
            probeSession: async () => ({ ok: true, value: { loggedIn: false, status: 0 } }),
            ensureLoggedIn: async () => ({ ok: true, value: { action: 'noop' } }),
        },
        runs: {
            start: () => ({ id: 'r1' }),
            get: () => null,
            list: () => [],
            subscribe: () => () => {},
            abort: () => null,
            runDir: () => '/tmp',
        },
        jdFetcher: {
            fetchJobDetail: async (url) => ({
                ok: true,
                description: `JD for ${url}`,
                mainJd: `JD for ${url}`,
                jobDescription: `JD for ${url}`,
                location: 'San Francisco, CA',
                country: 'United States',
                provider: 'greenhouse',
                method: 'greenhouse',
                confidence: 88,
                finalUrl: url,
                durationMs: 12,
            }),
        },
        ...overrides,
    };
}

async function startEphemeral(container = makeContainer()) {
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

test('GET /extract/infor=<encoded url> returns main JD metadata', async () => {
    const srv = await startEphemeral();
    after(() => srv.close());

    const jobUrl = 'https://job-boards.greenhouse.io/embed/job_app?for=cclim&token=4223755009';
    const res = await fetch(`${srv.url}/extract/infor=${encodeURIComponent(jobUrl)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.ok, true);
    assert.equal(body.mainJd, `JD for ${jobUrl}`);
    assert.equal(body.jobDescription, `JD for ${jobUrl}`);
    assert.equal(body.country, 'United States');
    assert.equal(body.provider, 'greenhouse');
    assert.equal(body.finalUrl, jobUrl);
});

test('POST /api/extract/infor accepts url in JSON body', async () => {
    const srv = await startEphemeral();
    after(() => srv.close());

    const jobUrl = 'https://jobs.ashbyhq.com/remarcable-inc/fd2d5812-97bc-4eb4-8d7c-a5eb032a11b7';
    const res = await fetch(`${srv.url}/api/extract/infor`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: jobUrl }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.mainJd, `JD for ${jobUrl}`);
    assert.equal(body.provider, 'greenhouse');
});
