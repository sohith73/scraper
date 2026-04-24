// Tests for startInterceptor. A `FakePage` mimics the tiny surface the
// interceptor uses (on/off + synthetic "response" events).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startInterceptor } from '../../src/playwright/intercept.js';

// --- test helpers --------------------------------------------------------

// makeResponse: minimal Playwright-shaped Response stand-in.
function makeResponse({
    url = 'https://jobright.ai/swan/recommend/list/jobs?position=0',
    method = 'GET',
    status = 200,
    json,
    text,
    contentType = 'application/json',
    readBodyFn,
} = {}) {
    const body = text ?? (json === undefined ? '' : JSON.stringify(json));
    return {
        url: () => url,
        status: () => status,
        headers: () => ({ 'content-type': contentType }),
        request: () => ({ method: () => method }),
        text: async () => {
            if (readBodyFn) return readBodyFn();
            return body;
        },
    };
}

// FakePage: emits synthetic response events to exercise the interceptor.
function makeFakePage() {
    const handlers = new Map();
    return {
        on(name, fn) {
            if (!handlers.has(name)) handlers.set(name, new Set());
            handlers.get(name).add(fn);
        },
        off(name, fn) {
            handlers.get(name)?.delete(fn);
        },
        async emit(name, arg) {
            const set = handlers.get(name);
            if (!set) return;
            // Fire sequentially — the real Playwright event loop doesn't
            // parallelise same-event handlers on the same page.
            for (const fn of [...set]) await fn(arg);
        },
        listenerCount(name) {
            return handlers.get(name)?.size ?? 0;
        },
    };
}

// --- tests ---------------------------------------------------------------

test('throws when page lacks .on / .off', () => {
    assert.throws(() => startInterceptor(null), /page must expose/);
    assert.throws(() => startInterceptor({}), /page must expose/);
});

test('captures every response when no filters are set', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page);
    await page.emit('response', makeResponse({ json: { a: 1 } }));
    await page.emit('response', makeResponse({ json: { b: 2 }, url: 'https://x/y' }));
    assert.equal(int.count, 2);
    const snapshot = int.all();
    assert.equal(snapshot[0].bodyJson.a, 1);
    assert.equal(snapshot[1].url, 'https://x/y');
    int.stop();
});

test('filters by urlPattern regex', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page, { urlPattern: /list\/jobs/ });
    await page.emit('response', makeResponse({ url: 'https://a/swan/list/jobs' }));
    await page.emit('response', makeResponse({ url: 'https://a/swan/other' }));
    assert.equal(int.count, 1);
    int.stop();
});

test('filters by urlPattern substring', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page, { urlPattern: 'list/jobs' });
    await page.emit('response', makeResponse({ url: 'https://a/list/jobs?x=1' }));
    await page.emit('response', makeResponse({ url: 'https://a/other' }));
    assert.equal(int.count, 1);
    int.stop();
});

test('filters by urlPattern function', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page, {
        urlPattern: (url) => url.endsWith('?page=0'),
    });
    await page.emit('response', makeResponse({ url: 'https://a/x?page=0' }));
    await page.emit('response', makeResponse({ url: 'https://a/x?page=1' }));
    assert.equal(int.count, 1);
    int.stop();
});

test('filters by method', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page, { method: 'POST' });
    await page.emit('response', makeResponse({ method: 'GET' }));
    await page.emit('response', makeResponse({ method: 'POST' }));
    assert.equal(int.count, 1);
    int.stop();
});

test('filters by statusRange', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page, { statusRange: [200, 299] });
    await page.emit('response', makeResponse({ status: 200 }));
    await page.emit('response', makeResponse({ status: 404 }));
    await page.emit('response', makeResponse({ status: 500 }));
    assert.equal(int.count, 1);
    int.stop();
});

test('parses JSON body into bodyJson', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page);
    await page.emit('response', makeResponse({ json: { ok: true, list: [1, 2, 3] } }));
    const [entry] = int.all();
    assert.deepEqual(entry.bodyJson, { ok: true, list: [1, 2, 3] });
    assert.equal(entry.bodyTextPreview, '');
    assert.ok(entry.bodyBytes > 0);
    int.stop();
});

test('non-JSON body falls back to bodyTextPreview', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page);
    await page.emit('response', makeResponse({ text: 'plain text', contentType: 'text/plain' }));
    const [entry] = int.all();
    assert.equal(entry.bodyJson, null);
    assert.equal(entry.bodyTextPreview, 'plain text');
    int.stop();
});

test('body-read failure does not propagate', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page);
    await page.emit(
        'response',
        makeResponse({
            readBodyFn: () => {
                throw new Error('page closed');
            },
        }),
    );
    // Still captured, just with empty body
    assert.equal(int.count, 1);
    assert.equal(int.all()[0].bodyJson, null);
    int.stop();
});

