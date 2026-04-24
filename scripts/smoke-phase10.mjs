#!/usr/bin/env node
// Phase 10 live smoke — end-to-end pipeline:
//   seeded intent → JR search (Phase 9) → gpt-4o-mini relevance filter.
//
// Requires: session cookies in storage/ + OPENAI_API_KEY in .env.

import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import {
    createMutex,
    createBrowserHandle,
    createSessionService,
} from '../src/playwright/index.js';
import { runSearch } from '../src/services/search/index.js';
import { createOpenAIClient, createAiCache } from '../src/ai/index.js';
import { filterJobsByRelevance } from '../src/services/relevance/index.js';

if (!env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing');
    process.exit(2);
}

const mutex = createMutex();
const browser = createBrowserHandle({ env, logger });
const session = createSessionService({ env, browser, mutex, logger });
const cache = createAiCache({ dir: env.AI_CACHE_DIR });
const ai = createOpenAIClient({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    cache,
    logger,
});

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

console.log('--- 1. session ---');
const sess = await session.ensureLoggedIn();
if (!sess.ok) {
    console.error(`session: ${sess.error.code}`);
    process.exit(1);
}
console.log(`  ok: ${sess.value.action}`);

console.log('\n--- 2. JR search (N=15) ---');
const searchRes = await runSearch({
    browser,
    mutex,
    env,
    logger,
    intent,
    count: 15,
});
if (!searchRes.ok) {
    console.error(`search: ${searchRes.error.code} — ${searchRes.error.message}`);
    process.exit(1);
}
console.log(
    `  ${searchRes.value.totalReturned} raw, ${searchRes.value.totalNormalized} normalised in ${searchRes.value.durationMs}ms`,
);

console.log('\n--- 3. gpt-4o-mini relevance filter ---');
const filterRes = await filterJobsByRelevance({
    ai,
    intent,
    jobs: searchRes.value.jobs,
    batchSize: 20,
});
if (!filterRes.ok) {
    console.error(`filter: ${filterRes.error.code} — ${filterRes.error.message}`);
    process.exit(1);
}

const { picks, skips, borderline, stats } = filterRes.value;
console.log(`  ${stats.picked} picks, ${stats.skipped} skips, ${stats.borderline} borderline`);
console.log(`  ${stats.batches} batches, ${stats.cacheHits} cache hits, ${stats.durationMs}ms`);

console.log('\n--- PICKS ---');
for (const { job, decision } of filterRes.value.scored.filter((s) => s.decision.pick)) {
    console.log(`  [${decision.score}] ${job.title} — ${job.companyName}`);
    console.log(`       ${decision.reason}`);
}

console.log('\n--- BORDERLINE ---');
for (const { job, decision } of filterRes.value.scored.filter(
    (s) => !s.decision.pick && s.decision.score >= 40,
)) {
    console.log(`  [${decision.score}] ${job.title} — ${job.companyName}`);
    console.log(`       ${decision.reason}`);
}

console.log('\n--- SKIPS (first 5) ---');
for (const { job, decision } of filterRes.value.scored
    .filter((s) => !s.decision.pick && s.decision.score < 40)
    .slice(0, 5)) {
    console.log(`  [${decision.score}] ${job.title} — ${job.companyName}`);
    console.log(`       ${decision.reason}`);
}

// Cache round-trip: re-run; should be all cache hits.
console.log('\n--- 4. re-run (expect cache hits) ---');
const t2 = Date.now();
const rerun = await filterJobsByRelevance({
    ai,
    intent,
    jobs: searchRes.value.jobs,
    batchSize: 20,
});
const dt2 = Date.now() - t2;
if (rerun.ok) {
    console.log(`  ${rerun.value.stats.cacheHits}/${rerun.value.stats.batches} batches cached, ${dt2}ms`);
}

await browser.close();
console.log('\n✓ Phase 10 smoke OK');
