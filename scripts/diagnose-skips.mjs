#!/usr/bin/env node
// Diagnostic: run a scrape for a given client + dump every AI decision's
// reason so we can see WHY jobs are skipped.
//
// Usage: node --env-file=.env scripts/diagnose-skips.mjs <email>

import { buildContainer } from '../src/container.js';
import { runSearch } from '../src/services/search/index.js';
import { filterJobsByRelevance } from '../src/services/relevance/index.js';

const email = process.argv[2] || 'samhitasari11@gmail.com';
const c = buildContainer();

console.log(`--- diagnosing ${email} ---`);
const profileRes = await c.dashboard.getProfile(email);
if (!profileRes.ok) { console.error(profileRes.error); process.exit(1); }
const exclRes = await c.dashboard.getExclusions(email);
const exclusions = exclRes.ok
    ? { companies: exclRes.value.excludedCompanies, locations: exclRes.value.excludedLocations }
    : { companies: [], locations: [] };

const sess = await c.session.ensureLoggedIn();
if (!sess.ok) { console.error(sess.error); process.exit(1); }

const intentRes = await c.summariser({
    profile: profileRes.value.profile,
    resume: null,
    exclusions,
    clientEmail: email,
});
if (!intentRes.ok) { console.error(intentRes.error); process.exit(1); }
const intent = intentRes.value.intent;
console.log('\nintent:', JSON.stringify(intent, null, 2).slice(0, 500));

const searchRes = await runSearch({
    browser: c.browser, mutex: c.mutex, env: c.env,
    logger: c.logger, intent, count: 10,
});
if (!searchRes.ok) { console.error(searchRes.error); process.exit(1); }
console.log(`\n--- JR returned ${searchRes.value.jobs.length} jobs ---`);
for (const j of searchRes.value.jobs) {
    console.log(`  • ${j.title} [${j.seniority}, ${j.workModel}, yoe=${j.minYearsOfExperience}, h1b=${j.flags.h1bSponsor}] — ${j.companyName} (${j.jobLocation})`);
}

const filterRes = await filterJobsByRelevance({ ai: c.ai, intent, jobs: searchRes.value.jobs });
if (!filterRes.ok) { console.error(filterRes.error); process.exit(1); }

console.log(`\n--- AI decisions (picked:${filterRes.value.stats.picked} skipped:${filterRes.value.stats.skipped} borderline:${filterRes.value.stats.borderline}) ---`);
for (const s of filterRes.value.scored) {
    const marker = s.decision.pick ? 'PICK' : s.decision.score >= 40 ? 'BORD' : 'SKIP';
    console.log(`  [${marker} ${s.decision.score.toString().padStart(3)}] ${s.job.title}`);
    console.log(`       reason: ${s.decision.reason}`);
}

await c.browser.close();
