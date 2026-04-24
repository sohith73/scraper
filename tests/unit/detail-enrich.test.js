import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    enrichJobs,
    inspectJobCompleteness,
    DEFAULT_MIN_DESCRIPTION_CHARS,
} from '../../src/services/detail/enrich.js';

// completeJob: a canonical-shape job that passes every gate.
function completeJob(id = 'j1', overrides = {}) {
    return {
        id,
        title: 'Backend Engineer',
        companyName: 'Co',
        applyUrl: 'https://co/apply',
        description: 'x'.repeat(DEFAULT_MIN_DESCRIPTION_CHARS + 50),
        ...overrides,
    };
}

// ------------------ inspectJobCompleteness -----------------------------

test('inspectJobCompleteness: complete job → complete=true, no missing', () => {
    const r = inspectJobCompleteness(completeJob());
    assert.equal(r.complete, true);
    assert.deepEqual(r.missingFields, []);
    assert.equal(r.reason, '');
});

test('inspectJobCompleteness: non-object → flagged', () => {
    for (const v of [null, undefined, 'nope', 42]) {
        const r = inspectJobCompleteness(v);
        assert.equal(r.complete, false);
        assert.ok(r.missingFields.includes('<all>'));
    }
});

test('inspectJobCompleteness: missing id', () => {
    const r = inspectJobCompleteness(completeJob('', {}));
    assert.equal(r.complete, false);
    assert.ok(r.missingFields.includes('id'));
});

test('inspectJobCompleteness: missing title', () => {
    const r = inspectJobCompleteness(completeJob('j', { title: '' }));
    assert.ok(r.missingFields.includes('title'));
});

test('inspectJobCompleteness: missing companyName', () => {
    const r = inspectJobCompleteness(completeJob('j', { companyName: '   ' }));
    assert.ok(r.missingFields.includes('companyName'));
});

test('inspectJobCompleteness: missing applyUrl', () => {
    const r = inspectJobCompleteness(completeJob('j', { applyUrl: '' }));
    assert.ok(r.missingFields.includes('applyUrl'));
});

test('inspectJobCompleteness: short description', () => {
    const r = inspectJobCompleteness(
        completeJob('j', { description: 'too short' }),
    );
    assert.equal(r.complete, false);
    assert.ok(r.missingFields.includes('description'));
    assert.match(r.reason, /shorter than \d+ chars/);
});

test('inspectJobCompleteness: respects custom minDescriptionChars', () => {
    const r = inspectJobCompleteness(
        completeJob('j', { description: 'x'.repeat(100) }),
        { minDescriptionChars: 50 },
    );
    assert.equal(r.complete, true);
});

test('inspectJobCompleteness: collects multiple missing fields', () => {
    const r = inspectJobCompleteness({
        id: 'j',
        title: '',
        companyName: '',
        applyUrl: '',
        description: '',
    });
    assert.ok(r.missingFields.includes('title'));
    assert.ok(r.missingFields.includes('companyName'));
    assert.ok(r.missingFields.includes('applyUrl'));
    assert.ok(r.missingFields.includes('description'));
});

// ------------------ enrichJobs -----------------------------------------

test('enrichJobs: BAD_INPUT for non-array jobs', async () => {
    const r = await enrichJobs({ jobs: 'nope' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('enrichJobs: BAD_INPUT for invalid minDescriptionChars', async () => {
    const r1 = await enrichJobs({ jobs: [], minDescriptionChars: -1 });
    const r2 = await enrichJobs({ jobs: [], minDescriptionChars: 1.5 });
    assert.equal(r1.error.code, 'BAD_INPUT');
    assert.equal(r2.error.code, 'BAD_INPUT');
});

test('enrichJobs: empty input → empty partitions', async () => {
    const r = await enrichJobs({ jobs: [] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.ready, []);
    assert.deepEqual(r.value.sparse, []);
    assert.equal(r.value.stats.total, 0);
});

test('enrichJobs: all complete → ready=all, sparse=empty', async () => {
    const jobs = [completeJob('j1'), completeJob('j2'), completeJob('j3')];
    const r = await enrichJobs({ jobs });
    assert.equal(r.value.ready.length, 3);
    assert.equal(r.value.sparse.length, 0);
    assert.equal(r.value.stats.ready, 3);
});

test('enrichJobs: partitions sparse from ready, preserves order within each', async () => {
    const jobs = [
        completeJob('j1'),
        completeJob('j2', { description: 'short' }),
        completeJob('j3'),
        completeJob('j4', { applyUrl: '' }),
    ];
    const r = await enrichJobs({ jobs });
    assert.deepEqual(
        r.value.ready.map((j) => j.id),
        ['j1', 'j3'],
    );
    assert.deepEqual(
        r.value.sparse.map((s) => s.job.id),
        ['j2', 'j4'],
    );
});

test('enrichJobs: sparse entries carry missingFields + reason', async () => {
    const jobs = [completeJob('j1', { description: 'nope' })];
    const r = await enrichJobs({ jobs });
    assert.equal(r.value.sparse.length, 1);
    assert.ok(r.value.sparse[0].missingFields.includes('description'));
    assert.match(r.value.sparse[0].reason, /shorter than/);
});

test('enrichJobs: stats reflect partition', async () => {
    const jobs = [
        completeJob('j1'),
        completeJob('j2', { title: '' }),
        completeJob('j3'),
    ];
    const r = await enrichJobs({ jobs });
    assert.deepEqual(r.value.stats, {
        total: 3,
        ready: 2,
        sparse: 1,
        durationMs: r.value.stats.durationMs,
    });
    assert.ok(Number.isInteger(r.value.stats.durationMs));
});

test('enrichJobs: honours custom minDescriptionChars', async () => {
    const shortDesc = completeJob('j', { description: 'x'.repeat(100) });
    const r1 = await enrichJobs({ jobs: [shortDesc], minDescriptionChars: 50 });
    const r2 = await enrichJobs({ jobs: [shortDesc], minDescriptionChars: 200 });
    assert.equal(r1.value.ready.length, 1);
    assert.equal(r2.value.ready.length, 0);
    assert.equal(r2.value.sparse.length, 1);
});

test('enrichJobs: null items in list are classified as sparse, not throw', async () => {
    const r = await enrichJobs({ jobs: [null, completeJob('j1'), undefined] });
    assert.equal(r.ok, true);
    assert.equal(r.value.ready.length, 1);
    assert.equal(r.value.sparse.length, 2);
});

test('enrichJobs: logger receives debug lines for sparse jobs only', async () => {
    const lines = [];
    const logger = {
        debug: (obj, msg) => lines.push({ obj, msg }),
    };
    await enrichJobs({
        jobs: [
            completeJob('j1'),
            completeJob('j2', { description: '' }),
        ],
        logger,
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].obj.jobId, 'j2');
    assert.match(lines[0].msg, /sparse/);
});
