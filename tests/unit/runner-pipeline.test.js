import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunStore } from '../../src/services/runner/runStore.js';
import { runPipeline } from '../../src/services/runner/pipeline.js';
import { PHASES } from '../../src/services/runner/state.js';

// We cannot import the real search/filter/push modules in this test — they
// hit Playwright / OpenAI / the dashboard. The pipeline imports them by
// name from ../search/index.js etc., so we test the public behaviour with
// fakes by arranging the `container` to return synthesised results at each
// step through the services the pipeline DOES accept as dependencies.
//
// The pipeline calls:
//   dashboard.getProfile       — container
//   dashboard.getExclusions    — container
//   resume.getByEmail          — container
//   summariser                 — container
//   runSearch(from search/)    — imported directly ❌ not injectable
//   filterJobsByRelevance      — imported directly ❌
//   enrichJobs                 — imported directly ❌
//   runPreflight + runPush     — imported directly ❌
//
// Since runSearch / filter / push are imported directly, we can still
// exercise the early-stage logic (profile fetch, exclusions, resume,
// summariser) and the failure path. Terminal-path happy-path testing
// happens via the live smoke script.
//
// So these tests focus on:
//   - failure at profile-load → phase=failed, error set
//   - abort-between-phases → phase=aborted
//   - overrideIntent short-circuits the summariser
//   - events stream in the right phase order

const ok = (v) => ({ ok: true, value: v });
const err = (code, message) => ({ ok: false, error: { code, message } });

// makeContainer: the minimum stubs the pipeline needs to get past the
// first few phases. Callers can override any field.
function makeContainer(overrides = {}) {
    return {
        env: {},
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        dashboard: {
            getProfile: async () => ok({ profile: { firstName: 'A' }, removedJobsCount: 0 }),
            getExclusions: async () =>
                ok({ excludedCompanies: [], excludedLocations: [] }),
            pushJob: async () => ok({ outcome: 'created', createdJobId: 'dj' }),
        },
        resume: { getByEmail: async () => ok({ found: true, resume: { summary: 'r' } }) },
        summariser: async () =>
            ok({
                intent: {
                    roles: ['X'],
                    locations: ['Remote'],
                    seniority: 'senior',
                    companies: [],
                    workAuth: '',
                    narrative: '',
                    futurePreferences: '',
                    exclusions: { companies: [], locations: [] },
                },
                cacheHit: false,
                key: 'k',
            }),
        ai: null,
        browser: null,
        mutex: null,
        ...overrides,
    };
}

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-pipeline-'));
    let n = 0;
    const store = createRunStore({ runsDir: dir, idGen: () => `r${++n}` });
    const run = store.create({
        clientEmail: 'a@b.com',
        clientName: 'Alice',
        requestedCount: 3,
    });
    return { dir, store, run };
}

test('profile load failure → phase=failed, error bubbled', async () => {
    const { dir, store, run } = await setup();
    try {
        const container = makeContainer({
            dashboard: {
                ...makeContainer().dashboard,
                getProfile: async () => err('NOT_FOUND', 'no profile'),
            },
        });
        await runPipeline({ store, runId: run.id, container });
        const final = store.get(run.id);
        assert.equal(final.phase, PHASES.FAILED);
        assert.equal(final.error.code, 'NOT_FOUND');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('summariser failure → phase=failed, code preserved', async () => {
    const { dir, store, run } = await setup();
    try {
        const container = makeContainer({
            summariser: async () => err('BAD_SHAPE', 'zod rejected output'),
        });
        await runPipeline({ store, runId: run.id, container });
        const final = store.get(run.id);
        assert.equal(final.phase, PHASES.FAILED);
        assert.equal(final.error.code, 'BAD_SHAPE');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('abort between phases → phase=aborted', async () => {
    const { dir, store, run } = await setup();
    try {
        // Flip abortRequested on BEFORE the pipeline starts: the very first
        // checkAbort after profile-load should catch it.
        store.update(run.id, { abortRequested: true });
        const container = makeContainer();
        await runPipeline({ store, runId: run.id, container });
        const final = store.get(run.id);
        assert.equal(final.phase, PHASES.ABORTED);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('state transitions stream in order through subscribe()', async () => {
    const { dir, store, run } = await setup();
    try {
        const seen = [];
        store.subscribe(run.id, (s) => seen.push(s.phase));
        // Make summariser fail AFTER we've gone through the early phases.
        const container = makeContainer({
            summariser: async () => err('BAD_INPUT', 'profile rejected'),
        });
        await runPipeline({ store, runId: run.id, container });
        // Expect at least these phases in this prefix order
        const prefix = [
            PHASES.LOADING_PROFILE,
            PHASES.LOADING_EXCLUSIONS,
            PHASES.LOADING_RESUME,
            PHASES.SUMMARISING,
            PHASES.FAILED,
        ];
        for (let i = 0; i < prefix.length; i += 1) {
            assert.equal(seen[i], prefix[i], `mismatch at ${i}: saw ${seen[i]}`);
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('missing resume → phase=failed with RESUME_MISSING before summariser', async () => {
    const { dir, store, run } = await setup();
    try {
        let summariserCalled = false;
        const container = makeContainer({
            resume: { getByEmail: async () => ok({ found: false, reason: 'no-resume' }) },
            summariser: async () => {
                summariserCalled = true;
                return ok({ intent: {}, cacheHit: false, key: '' });
            },
        });
        await runPipeline({ store, runId: run.id, container });
        const final = store.get(run.id);
        assert.equal(final.phase, PHASES.FAILED);
        assert.equal(final.error.code, 'RESUME_MISSING');
        assert.equal(summariserCalled, false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('missing resume does NOT fail when overrideIntent provided', async () => {
    const { dir, store, run } = await setup();
    try {
        const container = makeContainer({
            resume: { getByEmail: async () => ok({ found: false, reason: 'no-resume' }) },
        });
        const overrideIntent = {
            roles: ['Backend'],
            locations: ['Remote'],
            seniority: 'senior',
            companies: [],
            workAuth: '',
            narrative: '',
            futurePreferences: '',
            exclusions: { companies: [], locations: [] },
        };
        await runPipeline({ store, runId: run.id, container, overrideIntent });
        const final = store.get(run.id);
        // Should not be RESUME_MISSING — may fail later due to no browser, but not here.
        assert.notEqual(final.error?.code, 'RESUME_MISSING');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('overrideIntent skips the summariser call', async () => {
    const { dir, store, run } = await setup();
    try {
        let summariserCalled = false;
        const container = makeContainer({
            summariser: async () => {
                summariserCalled = true;
                return ok({ intent: {}, cacheHit: false, key: '' });
            },
        });
        const overrideIntent = {
            roles: ['Backend'],
            locations: ['Remote'],
            seniority: 'senior',
            companies: [],
            workAuth: '',
            narrative: '',
            futurePreferences: '',
            exclusions: { companies: [], locations: [] },
        };
        // This will still fail downstream (no browser/mutex) but we only
        // care that the summariser wasn't invoked.
        await runPipeline({ store, runId: run.id, container, overrideIntent });
        assert.equal(summariserCalled, false);
        const final = store.get(run.id);
        // The run will have transitioned past SUMMARISING because intent was
        // provided; the intent should be captured in progress.
        assert.deepEqual(final.progress.intent, overrideIntent);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('missing run id is handled gracefully (no throw)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-pipeline-'));
    try {
        const store = createRunStore({ runsDir: dir });
        // intentionally no run created
        await runPipeline({ store, runId: 'does-not-exist', container: makeContainer() });
        // nothing to assert: just "doesn't throw"
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
