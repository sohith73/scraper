#!/usr/bin/env node
// Phase 5 live smoke test.
// Hits OpenAI exactly once (first run) then proves the disk cache short-
// circuits the second identical call. Costs ≲ $0.001 per execution.
//
// Usage: node --env-file=.env scripts/smoke-phase5.mjs
//   (requires OPENAI_API_KEY in scraper/.env)

import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { createOpenAIClient, createAiCache } from '../src/ai/index.js';
import { summarizeProfile } from '../src/services/intent/index.js';

if (!env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing in .env — skipping live smoke.');
    process.exit(2);
}

const fixtureProfile = {
    firstName: 'Alice',
    lastName: 'Doe',
    preferredRoles: ['Backend Engineer', 'Platform Engineer'],
    preferredLocations: ['San Francisco, CA', 'Remote'],
    experienceLevel: '4-7 Years',
    expectedSalaryRange: '150k-200k',
    targetCompanies: ['Stripe', 'Cloudflare', 'Datadog'],
    visaStatus: 'F1 OPT',
    usWorkEligibility: 'Requires H1B sponsorship in 2 years',
    joinTime: 'in 2 week',
    bachelorsUniDegree: 'BS Computer Science, UT Austin',
    linkedinUrl: 'https://linkedin.com/in/alice',
    githubUrl: 'https://github.com/alice',
};

const fixtureExclusions = {
    companies: ['Acme Corp', 'BadCo'],
    locations: ['New York, NY'],
};

const cache = createAiCache({ dir: env.AI_CACHE_DIR });
const ai = createOpenAIClient({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    cache,
    logger,
    retries: 2,
});

console.log('--- call 1 (expect cacheHit=false, live OpenAI call) ---');
const t1 = Date.now();
const r1 = await summarizeProfile({
    ai,
    profile: fixtureProfile,
    exclusions: fixtureExclusions,
    clientEmail: 'alice@smoke.test',
});
const dt1 = Date.now() - t1;
if (!r1.ok) {
    console.error(`FAIL: ${r1.error.code} — ${r1.error.message}`);
    process.exit(1);
}
console.log(`  cacheHit: ${r1.value.cacheHit}`);
console.log(`  elapsed : ${dt1}ms`);
console.log(`  key     : ${r1.value.key.slice(0, 16)}…`);
console.log('  intent  :', JSON.stringify(r1.value.intent, null, 2));

console.log('\n--- call 2 (expect cacheHit=true, sub-50ms) ---');
const t2 = Date.now();
const r2 = await summarizeProfile({
    ai,
    profile: fixtureProfile,
    exclusions: fixtureExclusions,
    clientEmail: 'alice@smoke.test',
});
const dt2 = Date.now() - t2;
if (!r2.ok) {
    console.error(`FAIL: ${r2.error.code} — ${r2.error.message}`);
    process.exit(1);
}
console.log(`  cacheHit: ${r2.value.cacheHit}`);
console.log(`  elapsed : ${dt2}ms`);

if (!r2.value.cacheHit) {
    console.error('\nFAIL: second call did not hit cache');
    process.exit(1);
}
if (JSON.stringify(r1.value.intent) !== JSON.stringify(r2.value.intent)) {
    console.error('\nFAIL: cached intent differs from live intent');
    process.exit(1);
}
console.log('\n✓ Phase 5 smoke OK — cache round-trip verified, schema valid.');
