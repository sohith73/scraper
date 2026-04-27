// Tests for filterJobsByRelevance. Inject a fake `ai` whose completeJson
// returns scripted decisions. No SDK, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterJobsByRelevance } from '../../src/services/relevance/filter.js';

// makeJob: minimal canonical-Job shape the compacter can read.
function makeJob(id, overrides = {}) {
    return {
        id,
        impId: `imp-${id}`,
        title: overrides.title ?? 'Backend Engineer',
        companyName: overrides.company ?? 'Co',
        jobLocation: overrides.location ?? 'US',
        workModel: overrides.workModel ?? 'Remote',
        isRemote: true,
        employmentType: 'Full-time',
        seniority: overrides.seniority ?? 'Senior Level',
        minYearsOfExperience: 5,
        publishedAtRelative: '1 hour ago',
        applicantsCount: 10,
        applyUrl: `https://co/${id}`,
        description: 'full',
        requirements: { must: ['req'], preferred: [] },
        tags: [],
        flags: { h1bSponsor: true, citizenOnly: false, clearanceRequired: false, workAuthRequired: false },
        score: { raw: 12, label: 'Fair Match' },
        company: {},
    };
}

const INTENT = {
    roles: ['Backend Engineer'],
    locations: ['Remote'],
    seniority: 'senior',
    companies: [],
    workAuth: 'US Citizen',
    narrative: '',
    futurePreferences: '',
    exclusions: { companies: [], locations: [] },
};

// fakeAi: the completeJson fn returns a scripted decision array. Each
// test passes a `mkDecisions(jobsInBatch)` function so we can generate
// decisions keyed to the actual input batch.
function makeAi({ mkDecisions, throws, cacheHits = () => false, calls = [] } = {}) {
    return {
        calls,
        completeJson: async (args) => {
            calls.push(args);
            if (throws) throw throws;
            // Pull ids out of the user prompt (lightweight) — in production
            // the model returns id-keyed decisions; we do the same.
            const match = args.user.match(/"id": "([^"]+)"/g) || [];
            const ids = match.map((m) => m.slice(7, -1));
            const decisions = mkDecisions(ids);
            return {
                ok: true,
                value: {
                    value: { decisions },
                    cacheHit: cacheHits(calls.length),
                    key: `k${calls.length}`,
                },
            };
        },
    };
}

// ------------------ validation -----------------------------------------

