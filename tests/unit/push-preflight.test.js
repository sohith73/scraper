import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight } from '../../src/services/push/preflight.js';

// mkJob: minimal canonical Job shape sufficient for preflight checks.
// Defaults vary by id to avoid accidental within-run dedupe — tests that
// care about dedupe must pass explicit title+companyName.
const mkJob = (id, overrides = {}) => ({
    id,
    title: overrides.title ?? `Backend Engineer ${id}`,
    companyName: overrides.companyName ?? `Company ${id}`,
    jobLocation: overrides.jobLocation ?? 'Remote',
    applyUrl: overrides.applyUrl ?? `https://co/${id}`,
});

test('BAD_INPUT when jobs is not an array', () => {
    const r = runPreflight({ jobs: 'nope' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('empty jobs → empty partitions, zero stats', () => {
    const r = runPreflight({ jobs: [] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.pushable, []);
    assert.deepEqual(r.value.filtered, []);
    assert.equal(r.value.stats.total, 0);
});

test('no exclusions, no existingJobs → everything pushable', () => {
    const jobs = [mkJob('j1'), mkJob('j2'), mkJob('j3')];
    const r = runPreflight({ jobs });
    assert.equal(r.value.pushable.length, 3);
    assert.equal(r.value.filtered.length, 0);
});

test('BLOCKED_COMPANY when companyName contains an excluded substring', () => {
    const jobs = [
        mkJob('j1', { companyName: 'Acme Corp' }),
        mkJob('j2', { companyName: 'Stripe' }),
    ];
    const r = runPreflight({
        jobs,
        exclusions: { companies: ['acme'], locations: [] },
    });
    assert.equal(r.value.pushable.length, 1);
    assert.equal(r.value.pushable[0].id, 'j2');
    assert.equal(r.value.filtered[0].code, 'BLOCKED_COMPANY');
    assert.match(r.value.filtered[0].reason, /Acme Corp/);
});

test('BLOCKED_COMPANY match is case-insensitive', () => {
    const r = runPreflight({
        jobs: [mkJob('j', { companyName: 'Globex GLOBAL' })],
        exclusions: { companies: ['GLOBEX'], locations: [] },
    });
    assert.equal(r.value.filtered[0].code, 'BLOCKED_COMPANY');
});

test('BLOCKED_LOCATION when location contains an excluded substring', () => {
    const jobs = [
        mkJob('j1', { jobLocation: 'New York, NY' }),
        mkJob('j2', { jobLocation: 'Remote' }),
    ];
    const r = runPreflight({
        jobs,
        exclusions: { companies: [], locations: ['new york'] },
    });
    assert.equal(r.value.pushable.length, 1);
    assert.equal(r.value.pushable[0].id, 'j2');
    assert.equal(r.value.filtered[0].code, 'BLOCKED_LOCATION');
});

test('company block takes precedence over location block (first match wins)', () => {
    const r = runPreflight({
        jobs: [mkJob('j', { companyName: 'Acme', jobLocation: 'NYC' })],
        exclusions: { companies: ['acme'], locations: ['nyc'] },
    });
    assert.equal(r.value.filtered[0].code, 'BLOCKED_COMPANY');
});

test('LOCAL_DUPLICATE when job matches an existing tracked job', () => {
    const jobs = [
        mkJob('j1', { title: 'Backend Engineer', companyName: 'Stripe' }),
        mkJob('j2', { title: 'Backend Engineer', companyName: 'Cloudflare' }),
    ];
    const r = runPreflight({
        jobs,
        existingJobs: [
            { jobTitle: 'backend engineer', companyName: 'stripe' },
        ],
    });
    assert.equal(r.value.pushable.length, 1);
    assert.equal(r.value.pushable[0].id, 'j2');
    assert.equal(r.value.filtered[0].code, 'LOCAL_DUPLICATE');
});

test('LOCAL_DUPLICATE match is case-insensitive against existingJobs', () => {
    const r = runPreflight({
        jobs: [mkJob('j', { title: 'Senior Engineer', companyName: 'Stripe' })],
        existingJobs: [
            { jobTitle: 'SENIOR ENGINEER', companyName: 'STRIPE' },
        ],
    });
    assert.equal(r.value.filtered[0].code, 'LOCAL_DUPLICATE');
});

test('within-run dedupe: same title+company twice in input → 2nd is LOCAL_DUPLICATE', () => {
    const jobs = [
        mkJob('a', { title: 'Backend', companyName: 'Co' }),
        mkJob('b', { title: 'Backend', companyName: 'Co' }),
    ];
    const r = runPreflight({ jobs });
    assert.equal(r.value.pushable.length, 1);
    assert.equal(r.value.pushable[0].id, 'a');
    assert.equal(r.value.filtered[0].code, 'LOCAL_DUPLICATE');
    assert.match(r.value.filtered[0].reason, /within this run/);
});

test('stats count by code', () => {
    const jobs = [
        mkJob('j1', { companyName: 'Acme' }),                                // blocked company
        mkJob('j2', { jobLocation: 'NYC' }),                                  // blocked location
        mkJob('j3', { title: 'Backend', companyName: 'Co' }),                 // pushable
        mkJob('j4', { title: 'Backend', companyName: 'Co' }),                 // dup
        mkJob('j5'),                                                          // pushable
    ];
    const r = runPreflight({
        jobs,
        exclusions: { companies: ['acme'], locations: ['nyc'] },
    });
    assert.deepEqual(r.value.stats, {
        total: 5,
        pushable: 2,
        blockedCompany: 1,
        blockedLocation: 1,
        localDuplicate: 1,
    });
});

test('malformed job (no id) is rejected as LOCAL_DUPLICATE with reason', () => {
    const r = runPreflight({ jobs: [null, { id: '' }, mkJob('ok')] });
    assert.equal(r.value.pushable.length, 1);
    assert.equal(r.value.filtered.length, 2);
    for (const f of r.value.filtered) {
        assert.equal(f.code, 'LOCAL_DUPLICATE');
        assert.match(f.reason, /invalid/);
    }
});

test('empty / whitespace exclusion entries are ignored', () => {
    const r = runPreflight({
        jobs: [mkJob('j', { companyName: 'Stripe' })],
        exclusions: { companies: ['', '   ', 'stripe'], locations: [] },
    });
    assert.equal(r.value.filtered[0].code, 'BLOCKED_COMPANY');
});

test('logger receives debug line with partition counts', () => {
    const lines = [];
    const logger = { debug: (obj, msg) => lines.push({ obj, msg }) };
    runPreflight({ jobs: [mkJob('j1'), mkJob('j2')], logger });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].obj.total, 2);
    assert.equal(lines[0].obj.pushable, 2);
});
