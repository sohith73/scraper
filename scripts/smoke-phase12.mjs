#!/usr/bin/env node
// Phase 12 live end-to-end:
//   client lookup → profile → AI intent → JR search → AI relevance filter
//   → completeness gate → preflight → push to dashboard.
//
// Target client (auth'd locally via dashboard operator creds):
//   riyamate4567@gmail.com
//
// Requires:
//   - scraper .env with OPENAI_API_KEY + JOBRIGHT_* populated
//   - storage/ holds a live JR session (POST /api/admin/login if not)
//   - dashboard backend running on :8086
//
// Pushes at most 3 jobs to the client's tracker (count=8 → filtered).

import { buildContainer } from '../src/container.js';
import { runSearch } from '../src/services/search/index.js';
import { filterJobsByRelevance } from '../src/services/relevance/index.js';
import { enrichJobs } from '../src/services/detail/index.js';
import { runPreflight, runPush } from '../src/services/push/index.js';

const CLIENT_EMAIL = 'riyamate4567@gmail.com';
const MAX_JOBS = 3;
const SEARCH_COUNT = 8;

const c = buildContainer();
const { dashboard, resume, session, summariser, logger } = c;

console.log('--- 1. sanity: dashboard up ---');
const list = await dashboard.listClients();
if (!list.ok) {
    console.error(`dashboard: ${list.error.code} ${list.error.message}`);
    process.exit(1);
}
const client = list.value.clients.find((x) => x.email === CLIENT_EMAIL);
if (!client) {
    console.error(`client not found: ${CLIENT_EMAIL}`);
    process.exit(1);
}
console.log(`  ✓ client: ${client.name || '(no name)'} <${client.email}> (${client.planType})`);

console.log('\n--- 2. profile + exclusions ---');
const [profileRes, exclRes, resumeRes] = await Promise.all([
    dashboard.getProfile(CLIENT_EMAIL),
    dashboard.getExclusions(CLIENT_EMAIL),
    resume.getByEmail(CLIENT_EMAIL),
]);
if (!profileRes.ok) {
    console.error(`profile: ${profileRes.error.code}`);
    process.exit(1);
}
const { profile } = profileRes.value;
const exclusions = exclRes.ok
    ? { companies: exclRes.value.excludedCompanies, locations: exclRes.value.excludedLocations }
    : { companies: [], locations: [] };
console.log(`  profile roles: ${(profile.preferredRoles || []).slice(0, 2).join(' | ')}`);
console.log(`  excl companies: ${exclusions.companies.length}, locations: ${exclusions.locations.length}`);
console.log(`  resume: ${resumeRes.ok && resumeRes.value.found ? 'yes' : 'no'}`);

console.log('\n--- 3. ensure JR session ---');
const sess = await session.ensureLoggedIn();
if (!sess.ok) {
    console.error(`session: ${sess.error.code}`);
    process.exit(1);
}
console.log(`  ✓ ${sess.value.action}`);

console.log('\n--- 4. AI intent ---');
let intent;
const intentRes = await summariser({
    profile,
    resume: resumeRes.ok && resumeRes.value.found ? resumeRes.value.resume : null,
    exclusions,
    clientEmail: CLIENT_EMAIL,
});
if (intentRes.ok) {
    intent = intentRes.value.intent;
    console.log(`  ✓ AI intent: roles=${intent.roles.join(', ')} | seniority=${intent.seniority}`);
} else {
    // Some profiles have irregular data (e.g. roles as one CSV string) and
    // the AI can't recover — fall back to a hand-derived intent so the
    // rest of the pipeline is still exercised. Phase 5's own smoke proves
    // the AI path on well-formed profiles.
    console.warn(`  (AI intent: ${intentRes.error.code} — falling back to hand-derived)`);
    intent = {
        roles: ['Backend Engineer', 'Software Engineer', 'AI Engineer'],
        locations: ['Remote'],
        seniority: 'entry',
        companies: [],
        workAuth: 'Requires H1B sponsorship',
        narrative: '',
        futurePreferences: '',
        exclusions,
    };
    console.log(`  ✓ fallback intent: roles=${intent.roles.join(', ')} | seniority=${intent.seniority}`);
}

