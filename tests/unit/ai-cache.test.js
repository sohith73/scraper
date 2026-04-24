import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiCache } from '../../src/ai/cache.js';

const KEY = 'a'.repeat(64);
const KEY2 = 'b'.repeat(64);

async function freshDir() {
    return mkdtemp(join(tmpdir(), 'scraper-ai-cache-'));
}

test('disabled cache: get/set are no-ops', async () => {
    const cache = createAiCache({ enabled: false });
    await cache.set(KEY, { a: 1 });
    assert.equal(await cache.get(KEY), null);
});

test('enabled without dir throws', () => {
    assert.throws(() => createAiCache({ enabled: true }), /dir is required/);
});

test('set then get round-trips JSON-serialisable values', async () => {
    const dir = await freshDir();
    try {
        const cache = createAiCache({ dir });
        await cache.set(KEY, { a: 1, b: [2, 3], c: 'str' });
        assert.deepEqual(await cache.get(KEY), { a: 1, b: [2, 3], c: 'str' });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('get on missing key returns null', async () => {
    const dir = await freshDir();
    try {
        const cache = createAiCache({ dir });
        assert.equal(await cache.get(KEY), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('corrupt file is treated as miss AND evicted', async () => {
    const dir = await freshDir();
    try {
        const cache = createAiCache({ dir });
        const path = cache.path(KEY);
        await writeFile(path, '{ this is not valid json');
        const result = await cache.get(KEY);
        assert.equal(result, null);
        // A second get should also be null (file auto-evicted on first read).
        assert.equal(await cache.get(KEY), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('evict removes an entry', async () => {
    const dir = await freshDir();
    try {
        const cache = createAiCache({ dir });
        await cache.set(KEY, 42);
        assert.equal(await cache.get(KEY), 42);
        await cache.evict(KEY);
        assert.equal(await cache.get(KEY), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rejects non-hex keys', () => {
    const cache = createAiCache({ dir: '/tmp/x', enabled: true });
    assert.throws(() => cache.path('not-hex'), /hex sha/);
});

test('stored payload wraps value with metadata (k, v, t)', async () => {
    const dir = await freshDir();
    try {
        const cache = createAiCache({ dir });
        await cache.set(KEY, { hello: 'world' });
        const raw = await readFile(cache.path(KEY), 'utf8');
        const record = JSON.parse(raw);
        assert.equal(record.k, KEY);
        assert.deepEqual(record.v, { hello: 'world' });
        assert.ok(typeof record.t === 'string' && record.t.length > 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('keys are isolated from each other', async () => {
    const dir = await freshDir();
    try {
        const cache = createAiCache({ dir });
        await cache.set(KEY, 'one');
        await cache.set(KEY2, 'two');
        assert.equal(await cache.get(KEY), 'one');
        assert.equal(await cache.get(KEY2), 'two');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
