#!/usr/bin/env node
// audit-jr-filter.mjs
//
// Logs into JR using the credentials in `.env` (JOBRIGHT_EMAIL +
// JOBRIGHT_PASSWORD), fetches the canonical filter shape via
// /swan/filter/get/filter, and validates it against our local
// JR_FILTER_SCHEMA. Any field whose actual type doesn't match the schema
// is reported — that's a forward-compat signal we should add or relax in
// `src/services/search/filterSchema.js`.
//
// Also runs `searchIntentToJRFilter` against a synthetic intent and
// validates the OUTPUT — confirms our mapper's payload still satisfies
// JR's expectations end-to-end.
//
// Usage:
//   cd DASH/scraper
//   node --env-file-if-exists=.env scripts/audit-jr-filter.mjs
//
// Output: pretty-prints (a) live filter shape, (b) any schema mismatches,
// (c) mapper-output validation result. Exits 0 on full match, 1 otherwise.

import { buildContainer } from '../src/container.js';
import { searchIntentToJRFilter } from '../src/services/search/filterMapper.js';
import { validateJRFilter, JR_FILTER_SCHEMA } from '../src/services/search/filterSchema.js';

const FILTER_GET_PATH = '/swan/filter/get/filter';

// Synthetic intent that exercises every optional field mapper handles.
const SYN_INTENT = {
    roles: ['Software Engineer', 'Backend Engineer'],
    locations: ['San Francisco', 'Remote'],
    seniority: 'mid',
    minYearsOfExperience: 2,
    maxYearsOfExperience: 5,
    salaryMinimumUsd: 120000,
    employmentTypes: ['full-time'],
    workModels: ['remote', 'hybrid'],
    daysAgo: 14,
    skills: ['TypeScript', 'Node.js'],
    excludedTitles: ['QA Engineer', 'Technician'],
    excludedSkills: ['PHP'],
    companyStages: ['growth', 'public'],
    excludeStaffingAgency: true,
    excludeSecurityClearance: true,
    excludeUsCitizenOnly: true,
    country: 'US',
    exclusions: { companies: ['Acme Corp'], locations: [] },
};

function summariseMismatch(value, expectedZod) {
    // Walk live response keys; report any whose actual type collides with
    // the schema's declared shape. Only strict mismatches; nullables and
    // unions tolerated.
    const liveTypeOf = (v) => {
        if (v === null) return 'null';
        if (Array.isArray(v)) {
            const first = v[0];
            if (v.length === 0) return 'array<empty>';
            if (typeof first === 'string') return 'array<string>';
            if (typeof first === 'number') return 'array<number>';
            if (typeof first === 'object') return 'array<object>';
            return `array<${typeof first}>`;
        }
        return typeof v;
    };
    const out = {};
    for (const [k, v] of Object.entries(value || {})) {
        out[k] = liveTypeOf(v);
    }
    return out;
}

async function main() {
    const container = buildContainer();
    const { session, browser, env, logger } = container;

    logger.info('audit: ensuring JR login');
    const login = await session.ensureLoggedIn({ headed: false });
    if (!login.ok) {
        console.error('audit: login failed', login.error);
        process.exit(2);
    }
    logger.info('audit: session ready, fetching live filter');

    let liveFilter;
    await browser.withContext({}, async (context) => {
        const page = context.pages()[0] || (await context.newPage());
        if (!page.url() || page.url().startsWith('about:')) {
            await page.goto(`${env.JOBRIGHT_BASE}/jobs/recommend`, { waitUntil: 'domcontentloaded' });
        }
        const res = await page.evaluate(async (url) => {
            const r = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            });
            const body = await r.json().catch(() => null);
            return { status: r.status, body };
        }, `${env.JOBRIGHT_BASE}${FILTER_GET_PATH}`);
        if (res.status !== 200 || res.body?.success !== true) {
            console.error('audit: filter/get failed', res);
            process.exit(3);
        }
        liveFilter = res.body.result;
    });

    console.log('\n=== Live JR filter (canonical) ===');
    console.log(JSON.stringify(liveFilter, null, 2));

    console.log('\n=== Live filter type-shape ===');
    console.log(summariseMismatch(liveFilter));

    console.log('\n=== Live filter vs JR_FILTER_SCHEMA ===');
    const liveResult = validateJRFilter(liveFilter);
    if (liveResult.ok) {
        console.log('OK — live shape matches our schema.');
    } else {
        console.log('Mismatches:');
        for (const i of liveResult.issues) {
            console.log(`  - ${i.path}: ${i.message} (expected ${i.expected}, got ${i.received})`);
        }
    }

    console.log('\n=== Mapper output (synthetic intent) ===');
    const mapperOut = searchIntentToJRFilter({
        intent: SYN_INTENT,
        existing: liveFilter,
        resolvedTaxonomyList: liveFilter?.jobTaxonomyList || [],
    });
    console.log(JSON.stringify(mapperOut, null, 2));

    console.log('\n=== Mapper output vs JR_FILTER_SCHEMA ===');
    const mapperResult = validateJRFilter(mapperOut);
    if (mapperResult.ok) {
        console.log('OK — mapper output is JR-shaped.');
    } else {
        console.log('Mismatches (FIX filterMapper.js):');
        for (const i of mapperResult.issues) {
            console.log(`  - ${i.path}: ${i.message} (expected ${i.expected}, got ${i.received})`);
        }
    }

    await browser.close();

    const allOk = liveResult.ok && mapperResult.ok;
    process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
    console.error('audit failed:', err);
    process.exit(99);
});
