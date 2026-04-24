// runSearch tests. Mocks a Playwright Page + Browser handle + Mutex so we
// never touch the network. Real adapter + real filter mapper run here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSearch } from '../../src/services/search/runSearch.js';
import { createMutex } from '../../src/playwright/mutex.js';

const BASE_ENV = { JOBRIGHT_BASE: 'https://jobright.ai' };

const MIN_INTENT = {
    roles: ['Backend'],
    locations: ['San Francisco, CA'],
    seniority: 'senior',
    companies: [],
    workAuth: 'US Citizen',
    narrative: '',
    futurePreferences: '',
    exclusions: { companies: [], locations: [] },
};

// realJob: a JR jobList entry with enough fields to survive the adapter.
const realJob = (jobId) => ({
    impId: `imp-${jobId}`,
    displayScore: 12.3,
    rankDesc: 'Fair Match',
    jobResult: {
        jobId,
        jobTitle: 'Software Engineer',
        jobLocation: 'US',
        workModel: 'Remote',
        employmentType: 'Full-time',
        jobSummary: 'sum',
        applyLink: 'https://co/apply',
        qualifications: { mustHave: ['req'], preferredHave: [] },
        isH1bSponsor: true,
    },
    companyResult: {
        companyName: 'Co',
        companySize: '11-50',
        companyCategories: 'Tech',
    },
});

// makePage: build a Playwright-like page with scripted per-URL responses.
// handlers: { [urlSubstring]: { status, body } | (req) => {status,body} }
function makePage({ responses = {}, goto = async () => undefined } = {}) {
    const calls = [];
    return {
        calls,
        goto,
        async evaluate(fn, arg) {
            // Simulate pageFetch: arg = { u, m, b, h }.
            calls.push(arg);
            for (const [key, handler] of Object.entries(responses)) {
                if (arg.u.includes(key)) {
                    const r = typeof handler === 'function' ? handler(arg) : handler;
                    return {
                        status: r.status,
                        body: r.body ?? null,
                        bodyText: r.body ? JSON.stringify(r.body).slice(0, 1000) : '',
                        ...(r.error ? { error: r.error } : {}),
                    };
                }
            }
            return { status: 0, body: null, bodyText: '', error: 'no handler' };
        },
        close: async () => undefined,
    };
}

function makeBrowser(page) {
    return {
        calls: [],
        async withContext(opts, fn) {
            this.calls.push(opts);
            return fn({ newPage: async () => page });
        },
    };
}

// ------------------ validation -----------------------------------------

