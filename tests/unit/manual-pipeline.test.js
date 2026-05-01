// Manual-capture pipeline. Drives the same store + state machine as the
// regular pipeline but consumes operator-captured raw JR payloads instead
// of running summariser + JR fetch.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunStore } from '../../src/services/runner/runStore.js';
import { runManualPipeline } from '../../src/services/runner/manualPipeline.js';
import { PHASES } from '../../src/services/runner/state.js';

const ok = (v) => ({ ok: true, value: v });
const err = (code, message = '') => ({ ok: false, error: { code, message } });

function makeRawJrJob({ id, title = 'Software Engineer', company = 'Acme Inc',
    description = 'Build software systems and ship features end-to-end. '.repeat(20),
    apply = 'https://example.com/apply' } = {}) {
    return {
        impId: `imp-${id}`,
        displayScore: 80,
        rankDesc: 'Strong Match',
        jobResult: {
            jobId: id,
            jobTitle: title,
            jobLocation: 'Remote',
            workModel: 'Remote',
            isRemote: true,
            employmentType: 'Full-time',
            jobSeniority: 'Mid-level',
            minYearsOfExperience: 3,
            publishTime: new Date().toISOString(),
            publishTimeDesc: '1d',
            applicantsCount: 12,
            applyLink: apply,
            jobSummary: description,
            coreResponsibilities: ['Ship code', 'Mentor juniors'],
            qualifications: { mustHave: ['JS'], preferredHave: ['Node'] },
            skillSummaries: ['JavaScript', 'Node'],
            isH1bSponsor: true,
            isCitizenOnly: false,
            isClearanceRequired: false,
            isWorkAuthRequired: false,
            recommendationTags: ['Early Applicant'],
            jobTags: [],
        },
        companyResult: {
            companyName: company,
            companySize: '51-200',
            companyDesc: 'Software co.',
            companyCategories: 'SaaS,B2B',
            companyLinkedinURL: 'https://linkedin.com/company/acme',
            companyURL: 'https://acme.com',
            companyLocation: 'Remote',
            companyFoundYear: '2018',
            fundraisingCurrentStage: 'Series B',
            fundraisingTotalFunding: '$50M',
        },
    };
}

function fakeAi(decisionFn) {
    return {
        completeJson: async ({ user }) => {
            // Compact prompt format includes lines like `"id": "j1"` per job.
            const ids = [...user.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
            const decisions = ids.map((id) => {
                const d = decisionFn(id);
                return { id, pick: !!d.pick, score: d.score ?? 0, reason: d.reason ?? '' };
            });
            return {
                ok: true,
                value: {
                    value: { decisions },
                    cacheHit: false,
                    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                },
            };
        },
    };
}

function makeContainer({ pushImpl, ai } = {}) {
    const dashboardPushed = [];
    return {
        env: {},
        logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {} },
        dashboard: {
            getProfile: async () => ok({
                profile: {
                    preferredRoles: 'Software Engineer / Backend Engineer',
                    preferredLocations: 'Remote, NYC',
                    targetCompanies: '',
                    experienceLevel: 'Mid (2-4 years)',
                    usWorkEligibility: 'US Citizen',
                    firstName: 'Test', lastName: 'User',
                },
                removedJobsCount: 0,
            }),
            getExclusions: async () => ok({ excludedCompanies: [], excludedLocations: [] }),
            pushJob: pushImpl || (async ({ jobDetails }) => {
                dashboardPushed.push(jobDetails);
                return ok({ outcome: 'created', createdJobId: `j-${dashboardPushed.length}` });
            }),
        },
        resume: { getByEmail: async () => ok({ found: false, reason: 'no-resume' }) },
        ai: ai || fakeAi(() => ({ jobId: 'x', pick: true, score: 80, reason: 'good fit' })),
        _dashboardPushed: dashboardPushed,
    };
}

test('manual pipeline: happy path — normalise, AI pick, preflight, push', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-pipe-'));
    after(() => rm(runsDir, { recursive: true, force: true }));
    const store = createRunStore({ runsDir });
    const run = store.create({ clientEmail: 'a@b.com', clientName: 'Test', requestedCount: 3 });
    const captured = [
        makeRawJrJob({ id: 'j1', title: 'Software Engineer', company: 'Acme Inc' }),
        makeRawJrJob({ id: 'j2', title: 'Backend Engineer', company: 'Globex' }),
        makeRawJrJob({ id: 'j3', title: 'Platform Engineer', company: 'Initech' }),
    ];
    const container = makeContainer({
        ai: fakeAi((id) => ({ jobId: id, pick: true, score: 75, reason: 'fits' })),
    });
    await runManualPipeline({ store, runId: run.id, container, capturedJobs: captured });
    const state = store.get(run.id);
    assert.equal(state.phase, PHASES.DONE);
    assert.equal(state.picks.length, 3);
    assert.equal(state.progress.mode, 'manual');
    assert.equal(state.progress.searched.totalReturned, 3);
    assert.equal(state.progress.searched.totalNormalized, 3);
    assert.equal(state.progress.pushed.pushed, 3);
    assert.equal(container._dashboardPushed.length, 3);
});

