// Unit tests for the file-backed client settings store. The Mongo store
// has the same contract + is exercised by the real Mongo in staging.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClientSettingsStore } from '../../src/services/clientSettings/store.js';

async function withStore(fn) {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-cs-'));
    const store = createClientSettingsStore({ dir });
    try {
        return await fn(store, dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test('put + get roundtrip, returns null before first put', async () => {
    await withStore(async (store) => {
        assert.equal(await store.get('a@x.com'), null);
        await store.put('a@x.com', { scrapeCount: 10 });
        const got = await store.get('A@X.com'); // case-insensitive
        assert.equal(got.scrapeCount, 10);
        assert.equal(got.email, 'a@x.com');
        assert.ok(got.updatedAt);
    });
});

test('put rejects invalid scrapeCount values', async () => {
    await withStore(async (store) => {
        await assert.rejects(() => store.put('a@x.com', { scrapeCount: 0 }), /scrapeCount/);
        await assert.rejects(() => store.put('a@x.com', { scrapeCount: 51 }), /scrapeCount/);
        await assert.rejects(() => store.put('a@x.com', { scrapeCount: 'abc' }), /scrapeCount/);
    });
});

test('put rejects invalid email', async () => {
    await withStore(async (store) => {
        await assert.rejects(() => store.put('not-an-email', { scrapeCount: 3 }), /valid email/);
    });
});

test('listAll returns every saved record', async () => {
    await withStore(async (store) => {
        await store.put('a@x.com', { scrapeCount: 3 });
        await store.put('b@x.com', { scrapeCount: 7 });
        const all = await store.listAll();
        assert.equal(all.length, 2);
        const emails = all.map((e) => e.email).sort();
        assert.deepEqual(emails, ['a@x.com', 'b@x.com']);
    });
});

test('remove + get returns null', async () => {
    await withStore(async (store) => {
        await store.put('a@x.com', { scrapeCount: 3 });
        assert.equal(await store.remove('a@x.com'), true);
        assert.equal(await store.get('a@x.com'), null);
        assert.equal(await store.remove('a@x.com'), false);
    });
});

test('concurrent puts serialise — all writes land', async () => {
    await withStore(async (store) => {
        await Promise.all([
            store.put('a@x.com', { scrapeCount: 3 }),
            store.put('b@x.com', { scrapeCount: 5 }),
            store.put('c@x.com', { scrapeCount: 7 }),
        ]);
        const all = await store.listAll();
        assert.equal(all.length, 3);
    });
});
