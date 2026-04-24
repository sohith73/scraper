// Mongo-backed client filter store — tested with an in-memory fake
// collection that mirrors the narrow slice of the mongodb driver we use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMongoClientFilterStore } from '../../src/services/clientFilters/mongoStore.js';

// makeFakeConnection: minimal stand-in for the mongodb client. Supports
// only the operations mongoStore.js actually calls.
function makeFakeConnection() {
    const store = new Map(); // _id → doc
    const coll = {
        async findOne(q) {
            if (q?._id) return store.get(q._id) || null;
            return null;
        },
        async updateOne(q, update, opts = {}) {
            const id = q._id;
            const existing = store.get(id) || null;
            // We only exercise the non-pipeline path here; pipeline is
            // covered by the feedback test. $set + $setOnInsert only.
            if (Array.isArray(update)) {
                throw new Error('pipeline update not simulated in this fake');
            }
            const merged = {
                ...(existing || {}),
                ...(existing ? {} : (update.$setOnInsert || {})),
                ...(update.$set || {}),
                _id: id,
            };
            store.set(id, merged);
            return { upsertedCount: existing ? 0 : 1, modifiedCount: existing ? 1 : 0 };
        },
        async deleteOne(q) {
            const id = q._id;
            const had = store.has(id);
            store.delete(id);
            return { deletedCount: had ? 1 : 0 };
        },
        find(_q, opts = {}) {
            const docs = [...store.values()].map((d) => {
                if (opts.projection) {
                    const picked = {};
                    for (const k of Object.keys(opts.projection)) {
                        if (d[k] !== undefined) picked[k] = d[k];
                    }
                    return picked;
                }
                return d;
            });
            return {
                sort() { return this; },
                async toArray() { return docs; },
            };
        },
        async createIndex() { return 'idx'; },
    };
    return {
        _store: store,
        async connect() {},
        db: () => ({ collection: () => coll }),
    };
}

test('get returns null for unknown email', async () => {
    const c = makeFakeConnection();
    const s = createMongoClientFilterStore({ connection: c });
    assert.equal(await s.get('nobody@b.com'), null);
});

test('put stores intent + overrides + meta with savedAt stamp', async () => {
    const c = makeFakeConnection();
    const s = createMongoClientFilterStore({ connection: c });
    const r = await s.put('a@b.com', {
        intent: { roles: ['SWE'] },
        overrides: { daysAgo: 7 },
        meta: { source: 'operator' },
    });
    assert.deepEqual(r.intent.roles, ['SWE']);
    assert.equal(r.overrides.daysAgo, 7);
    assert.match(r.meta.savedAt, /^\d{4}-\d{2}-\d{2}T/);

    const back = await s.get('a@b.com');
    assert.equal(back.intent.roles[0], 'SWE');
    assert.equal(back.overrides.daysAgo, 7);
});

test('put upserts — repeated writes replace intent', async () => {
    const c = makeFakeConnection();
    const s = createMongoClientFilterStore({ connection: c });
    await s.put('a@b.com', { intent: { roles: ['X'] } });
    await s.put('a@b.com', { intent: { roles: ['Y'] } });
    const doc = await s.get('a@b.com');
    assert.deepEqual(doc.intent.roles, ['Y']);
});

test('remove returns true when doc existed, false when not', async () => {
    const c = makeFakeConnection();
    const s = createMongoClientFilterStore({ connection: c });
    await s.put('a@b.com', { intent: {} });
    assert.equal(await s.remove('a@b.com'), true);
    assert.equal(await s.remove('a@b.com'), false);
});

test('list returns { email, savedAt } for every saved client', async () => {
    const c = makeFakeConnection();
    const s = createMongoClientFilterStore({ connection: c });
    await s.put('a@b.com', { intent: {} });
    await s.put('c@d.com', { intent: {} });
    const all = await s.list();
    assert.equal(all.length, 2);
    for (const row of all) {
        assert.ok(row.email);
        assert.ok(row.savedAt);
    }
});

test('normalises email to lowercase on write + read', async () => {
    const c = makeFakeConnection();
    const s = createMongoClientFilterStore({ connection: c });
    await s.put('Foo@Bar.COM', { intent: { roles: ['A'] } });
    // Read with uppercase — should find it.
    const doc = await s.get('FOO@BAR.COM');
    assert.equal(doc.intent.roles[0], 'A');
    // And confirm it's stored under the lowercase key.
    assert.ok(c._store.has('foo@bar.com'));
});

test('rejects invalid email on put', async () => {
    const c = makeFakeConnection();
    const s = createMongoClientFilterStore({ connection: c });
    await assert.rejects(() => s.put('not-an-email', {}), /valid email/i);
});