test('manual pipeline: dedupes by jobId across captured payloads', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-pipe-'));
    after(() => rm(runsDir, { recursive: true, force: true }));
    const store = createRunStore({ runsDir });
    const run = store.create({ clientEmail: 'a@b.com', clientName: 'T', requestedCount: 5 });
    const captured = [
        makeRawJrJob({ id: 'j1' }),
        makeRawJrJob({ id: 'j2' }),
        makeRawJrJob({ id: 'j1' }), // dup
        makeRawJrJob({ id: 'j3' }),
        makeRawJrJob({ id: 'j2' }), // dup
    ];
    const container = makeContainer({
        ai: fakeAi((id) => ({ jobId: id, pick: true, score: 80, reason: 'ok' })),
    });
    await runManualPipeline({ store, runId: run.id, container, capturedJobs: captured });
    const state = store.get(run.id);
    assert.equal(state.progress.searched.totalReturned, 5);
    assert.equal(state.progress.searched.totalNormalized, 3);
});

test('manual pipeline: drops LinkedIn-hosted apply URLs before AI', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-pipe-'));
    after(() => rm(runsDir, { recursive: true, force: true }));
    const store = createRunStore({ runsDir });
    const run = store.create({ clientEmail: 'a@b.com', clientName: 'T', requestedCount: 5 });
    const captured = [
        makeRawJrJob({ id: 'j1', apply: 'https://www.linkedin.com/jobs/view/123' }),
        makeRawJrJob({ id: 'j2', apply: 'https://example.com/apply' }),
    ];
    const container = makeContainer({
        ai: fakeAi((id) => ({ jobId: id, pick: true, score: 80, reason: 'ok' })),
    });
    await runManualPipeline({ store, runId: run.id, container, capturedJobs: captured });
    const state = store.get(run.id);
    assert.equal(state.progress.searched.linkedInSkipped, 1);
    assert.equal(state.progress.searched.totalNormalized, 1);
});

test('manual pipeline: BAD_INPUT on empty captured array', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-pipe-'));
    after(() => rm(runsDir, { recursive: true, force: true }));
    const store = createRunStore({ runsDir });
    const run = store.create({ clientEmail: 'a@b.com', clientName: 'T', requestedCount: 1 });
    const container = makeContainer();
    await runManualPipeline({ store, runId: run.id, container, capturedJobs: [] });
    const state = store.get(run.id);
    assert.equal(state.phase, PHASES.FAILED);
    assert.equal(state.error.code, 'BAD_INPUT');
});

test('manual pipeline: profile load failure → FAILED', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-pipe-'));
    after(() => rm(runsDir, { recursive: true, force: true }));
    const store = createRunStore({ runsDir });
    const run = store.create({ clientEmail: 'a@b.com', clientName: 'T', requestedCount: 1 });
    const container = makeContainer();
    container.dashboard.getProfile = async () => err('NOT_FOUND', 'no profile');
    await runManualPipeline({
        store, runId: run.id, container,
        capturedJobs: [makeRawJrJob({ id: 'j1' })],
    });
    const state = store.get(run.id);
    assert.equal(state.phase, PHASES.FAILED);
    assert.equal(state.error.code, 'NOT_FOUND');
});

test('manual pipeline: writes picks.json + summary.json', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-pipe-'));
    after(() => rm(runsDir, { recursive: true, force: true }));
    const store = createRunStore({ runsDir });
    const run = store.create({ clientEmail: 'a@b.com', clientName: 'T', requestedCount: 1 });
    const container = makeContainer({
        ai: fakeAi((id) => ({ jobId: id, pick: true, score: 80, reason: 'ok' })),
    });
    await runManualPipeline({
        store, runId: run.id, container,
        capturedJobs: [makeRawJrJob({ id: 'j1' })],
    });
    const dir = store.runDir(run.id);
    const picks = JSON.parse(await readFile(join(dir, 'picks.json'), 'utf8'));
    assert.equal(picks.mode, 'manual');
    assert.equal(picks.picks.length, 1);
    const summaryStat = await stat(join(dir, 'summary.json'));
    assert.ok(summaryStat.size > 0);
});

test('manual pipeline: skipped non-pick (low score) does not push', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'manual-pipe-'));
    after(() => rm(runsDir, { recursive: true, force: true }));
    const store = createRunStore({ runsDir });
    const run = store.create({ clientEmail: 'a@b.com', clientName: 'T', requestedCount: 5 });
    const container = makeContainer({
        ai: fakeAi((id) => ({
            jobId: id,
            pick: id === 'j1', // only j1 picks
            score: id === 'j1' ? 80 : 10,
            reason: 'mocked',
        })),
    });
    await runManualPipeline({
        store, runId: run.id, container,
        capturedJobs: [makeRawJrJob({ id: 'j1' }), makeRawJrJob({ id: 'j2' })],
    });
    const state = store.get(run.id);
    assert.equal(state.phase, PHASES.DONE);
    assert.equal(state.picks.length, 1);
    assert.equal(state.picks[0].jobId, 'j1');
});
