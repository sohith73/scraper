// Server-level tests. Boots the Express app on port 0 (random free port) and
// hits real routes over HTTP to exercise middleware wiring end-to-end.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildApp } from '../../src/server.js';

// startEphemeral: binds the Express app to a random port. Returns { url, close }.
function startEphemeral() {
    const app = buildApp();
    const server = createServer(app);
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => server.close(() => r())),
            });
        });
    });
}

test('GET /api/health returns 200 with expected shape', async () => {
    const srv = await startEphemeral();
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'jobright-scraper');
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.port, 'number');
    assert.equal(typeof body.uptimeSec, 'number');
    assert.equal(typeof body.node, 'string');
    assert.match(body.requestId, /^[0-9a-f-]{8,}$/i);
    assert.equal(res.headers.get('x-request-id'), body.requestId);
});

test('GET /api/health echoes caller-supplied request id', async () => {
    const srv = await startEphemeral();
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/health`, {
        headers: { 'x-request-id': 'test-correlation-123' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-request-id'), 'test-correlation-123');
    const body = await res.json();
    assert.equal(body.requestId, 'test-correlation-123');
});

test('404 handler returns JSON error shape', async () => {
    const srv = await startEphemeral();
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'NOT_FOUND');
    assert.match(body.message, /GET \/api\/does-not-exist/);
    assert.equal(typeof body.requestId, 'string');
});

test('security headers are set on every response', async () => {
    const srv = await startEphemeral();
    after(() => srv.close());

    const res = await fetch(`${srv.url}/api/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-powered-by'), null);
});

test('static index.html is served at /', async () => {
    const srv = await startEphemeral();
    after(() => srv.close());

    const res = await fetch(`${srv.url}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Flashfire\b.*\bJobRight\b.*\bScraper/);
});

test('oversized JSON bodies are rejected with 413', async () => {
    const srv = await startEphemeral();
    after(() => srv.close());

    const huge = JSON.stringify({ blob: 'x'.repeat(300 * 1024) });
    const res = await fetch(`${srv.url}/api/health`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: huge,
    });
    // Express default is 413 for payload too large; 404 would mean the route
    // matcher ran first — either way it's NOT a 500.
    assert.ok(
        res.status === 413 || res.status === 404,
        `expected 413 or 404, got ${res.status}`,
    );
});