test('BAD_INPUT: missing browser', async () => {
    const r = await runSearch({
        mutex: createMutex(),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 5,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('BAD_INPUT: missing mutex', async () => {
    const r = await runSearch({
        browser: makeBrowser(makePage()),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 5,
    });
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('BAD_INPUT: missing env.JOBRIGHT_BASE', async () => {
    const r = await runSearch({
        browser: makeBrowser(makePage()),
        mutex: createMutex(),
        env: {},
        intent: MIN_INTENT,
        count: 5,
    });
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('BAD_INPUT: count out of range', async () => {
    const browser = makeBrowser(makePage());
    const mutex = createMutex();
    const r1 = await runSearch({ browser, mutex, env: BASE_ENV, intent: MIN_INTENT, count: 0 });
    const r2 = await runSearch({ browser, mutex, env: BASE_ENV, intent: MIN_INTENT, count: 999 });
    const r3 = await runSearch({ browser, mutex, env: BASE_ENV, intent: MIN_INTENT, count: 1.5 });
    assert.equal(r1.error.code, 'BAD_INPUT');
    assert.equal(r2.error.code, 'BAD_INPUT');
    assert.equal(r3.error.code, 'BAD_INPUT');
});

test('BAD_INPUT: missing intent', async () => {
    const r = await runSearch({
        browser: makeBrowser(makePage()),
        mutex: createMutex(),
        env: BASE_ENV,
        count: 5,
    });
    assert.equal(r.error.code, 'BAD_INPUT');
});

// ------------------ session gate ---------------------------------------

test('NEEDS_REAUTH when probe says logged-out', async () => {
    const page = makePage({
        responses: {
            '/swan/auth/newinfo': {
                status: 200,
                body: { success: true, result: { logined: false, userId: null } },
            },
        },
    });
    const r = await runSearch({
        browser: makeBrowser(page),
        mutex: createMutex(),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 3,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'NEEDS_REAUTH');
});

// ------------------ happy path -----------------------------------------

test('happy path: fetches filter, pushes filter, pulls jobs, normalises', async () => {
    const page = makePage({
        responses: {
            '/swan/auth/newinfo': {
                status: 200,
                body: { success: true, result: { logined: true, userId: 'u1' } },
            },
            '/swan/filter/get/filter': {
                status: 200,
                body: { success: true, result: { jobTypes: [1] } },
            },
            '/swan/filter/update/filter': {
                status: 200,
                body: { success: true, result: true },
            },
            '/swan/recommend/list/jobs': {
                status: 200,
                body: {
                    success: true,
                    result: {
                        jobList: [realJob('j1'), realJob('j2'), realJob('j3')],
                    },
                },
            },
        },
    });
    const r = await runSearch({
        browser: makeBrowser(page),
        mutex: createMutex(),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 3,
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.totalReturned, 3);
    assert.equal(r.value.totalNormalized, 3);
    assert.equal(r.value.jobs[0].id, 'j1');
    assert.equal(r.value.jobs[0].title, 'Software Engineer');
    assert.ok(r.value.listUrl.includes('count=3'));
    assert.ok(r.value.filter.isH1BOnly === false); // US Citizen intent
    assert.ok(Number.isInteger(r.value.durationMs));
});

test('happy path passes existing filter when caller supplies it', async () => {
    const page = makePage({
        responses: {
            '/swan/auth/newinfo': { status: 200, body: { success: true, result: { logined: true } } },
            '/swan/filter/update/filter': { status: 200, body: { success: true } },
            '/swan/recommend/list/jobs': {
                status: 200,
                body: { success: true, result: { jobList: [] } },
            },
        },
    });
    const r = await runSearch({
        browser: makeBrowser(page),
        mutex: createMutex(),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 5,
        existingFilter: { jobTypes: [1, 2], excludedCompanies: ['RulAout'] },
    });
    assert.equal(r.ok, true);
    // filter/get should NOT have been called since caller provided existing
    const calledUrls = page.calls.map((c) => c.u);
    assert.equal(calledUrls.some((u) => u.includes('/swan/filter/get/filter')), false);
    assert.deepEqual(r.value.filter.jobTypes, [1, 2]);
    assert.ok(r.value.filter.excludedCompanies.some((c) => c.companyName === 'RulAout'));
});

test('dedupes + drops malformed jobs during normalisation', async () => {
    const page = makePage({
        responses: {
            '/swan/auth/newinfo': { status: 200, body: { success: true, result: { logined: true } } },
            '/swan/filter/get/filter': { status: 200, body: { success: true, result: {} } },
            '/swan/filter/update/filter': { status: 200, body: { success: true } },
            '/swan/recommend/list/jobs': {
                status: 200,
                body: {
                    success: true,
                    result: {
                        jobList: [
                            realJob('j1'),
                            { jobResult: {} }, // no jobId → dropped
                            null,               // dropped
                            realJob('j2'),
                        ],
                    },
                },
            },
        },
    });
    const r = await runSearch({
        browser: makeBrowser(page),
        mutex: createMutex(),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 5,
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.totalReturned, 4);
    assert.equal(r.value.totalNormalized, 2);
});

// ------------------ upstream failures ----------------------------------

test('FILTER_UPDATE_FAILED: 403 from filter/update', async () => {
    const page = makePage({
        responses: {
            '/swan/auth/newinfo': { status: 200, body: { success: true, result: { logined: true } } },
            '/swan/filter/get/filter': { status: 200, body: { success: true, result: {} } },
            '/swan/filter/update/filter': { status: 403, body: { success: false } },
        },
    });
    const r = await runSearch({
        browser: makeBrowser(page),
        mutex: createMutex(),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 3,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'FILTER_UPDATE_FAILED');
});

test('RATE_LIMITED: 429 from list/jobs', async () => {
    const page = makePage({
        responses: {
            '/swan/auth/newinfo': { status: 200, body: { success: true, result: { logined: true } } },
            '/swan/filter/get/filter': { status: 200, body: { success: true, result: {} } },
            '/swan/filter/update/filter': { status: 200, body: { success: true } },
            '/swan/recommend/list/jobs': { status: 429, body: null },
        },
    });
    const r = await runSearch({
        browser: makeBrowser(page),
        mutex: createMutex(),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 3,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'RATE_LIMITED');
});

test('BLOCKED_BY_JOBRIGHT: 403 from list/jobs', async () => {
    const page = makePage({
        responses: {
            '/swan/auth/newinfo': { status: 200, body: { success: true, result: { logined: true } } },
            '/swan/filter/get/filter': { status: 200, body: { success: true, result: {} } },
            '/swan/filter/update/filter': { status: 200, body: { success: true } },
            '/swan/recommend/list/jobs': { status: 403, body: null },
        },
    });
    const r = await runSearch({
        browser: makeBrowser(page),
        mutex: createMutex(),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 3,
    });
    assert.equal(r.error.code, 'BLOCKED_BY_JOBRIGHT');
});

test('UPSTREAM_5XX: 502 from list/jobs', async () => {
    const page = makePage({
        responses: {
            '/swan/auth/newinfo': { status: 200, body: { success: true, result: { logined: true } } },
            '/swan/filter/get/filter': { status: 200, body: { success: true, result: {} } },
            '/swan/filter/update/filter': { status: 200, body: { success: true } },
            '/swan/recommend/list/jobs': { status: 502, body: null },
        },
    });
    const r = await runSearch({
        browser: makeBrowser(page),
        mutex: createMutex(),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 3,
    });
    assert.equal(r.error.code, 'UPSTREAM_5XX');
});

test('NETWORK: pageFetch reports status=0', async () => {
    const page = makePage({
        responses: {
            '/swan/auth/newinfo': { status: 200, body: { success: true, result: { logined: true } } },
            '/swan/filter/get/filter': { status: 200, body: { success: true, result: {} } },
            '/swan/filter/update/filter': { status: 200, body: { success: true } },
            '/swan/recommend/list/jobs': { status: 0, body: null },
        },
    });
    const r = await runSearch({
        browser: makeBrowser(page),
        mutex: createMutex(),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 3,
    });
    assert.equal(r.error.code, 'NETWORK');
});

test('LIST_EMPTY_SHAPE when result.jobList is missing', async () => {
    const page = makePage({
        responses: {
            '/swan/auth/newinfo': { status: 200, body: { success: true, result: { logined: true } } },
            '/swan/filter/get/filter': { status: 200, body: { success: true, result: {} } },
            '/swan/filter/update/filter': { status: 200, body: { success: true } },
            '/swan/recommend/list/jobs': {
                status: 200,
                body: { success: true, result: { somethingElse: true } },
            },
        },
    });
    const r = await runSearch({
        browser: makeBrowser(page),
        mutex: createMutex(),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 3,
    });
    assert.equal(r.error.code, 'LIST_EMPTY_SHAPE');
});

test('CONTEXT_CRASHED when page.goto throws', async () => {
    const page = makePage({
        goto: async () => {
            throw new Error('browser gone');
        },
    });
    const r = await runSearch({
        browser: makeBrowser(page),
        mutex: createMutex(),
        env: BASE_ENV,
        intent: MIN_INTENT,
        count: 3,
    });
    assert.equal(r.error.code, 'CONTEXT_CRASHED');
});

// ------------------ mutex serialisation --------------------------------

test('runs queue behind the shared mutex', async () => {
    const mutex = createMutex();
    const events = [];
    const slowFirst = {
        async withContext(_opts, fn) {
            events.push('first-start');
            await new Promise((r) => setTimeout(r, 30));
            const result = await fn({
                newPage: async () => makePage({
                    responses: {
                        '/swan/auth/newinfo': { status: 200, body: { success: true, result: { logined: true } } },
                        '/swan/filter/get/filter': { status: 200, body: { success: true, result: {} } },
                        '/swan/filter/update/filter': { status: 200, body: { success: true } },
                        '/swan/recommend/list/jobs': { status: 200, body: { success: true, result: { jobList: [] } } },
                    },
                }),
            });
            events.push('first-end');
            return result;
        },
    };
    const fastSecond = {
        async withContext(_opts, fn) {
            events.push('second-start');
            const r = await fn({
                newPage: async () => makePage({
                    responses: {
                        '/swan/auth/newinfo': { status: 200, body: { success: true, result: { logined: true } } },
                        '/swan/filter/get/filter': { status: 200, body: { success: true, result: {} } },
                        '/swan/filter/update/filter': { status: 200, body: { success: true } },
                        '/swan/recommend/list/jobs': { status: 200, body: { success: true, result: { jobList: [] } } },
                    },
                }),
            });
            events.push('second-end');
            return r;
        },
    };
    const [r1, r2] = await Promise.all([
        runSearch({ browser: slowFirst, mutex, env: BASE_ENV, intent: MIN_INTENT, count: 3 }),
        runSearch({ browser: fastSecond, mutex, env: BASE_ENV, intent: MIN_INTENT, count: 3 }),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    // Second must have started AFTER first ended.
    assert.ok(
        events.indexOf('second-start') > events.indexOf('first-end'),
        `expected serialisation, got: ${events.join(' -> ')}`,
    );
});
