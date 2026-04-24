import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserHandle } from '../../src/playwright/browser.js';

// makeFakeContext: Playwright-shaped stub. Records close() calls so we can
// assert the "recycle on mode change" behaviour. Uses a plain boolean so
// state survives property-preserving assignments in tests.
function makeFakeContext() {
    const ctx = {
        closed: false,
        async close() {
            ctx.closed = true;
        },
    };
    return ctx;
}

// makeLauncher: returns a fake Playwright launcher that records opts.
function makeLauncher() {
    const calls = [];
    async function launcher(opts) {
        calls.push(opts);
        const c = makeFakeContext();
        c.__opts = opts;
        return c;
    }
    launcher.calls = calls;
    return launcher;
}

test('withContext launches on first call and reuses on second call with same opts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-brw-'));
    try {
        const launcher = makeLauncher();
        const b = createBrowserHandle({ storageDir: dir, launcher });
        let c1, c2;
        await b.withContext({ headless: true }, async (c) => { c1 = c; });
        await b.withContext({ headless: true }, async (c) => { c2 = c; });
        assert.equal(launcher.calls.length, 1);
        assert.strictEqual(c1, c2);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('mode change closes old context and opens a new one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-brw-'));
    try {
        const launcher = makeLauncher();
        const b = createBrowserHandle({ storageDir: dir, launcher });
        let headless, headed;
        await b.withContext({ headless: true }, async (c) => { headless = c; });
        await b.withContext({ headless: false }, async (c) => { headed = c; });
        assert.equal(launcher.calls.length, 2);
        assert.equal(launcher.calls[0].headless, true);
        assert.equal(launcher.calls[1].headless, false);
        assert.equal(headless.closed, true);
        assert.equal(headed.closed, false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('close() is idempotent and clears state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-brw-'));
    try {
        const launcher = makeLauncher();
        const b = createBrowserHandle({ storageDir: dir, launcher });
        await b.withContext({ headless: true }, async () => {});
        await b.close();
        assert.deepEqual(b.status(), { open: false, headless: null, dir });
        // Second close is a no-op — must not throw.
        await b.close();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('status() reports the currently-open mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-brw-'));
    try {
        const launcher = makeLauncher();
        const b = createBrowserHandle({ storageDir: dir, launcher });
        assert.equal(b.status().open, false);
        await b.withContext({ headless: true }, async () => {});
        const s = b.status();
        assert.equal(s.open, true);
        assert.equal(s.headless, true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
