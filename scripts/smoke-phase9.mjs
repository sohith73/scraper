#!/usr/bin/env node
// Phase 9 live smoke: drive a real runSearch against JR.
//
// Requires: JR session cookies in storage/ (run smoke-phase7 or just hit
// POST /api/admin/login once before this).
//
// Usage: node --env-file=.env scripts/smoke-phase9.mjs

import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import {
    createMutex,
    createBrowserHandle,
    createSessionService,
} from '../src/playwright/index.js';
import { runSearch } from '../src/services/search/index.js';

const mutex = createMutex();
const browser = createBrowserHandle({ env, logger });
const session = createSessionService({ env, browser, mutex, logger });

// Seeded intent — a reasonable realistic search.
const intent = {
    roles: ['Backend Engineer', 'Platform Engineer'],
    locations: ['Remote'],
    seniority: 'senior',
    companies: [],
    workAuth: 'Requires H1B sponsorship',
    narrative: '',
    futurePreferences: '',
    exclusions: { companies: [], locations: [] },
};

console.log('--- ensuring session ---');
const sessionRes = await session.ensureLoggedIn();
if (!sessionRes.ok) {
    console.error(`session not ready: ${sessionRes.error.code} — ${sessionRes.error.message}`);
    process.exit(1);
}
console.log(`session ok: ${sessionRes.value.action}`);

console.log('\n--- running search ---');
const t0 = Date.now();
const r = await runSearch({
    browser,
    mutex,
    env,
    logger,
    intent,
    count: 5,
});
const dt = Date.now() - t0;

if (!r.ok) {
    console.error(`FAIL: ${r.error.code} — ${r.error.message}`);
    console.error(r.error.bodyJson || '');
    process.exit(1);
}

console.log(`\n✓ ${r.value.totalReturned} raw, ${r.value.totalNormalized} normalised in ${dt}ms`);
console.log(`listUrl: ${r.value.listUrl}`);
console.log('\n--- first job ---');
const j = r.value.jobs[0];
if (j) {
    console.log({
        id: j.id,
        title: j.title,
        company: j.companyName,
        location: j.jobLocation,
        workModel: j.workModel,
        seniority: j.seniority,
        score: j.score,
        flags: j.flags,
        applyUrl: j.applyUrl,
        descriptionLen: j.description.length,
        descriptionFirst200: j.description.slice(0, 200),
    });
} else {
    console.log('(no jobs returned)');
}

console.log('\n--- all titles ---');
for (const job of r.value.jobs) {
    console.log(`  [${job.score.label}] ${job.title} — ${job.companyName} (${job.jobLocation})`);
}

await browser.close();
console.log('\n✓ Phase 9 smoke OK');