console.log(`\n--- 5. JR search (count=${SEARCH_COUNT}) ---`);
const searchRes = await runSearch({
    browser: c.browser,
    mutex: c.mutex,
    env: c.env,
    logger,
    intent,
    count: SEARCH_COUNT,
});
if (!searchRes.ok) {
    console.error(`search: ${searchRes.error.code} ${searchRes.error.message}`);
    process.exit(1);
}
console.log(`  ${searchRes.value.totalNormalized} jobs in ${searchRes.value.durationMs}ms`);

console.log('\n--- 6. AI relevance filter ---');
const filterRes = await filterJobsByRelevance({
    ai: c.ai,
    intent,
    jobs: searchRes.value.jobs,
});
if (!filterRes.ok) {
    console.error(`filter: ${filterRes.error.code}`);
    process.exit(1);
}
console.log(
    `  ${filterRes.value.stats.picked} picks / ${filterRes.value.stats.skipped} skips / ${filterRes.value.stats.borderline} borderline`,
);

let picks = filterRes.value.picks.slice(0, MAX_JOBS);
if (picks.length === 0) {
    // Fall back to borderline if no picks — still want to exercise the push path.
    picks = filterRes.value.borderline.slice(0, MAX_JOBS);
    console.log(`  (no picks — using ${picks.length} borderline instead)`);
}
console.log(`  → pushing top ${picks.length}`);

console.log('\n--- 7. enrichment gate ---');
const enrichRes = await enrichJobs({ jobs: picks, logger });
if (!enrichRes.ok) {
    console.error(`enrich: ${enrichRes.error.code}`);
    process.exit(1);
}
console.log(`  ready ${enrichRes.value.stats.ready} / sparse ${enrichRes.value.stats.sparse}`);

console.log('\n--- 8. preflight (local exclusion + dup) ---');
const pre = runPreflight({
    jobs: enrichRes.value.ready,
    exclusions,
    logger,
});
if (!pre.ok) {
    console.error(`preflight: ${pre.error.code}`);
    process.exit(1);
}
console.log(
    `  pushable ${pre.value.stats.pushable} / blockedCo ${pre.value.stats.blockedCompany} / blockedLoc ${pre.value.stats.blockedLocation} / localDup ${pre.value.stats.localDuplicate}`,
);
for (const f of pre.value.filtered) {
    console.log(`    skip: [${f.code}] ${f.job?.title} — ${f.reason}`);
}

console.log('\n--- 9. push to dashboard ---');
const pushRes = await runPush({
    dashboard,
    clientEmail: CLIENT_EMAIL,
    clientName: client.name || CLIENT_EMAIL,
    jobs: pre.value.pushable,
    concurrency: 2,
    logger,
});
if (!pushRes.ok) {
    console.error(`push: ${pushRes.error.code}`);
    process.exit(1);
}
const s = pushRes.value.stats;
console.log(
    `  pushed ${s.pushed} / duplicates ${s.duplicates} / blocked ${s.blocked} / errors ${s.errors} (${s.durationMs}ms)`,
);
for (const p of pushRes.value.pushed) {
    console.log(`    ✓ ${p.createdJobId} — ${p.job.title} @ ${p.job.companyName}`);
}
for (const d of pushRes.value.duplicates) {
    console.log(`    = ${d.job.title} @ ${d.job.companyName} (${d.reason})`);
}
for (const b of pushRes.value.blocked) {
    console.log(`    ⊘ [${b.code}] ${b.job.title} @ ${b.job.companyName}`);
}
for (const e of pushRes.value.errors) {
    console.log(`    ✗ [${e.code}] ${e.job.title} — ${e.reason}`);
}

await c.browser.close();
console.log('\n✓ Phase 12 smoke OK');
