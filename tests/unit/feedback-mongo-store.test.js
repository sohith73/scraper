// Mongo-backed feedback store — tests the non-pipeline operations (list,
// remove, clear, selectCalibration). The `append` path uses a Mongo
// aggregation-pipeline update which only runs correctly against a real
// server, so it's exercised in the integration smoke, not here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMongoFeedbackStore, VERDICTS } from '../../src/services/feedback/mongoStore.js';

// makeFakeConnection: seed with a pre-populated entries array so we can
// exercise list / remove / clear / selectCalibration deterministically.
function makeFakeConnection(seed = {}) {
    const store = new Map(Object.entries(seed));
    const coll = {
        async findOne(q, opts = {}) {
            const doc = store.get(q._id) || null;
            if (!doc) return null;
            if (opts.projection?.entries) return { entries: doc.entries };
            return doc;
        },
        async updateOne(q, update) {
            const id = q._id;
            const cur = store.get(id) || { _id: id, email: id, entries: [] };
            if (update.$pull?.entries?.id) {
                const before = cur.entries.length;
                cur.entries = cur.entries.filter((e) => e.id !== update.$pull.entries.id);
                store.set(id, cur);
                return { modifiedCount: cur.entries.length < before ? 1 : 0 };
            }
            return { modifiedCount: 0 };
        },
        async deleteOne(q) {
            const had = store.has(q._id);
            store.delete(q._id);
            return { deletedCount: had ? 1 : 0 };
        },
        find(_q, opts = {}) {
            return {
                async toArray() {
                    return [...store.keys()].map((id) => ({ _id: id }));
                },
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

function entry(o) {
    return {
        id: o.id,
        ts: o.ts || 't',
        jobId: o.jobId || o.id,
        title: o.title || 'T',
        company: o.company || 'C',
        verdict: o.verdict,
        aiPick: !!o.aiPick,
        aiScore: o.aiScore ?? 0,
        aiReason: '',
        note: '',
        sourceRunId: '',
    };
}

test('VERDICTS enum matches the file store', () => {
    assert.deepEqual([...VERDICTS].sort(), ['bad_pick', 'bad_skip', 'good_pick', 'good_skip']);
});

test('list returns entries from the underlying doc', async () => {
    const c = makeFakeConnection({
        'a@b.com': {
            _id: 'a@b.com',
            entries: [entry({ id: '1', verdict: 'bad_pick' })],
        },
    });
    const s = createMongoFeedbackStore({ connection: c });
    const list = await s.list('a@b.com');
    assert.equal(list.length, 1);
    assert.equal(list[0].verdict, 'bad_pick');
});

test('list returns empty array for unknown email', async () => {
    const c = makeFakeConnection();
    const s = createMongoFeedbackStore({ connection: c });
    assert.deepEqual(await s.list('nobody@b.com'), []);
});

test('remove pulls entry by id', async () => {
    const c = makeFakeConnection({
        'a@b.com': {
            _id: 'a@b.com',
            entries: [entry({ id: '1', verdict: 'bad_pick' }), entry({ id: '2', verdict: 'good_skip' })],
        },
    });
    const s = createMongoFeedbackStore({ connection: c });
    assert.equal(await s.remove('a@b.com', '1'), true);
    const left = await s.list('a@b.com');
    assert.equal(left.length, 1);
    assert.equal(left[0].id, '2');
});

test('remove returns false when id not found', async () => {
    const c = makeFakeConnection({
        'a@b.com': { _id: 'a@b.com', entries: [entry({ id: '1', verdict: 'bad_pick' })] },
    });
    const s = createMongoFeedbackStore({ connection: c });
    assert.equal(await s.remove('a@b.com', 'nope'), false);
});

test('clear deletes the whole doc', async () => {
    const c = makeFakeConnection({
        'a@b.com': { _id: 'a@b.com', entries: [entry({ id: '1', verdict: 'bad_pick' })] },
    });
    const s = createMongoFeedbackStore({ connection: c });
    assert.equal(await s.clear('a@b.com'), true);
    assert.equal(c._store.has('a@b.com'), false);
    // second clear = false
    assert.equal(await s.clear('a@b.com'), false);
});

test('selectCalibration applies the same selection algorithm as file store', async () => {
    const entries = [];
    for (let i = 0; i < 4; i += 1) entries.push(entry({ id: `bp${i}`, verdict: 'bad_pick' }));
    for (let i = 0; i < 4; i += 1) entries.push(entry({ id: `gs${i}`, verdict: 'good_skip' }));
    for (let i = 0; i < 3; i += 1) entries.push(entry({ id: `gp${i}`, verdict: 'good_pick' }));
    for (let i = 0; i < 3; i += 1) entries.push(entry({ id: `bs${i}`, verdict: 'bad_skip' }));

    const c = makeFakeConnection({ 'a@b.com': { _id: 'a@b.com', entries } });
    const s = createMongoFeedbackStore({ connection: c });
    const groups = await s.selectCalibration('a@b.com');
    assert.equal(groups.rejected.length, 3);
    assert.equal(groups.rescued.length, 3);
    assert.equal(groups.confirmedPick.length, 2);
    assert.equal(groups.confirmedSkip.length, 2);
    // Newest-first: bp3, bp2, bp1 (bp0 oldest, trimmed).
    assert.deepEqual(groups.rejected.map((e) => e.jobId), ['bp3', 'bp2', 'bp1']);
});

test('selectCalibration de-dupes by jobId (latest verdict wins)', async () => {
    const entries = [
        entry({ id: '1', jobId: 'j1', verdict: 'bad_pick' }),
        entry({ id: '2', jobId: 'j1', verdict: 'good_skip' }), // newer, same job
    ];
    const c = makeFakeConnection({ 'a@b.com': { _id: 'a@b.com', entries } });
    const s = createMongoFeedbackStore({ connection: c });
    const groups = await s.selectCalibration('a@b.com');
    assert.equal(groups.rejected.length, 0);
    assert.equal(groups.rescued.length, 1);
});

test('listAllEmails returns all doc _ids', async () => {
    const c = makeFakeConnection({
        'a@b.com': { _id: 'a@b.com', entries: [] },
        'c@d.com': { _id: 'c@d.com', entries: [] },
    });
    const s = createMongoFeedbackStore({ connection: c });
    const all = await s.listAllEmails();
    assert.equal(all.length, 2);
    assert.ok(all.includes('a@b.com'));
});

test('append rejects invalid verdict + email (validation before Mongo call)', async () => {
    const c = makeFakeConnection();
    const s = createMongoFeedbackStore({ connection: c });
    await assert.rejects(() => s.append('nope', { verdict: 'bad_pick' }), /valid email/i);
    await assert.rejects(() => s.append('a@b.com', { verdict: 'whatever' }), /verdict must be/i);
});