test('BAD_INPUT: missing ai', async () => {
    const r = await filterJobsByRelevance({ intent: INTENT, jobs: [] });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('BAD_INPUT: missing intent', async () => {
    const r = await filterJobsByRelevance({
        ai: makeAi({ mkDecisions: () => [] }),
        jobs: [],
    });
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('BAD_INPUT: jobs must be an array', async () => {
    const r = await filterJobsByRelevance({
        ai: makeAi({ mkDecisions: () => [] }),
        intent: INTENT,
        jobs: 'nope',
    });
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('BAD_INPUT: batchSize out of range', async () => {
    const ai = makeAi({ mkDecisions: () => [] });
    const r1 = await filterJobsByRelevance({ ai, intent: INTENT, jobs: [], batchSize: 0 });
    const r2 = await filterJobsByRelevance({ ai, intent: INTENT, jobs: [], batchSize: 41 });
    const r3 = await filterJobsByRelevance({ ai, intent: INTENT, jobs: [], batchSize: 1.5 });
    assert.equal(r1.error.code, 'BAD_INPUT');
    assert.equal(r2.error.code, 'BAD_INPUT');
    assert.equal(r3.error.code, 'BAD_INPUT');
});

// ------------------ empty jobs -----------------------------------------

test('empty jobs list: no AI call, stats zeroed', async () => {
    const ai = makeAi({ mkDecisions: () => [] });
    const r = await filterJobsByRelevance({ ai, intent: INTENT, jobs: [] });
    assert.equal(r.ok, true);
    assert.equal(r.value.scored.length, 0);
    assert.deepEqual(r.value.picks, []);
    assert.equal(r.value.stats.batches, 0);
    assert.equal(ai.calls.length, 0);
});

// ------------------ single batch ---------------------------------------

test('single batch: jobs scored + attached to decisions in input order', async () => {
    const jobs = [makeJob('j1'), makeJob('j2'), makeJob('j3')];
    const ai = makeAi({
        mkDecisions: (ids) =>
            ids.map((id, i) => ({
                id,
                pick: i === 0,
                score: [85, 20, 55][i],
                reason: `r${i}`,
            })),
    });
    const r = await filterJobsByRelevance({ ai, intent: INTENT, jobs, batchSize: 20 });
    assert.equal(r.ok, true);
    assert.equal(r.value.scored.length, 3);
    assert.equal(r.value.scored[0].job.id, 'j1');
    assert.equal(r.value.scored[0].decision.pick, true);
    assert.equal(r.value.scored[0].decision.score, 85);
    assert.deepEqual(r.value.picks.map((j) => j.id), ['j1']);
    assert.deepEqual(r.value.skips.map((j) => j.id), ['j2']);           // score 20 < 30 → skip
    assert.deepEqual(r.value.borderline.map((j) => j.id), ['j3']);      // pick=false & score≥30
    assert.equal(r.value.stats.totalJobs, 3);
    assert.equal(r.value.stats.picked, 1);
    assert.equal(r.value.stats.skipped, 1);
    assert.equal(r.value.stats.borderline, 1);
    assert.equal(r.value.stats.batches, 1);
    assert.equal(ai.calls.length, 1);
});

test('single batch passes strict json_schema + zod validator to AI', async () => {
    const ai = makeAi({ mkDecisions: () => [] });
    await filterJobsByRelevance({
        ai,
        intent: INTENT,
        jobs: [makeJob('x')],
    });
    const call = ai.calls[0];
    assert.match(call.system, /flashfire|recruiter|scoring/i);
    assert.equal(call.schema.properties.decisions.items.additionalProperties, false);
    assert.ok(call.zodSchema);
    assert.match(call.schemaName, /Decisions_v/);
});

// ------------------ multi-batch ----------------------------------------

test('multi-batch: jobs chunked + merged, order preserved', async () => {
    const jobs = Array.from({ length: 25 }, (_, i) => makeJob(`j${i}`));
    const ai = makeAi({
        mkDecisions: (ids) =>
            ids.map((id) => ({
                id,
                pick: true,
                score: 90,
                reason: 'ok',
            })),
    });
    const r = await filterJobsByRelevance({ ai, intent: INTENT, jobs, batchSize: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.value.scored.length, 25);
    // order preserved across batches
    for (let i = 0; i < 25; i += 1) {
        assert.equal(r.value.scored[i].job.id, `j${i}`);
    }
    assert.equal(r.value.stats.batches, 3); // ceil(25/10)
    assert.equal(ai.calls.length, 3);
});

test('multi-batch: cache hits are counted', async () => {
    const jobs = Array.from({ length: 20 }, (_, i) => makeJob(`j${i}`));
    const ai = makeAi({
        mkDecisions: (ids) =>
            ids.map((id) => ({ id, pick: true, score: 90, reason: 'ok' })),
        cacheHits: (n) => n === 2, // mark second batch as cache hit
    });
    const r = await filterJobsByRelevance({ ai, intent: INTENT, jobs, batchSize: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.value.stats.cacheHits, 1);
});

test('batch runs IN PARALLEL (not sequential)', async () => {
    const order = [];
    const jobs = Array.from({ length: 30 }, (_, i) => makeJob(`j${i}`));
    const ai = {
        completeJson: async (args) => {
            const id = args.user.match(/"id": "([^"]+)"/)?.[1];
            order.push(`start:${id}`);
            await new Promise((r) => setTimeout(r, 30));
            order.push(`end:${id}`);
            // Need to return decisions for EVERY id in the prompt
            const ids = [...args.user.matchAll(/"id": "([^"]+)"/g)].map((m) => m[1]);
            return {
                ok: true,
                value: {
                    value: {
                        decisions: ids.map((x) => ({ id: x, pick: true, score: 80, reason: 'ok' })),
                    },
                    cacheHit: false,
                    key: 'k',
                },
            };
        },
    };
    const t0 = Date.now();
    await filterJobsByRelevance({ ai, intent: INTENT, jobs, batchSize: 10 });
    const dt = Date.now() - t0;
    // Three 30ms batches sequentially would take ≥ 90ms; in parallel ≤ ~60.
    assert.ok(dt < 85, `expected parallel execution, took ${dt}ms`);
    // All three starts happen before any end
    const firstEndIdx = order.findIndex((s) => s.startsWith('end:'));
    const startsBeforeFirstEnd = order.slice(0, firstEndIdx).filter((s) => s.startsWith('start:')).length;
    assert.equal(startsBeforeFirstEnd, 3);
});

// ------------------ error bubbling + defensive defaults ----------------

test('AI error bubbles unchanged', async () => {
    const ai = {
        completeJson: async () => ({
            ok: false,
            error: { code: 'RATE_LIMITED', message: 'slow down' },
        }),
    };
    const r = await filterJobsByRelevance({
        ai,
        intent: INTENT,
        jobs: [makeJob('j1')],
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'RATE_LIMITED');
});

test('missing decision for a job → default {pick:false, score:0, no-decision reason}', async () => {
    const ai = makeAi({
        mkDecisions: (ids) => [
            // Only return decision for the FIRST id
            { id: ids[0], pick: true, score: 90, reason: 'ok' },
        ],
    });
    const r = await filterJobsByRelevance({
        ai,
        intent: INTENT,
        jobs: [makeJob('j1'), makeJob('j2')],
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.scored[1].decision.pick, false);
    assert.equal(r.value.scored[1].decision.score, 0);
    assert.match(r.value.scored[1].decision.reason, /no decision/i);
    assert.deepEqual(r.value.skips.map((j) => j.id), ['j2']);
});

test('calibration block is forwarded into the user prompt verbatim', async () => {
    let seenUser = null;
    const ai = {
        completeJson: async (args) => {
            seenUser = args.user;
            const ids = [...args.user.matchAll(/"id": "([^"]+)"/g)].map((m) => m[1]);
            return {
                ok: true,
                value: {
                    value: {
                        decisions: ids.map((id) => ({ id, pick: true, score: 80, reason: 'ok' })),
                    },
                    cacheHit: false,
                    key: 'k',
                },
            };
        },
    };
    const calibration = 'CLIENT CALIBRATION\n- "Sales Engineer" @ Acme — AI score 62';
    await filterJobsByRelevance({
        ai, intent: INTENT, jobs: [makeJob('j1')],
        calibration,
    });
    assert.ok(seenUser.includes('CLIENT CALIBRATION'), 'prompt must include calibration header');
    assert.ok(seenUser.includes('Sales Engineer'), 'prompt must include calibration body');
});

test('first batch failure short-circuits other batches (error has batchIndex)', async () => {
    const jobs = Array.from({ length: 30 }, (_, i) => makeJob(`j${i}`));
    const ai = {
        completeJson: async (args) => {
            if (args.user.includes('"id": "j10"')) {
                return { ok: false, error: { code: 'BAD_SHAPE', message: 'zod', batchIndex: 1 } };
            }
            const ids = [...args.user.matchAll(/"id": "([^"]+)"/g)].map((m) => m[1]);
            return {
                ok: true,
                value: {
                    value: {
                        decisions: ids.map((id) => ({ id, pick: true, score: 80, reason: 'ok' })),
                    },
                    cacheHit: false,
                    key: 'k',
                },
            };
        },
    };
    const r = await filterJobsByRelevance({ ai, intent: INTENT, jobs, batchSize: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_SHAPE');
});