test('maxBuffer evicts oldest and increments droppedCount', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page, { maxBuffer: 2 });
    await page.emit('response', makeResponse({ json: { n: 1 } }));
    await page.emit('response', makeResponse({ json: { n: 2 } }));
    await page.emit('response', makeResponse({ json: { n: 3 } }));
    const all = int.all();
    assert.equal(all.length, 2);
    assert.equal(all[0].bodyJson.n, 2);
    assert.equal(all[1].bodyJson.n, 3);
    assert.equal(int.droppedCount, 1);
    int.stop();
});

test('rejects invalid maxBuffer', () => {
    const page = makeFakePage();
    assert.throws(() => startInterceptor(page, { maxBuffer: 0 }), /positive integer/);
    assert.throws(() => startInterceptor(page, { maxBuffer: -3 }), /positive integer/);
    assert.throws(() => startInterceptor(page, { maxBuffer: 1.5 }), /positive integer/);
});

test('waitFor resolves immediately when count already met', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page);
    await page.emit('response', makeResponse({ json: { a: 1 } }));
    const r = await int.waitFor({ count: 1, timeoutMs: 100 });
    assert.equal(r.complete, true);
    assert.equal(r.timedOut, false);
    assert.equal(r.items.length, 1);
    int.stop();
});

test('waitFor resolves when match arrives after call', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page);
    const waiter = int.waitFor({ count: 2, timeoutMs: 1000 });
    await page.emit('response', makeResponse({ json: { a: 1 } }));
    await page.emit('response', makeResponse({ json: { a: 2 } }));
    const r = await waiter;
    assert.equal(r.complete, true);
    assert.equal(r.items.length, 2);
    int.stop();
});

test('waitFor returns partial + timedOut:true on timeout', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page);
    await page.emit('response', makeResponse({ json: { a: 1 } }));
    const r = await int.waitFor({ count: 3, timeoutMs: 50 });
    assert.equal(r.complete, false);
    assert.equal(r.timedOut, true);
    assert.equal(r.items.length, 1);
    int.stop();
});

test('waitFor validates count', () => {
    const page = makeFakePage();
    const int = startInterceptor(page);
    assert.rejects(() => int.waitFor({ count: 0, timeoutMs: 10 }), /positive integer/);
    assert.rejects(() => int.waitFor({ count: -1, timeoutMs: 10 }), /positive integer/);
    int.stop();
});

test('drain snapshots and clears + resets droppedCount', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page, { maxBuffer: 1 });
    await page.emit('response', makeResponse({ json: { a: 1 } }));
    await page.emit('response', makeResponse({ json: { a: 2 } }));
    assert.equal(int.droppedCount, 1);
    const drained = int.drain();
    assert.equal(drained.length, 1);
    assert.equal(int.count, 0);
    assert.equal(int.droppedCount, 0);
    int.stop();
});

test('stop detaches the listener and is idempotent', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page);
    assert.equal(page.listenerCount('response'), 1);
    int.stop();
    assert.equal(int.stopped, true);
    assert.equal(page.listenerCount('response'), 0);
    // Subsequent events are ignored silently.
    await page.emit('response', makeResponse({ json: { a: 1 } }));
    assert.equal(int.count, 0);
    // Second stop is a no-op.
    int.stop();
});

test('debugDir: dumps each matching entry to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-intercept-'));
    try {
        const page = makeFakePage();
        const int = startInterceptor(page, { debugDir: dir });
        await page.emit(
            'response',
            makeResponse({
                url: 'https://jobright.ai/swan/list/jobs?x=1',
                json: { ok: true },
            }),
        );
        await page.emit(
            'response',
            makeResponse({
                url: 'https://jobright.ai/swan/other',
                json: { ok: false },
            }),
        );
        // Wait one microtask so the async dump finishes before we read.
        await new Promise((r) => setImmediate(r));
        const files = (await readdir(dir)).sort();
        assert.equal(files.length, 2);
        assert.match(files[0], /^00001-GET-.*\.json$/);
        const contents = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
        assert.equal(contents.bodyJson.ok, true);
        int.stop();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('matcher throwing does not break subsequent captures', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page, {
        urlPattern: () => {
            throw new Error('boom');
        },
    });
    await page.emit('response', makeResponse({ json: { a: 1 } }));
    // Matcher threw → nothing captured, but interceptor still alive.
    assert.equal(int.count, 0);
    assert.equal(int.stopped, false);
    int.stop();
});

test('stop before waitFor: waitFor still times out cleanly', async () => {
    const page = makeFakePage();
    const int = startInterceptor(page);
    int.stop();
    const r = await int.waitFor({ count: 1, timeoutMs: 30 });
    assert.equal(r.timedOut, true);
    assert.equal(r.items.length, 0);
});

test('typed urlPattern rejects unknown types', async () => {
    const page = makeFakePage();
    // Silence an uncaught rejection coming out of the matcher: the matcher
    // itself throws via `matches()` which we catch; but emit still awaits.
    const int = startInterceptor(page, { urlPattern: 42 });
    await page.emit('response', makeResponse());
    // Nothing captured because matches() threw; no crash.
    assert.equal(int.count, 0);
    int.stop();
});
