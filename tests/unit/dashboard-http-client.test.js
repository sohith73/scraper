// Unit tests for createHttpClient. All tests inject a fake fetch;
// nothing hits the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createHttpClient,
    HttpError,
} from '../../src/clients/common/httpClient.js';

// makeResponse: minimal fetch-like Response good enough for our client.
function makeResponse({ status = 200, json, text, headers = {} } = {}) {
    const bodyText = text ?? (json === undefined ? '' : JSON.stringify(json));
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k) => headers[k.toLowerCase()] },
        text: async () => bodyText,
    };
}

// fakeFetch: records every call and returns from a scripted queue.
function fakeFetch(script) {
    const calls = [];
    let idx = 0;
    const impl = async (url, init) => {
        calls.push({ url, init });
        const step = script[Math.min(idx, script.length - 1)];
        idx += 1;
        if (step instanceof Error) throw step;
        if (typeof step === 'function') return step({ url, init });
        return makeResponse(step);
    };
    impl.calls = calls;
    return impl;
}

test('rejects invalid construction inputs', () => {
    assert.throws(() => createHttpClient({}), /baseUrl/);
    assert.throws(
        () => createHttpClient({ baseUrl: 'http://x', fetchImpl: 42 }),
        /fetchImpl/,
    );
});

test('GET 200: returns body envelope and attaches service token', async () => {
    const fetchImpl = fakeFetch([{ status: 200, json: { success: true, data: [] } }]);
    const http = createHttpClient({
        baseUrl: 'http://dash.test',
        serviceToken: 'tok-abc',
        fetchImpl,
    });
    const res = await http.get('/api/clients/all');
    assert.equal(res.status, 200);
    assert.deepEqual(res.bodyJson, { success: true, data: [] });
    assert.equal(fetchImpl.calls[0].url, 'http://dash.test/api/clients/all');
    assert.equal(fetchImpl.calls[0].init.headers['x-service-token'], 'tok-abc');
    assert.equal(fetchImpl.calls[0].init.method, 'GET');
});

test('POST JSON: sets content-type and serialises body', async () => {
    const fetchImpl = fakeFetch([{ status: 200, json: { ok: true } }]);
    const http = createHttpClient({ baseUrl: 'http://dash.test', fetchImpl });
    await http.postJson('/x', { a: 1 });
    const init = fetchImpl.calls[0].init;
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.equal(init.body, '{"a":1}');
});

test('retries network errors up to `retries` times then throws HttpError', async () => {
    const netErr = Object.assign(new Error('ECONNRESET'), { name: 'Error' });
    const fetchImpl = fakeFetch([netErr, netErr, netErr, netErr]);
    const http = createHttpClient({
        baseUrl: 'http://dash.test',
        fetchImpl,
        retries: 2,
    });
    await assert.rejects(
        () => http.get('/x'),
        (e) => {
            assert.ok(e instanceof HttpError);
            assert.equal(e.kind, 'network');
            return true;
        },
    );
    // initial + 2 retries = 3 calls
    assert.equal(fetchImpl.calls.length, 3);
});

test('retries 5xx then succeeds on the retry', async () => {
    const fetchImpl = fakeFetch([
        { status: 502 },
        { status: 503 },
        { status: 200, json: { ok: true } },
    ]);
    const http = createHttpClient({
        baseUrl: 'http://dash.test',
        fetchImpl,
        retries: 3,
    });
    const res = await http.get('/x');
    assert.equal(res.status, 200);
    assert.equal(fetchImpl.calls.length, 3);
});

test('does NOT retry 4xx', async () => {
    const fetchImpl = fakeFetch([
        { status: 403, json: { message: 'no' } },
        { status: 200, json: { ok: true } },
    ]);
    const http = createHttpClient({
        baseUrl: 'http://dash.test',
        fetchImpl,
        retries: 3,
    });
    const res = await http.get('/x');
    assert.equal(res.status, 403);
    assert.equal(fetchImpl.calls.length, 1);
});

test('timeout: aborts + classifies as HttpError.kind="timeout"', async () => {
    const slowFetch = async (_url, init) =>
        new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
                const e = new Error('aborted');
                e.name = 'AbortError';
                reject(e);
            });
        });
    const http = createHttpClient({
        baseUrl: 'http://dash.test',
        fetchImpl: slowFetch,
        timeoutMs: 20,
        retries: 0, // don't retry in this test; we're asserting the classification
    });
    await assert.rejects(
        () => http.get('/x'),
        (e) => {
            assert.ok(e instanceof HttpError);
            assert.equal(e.kind, 'timeout');
            return true;
        },
    );
});

test('no serviceToken → no x-service-token header sent', async () => {
    const fetchImpl = fakeFetch([{ status: 200, json: {} }]);
    const http = createHttpClient({
        baseUrl: 'http://dash.test',
        fetchImpl,
    });
    await http.get('/x');
    assert.equal(fetchImpl.calls[0].init.headers['x-service-token'], undefined);
});

test('non-JSON body still returned as text without throwing', async () => {
    const fetchImpl = fakeFetch([{ status: 200, text: 'plain text' }]);
    const http = createHttpClient({ baseUrl: 'http://dash.test', fetchImpl });
    const res = await http.get('/x');
    assert.equal(res.status, 200);
    assert.equal(res.bodyText, 'plain text');
    assert.equal(res.bodyJson, undefined);
});
