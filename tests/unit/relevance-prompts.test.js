import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SYSTEM_PROMPT,
    compactJobForPrompt,
    compactIntent,
    buildUserPrompt,
} from '../../src/services/relevance/prompts.js';

const JOB = {
    id: 'jr1',
    impId: 'imp1',
    title: 'Senior Backend Engineer',
    companyName: 'Stripe',
    jobLocation: 'San Francisco, CA',
    workModel: 'Remote',
    isRemote: true,
    employmentType: 'Full-time',
    seniority: 'Senior Level',
    minYearsOfExperience: 5,
    publishedAtRelative: '7 hours ago',
    applicantsCount: 42,
    applyUrl: 'https://stripe.com/apply',
    description: 'full description that should NOT appear in prompt',
    requirements: { must: ['5+ yrs', 'Go', 'Kubernetes', 'ignored extra'], preferred: [] },
    tags: ['H1B Sponsor Likely', 'Early Applicant', 'tag3', 'tag4', 'tag5'],
    flags: { h1bSponsor: true, citizenOnly: false, clearanceRequired: false, workAuthRequired: false },
    score: { raw: 18.3, label: 'Fair Match' },
    company: {},
};

const INTENT = {
    roles: ['Backend Engineer'],
    locations: ['Remote'],
    seniority: 'senior',
    companies: ['Stripe'],
    workAuth: 'Requires H1B sponsorship',
    narrative: 'long narrative should be stripped',
    futurePreferences: 'noise',
    exclusions: { companies: ['Acme'], locations: ['NYC'] },
};

test('SYSTEM_PROMPT mentions scoring rubric + JSON-only output', () => {
    assert.match(SYSTEM_PROMPT, /0-100/);
    assert.match(SYSTEM_PROMPT, /pick/);
    assert.match(SYSTEM_PROMPT, /JSON/);
    assert.match(SYSTEM_PROMPT, /seniority/i);
});

test('compactJobForPrompt returns null for falsy input', () => {
    assert.equal(compactJobForPrompt(null), null);
    assert.equal(compactJobForPrompt(undefined), null);
    assert.equal(compactJobForPrompt('nope'), null);
});

test('compactJobForPrompt drops the full description and keeps decision-relevant fields', () => {
    const c = compactJobForPrompt(JOB);
    assert.equal(c.id, 'jr1');
    assert.equal(c.title, 'Senior Backend Engineer');
    assert.equal(c.company, 'Stripe');
    assert.equal(c.location, 'San Francisco, CA');
    assert.equal(c.workModel, 'Remote');
    assert.equal(c.seniority, 'Senior Level');
    assert.equal(c.yoe, 5);
    assert.equal(c.h1bSponsor, true);
    assert.equal(c.applicants, 42);
    assert.equal(c.jrScore, 18.3);
    assert.deepEqual(c.mustHaveSample, ['5+ yrs', 'Go', 'Kubernetes']);
    assert.equal(c.mustHaveSample.length, 3);
    assert.equal(c.tags.length, 4);
    // No description field leaked
    assert.equal('description' in c, false);
});

test('compactIntent keeps narrative but drops futurePreferences', () => {
    const slim = compactIntent(INTENT);
    // narrative is now part of the signal the relevance filter sees.
    assert.equal(slim.narrative, 'long narrative should be stripped');
    assert.equal('futurePreferences' in slim, false);
    assert.deepEqual(slim.excludedCompanies, ['Acme']);
    assert.equal(slim.seniority, 'senior');
});

test('compactIntent trims an over-long narrative to 400 chars + ellipsis', () => {
    const long = 'x'.repeat(800);
    const slim = compactIntent({ ...INTENT, narrative: long });
    assert.equal(slim.narrative.length, 401); // 400 + ellipsis char
    assert.ok(slim.narrative.endsWith('…'));
});

test('compactIntent threads operator remarks through as operatorRemarks', () => {
    const slim = compactIntent({
        ...INTENT,
        remarks: '  no entry-level jobs; prefer health-tech  ',
    });
    assert.equal(slim.operatorRemarks, 'no entry-level jobs; prefer health-tech');
});

test('compactIntent truncates over-long remarks to 1000 chars', () => {
    const long = 'y'.repeat(1500);
    const slim = compactIntent({ ...INTENT, remarks: long });
    assert.equal(slim.operatorRemarks.length, 1001); // 1000 + ellipsis
    assert.ok(slim.operatorRemarks.endsWith('…'));
});

test('compactIntent omits operatorRemarks when empty or absent', () => {
    const none = compactIntent(INTENT);
    assert.equal('operatorRemarks' in none, false);
    const blank = compactIntent({ ...INTENT, remarks: '   ' });
    assert.equal('operatorRemarks' in blank, false);
});

test('SYSTEM_PROMPT documents the operator remarks override path', () => {
    assert.match(SYSTEM_PROMPT, /operatorRemarks/);
    assert.match(SYSTEM_PROMPT, /HARD constraint|hard constraint/i);
});

test('SYSTEM_PROMPT calls out domain-agnostic scope (not just tech)', () => {
    assert.match(SYSTEM_PROMPT, /medical|nursing|law|finance|sales|non-tech/i);
    assert.match(SYSTEM_PROMPT, /aboutCandidate/);
});

test('compactIntent threads aboutCandidate when present', () => {
    const slim = compactIntent({
        ...INTENT,
        aboutCandidate: 'ICU RN with 3 yrs critical care at Cedars-Sinai, paediatric focus.',
    });
    assert.match(slim.aboutCandidate, /ICU RN/);
});

test('compactIntent omits aboutCandidate when empty', () => {
    const slim = compactIntent(INTENT);
    assert.equal('aboutCandidate' in slim, false);
});

test('compactIntent truncates aboutCandidate > 1200 chars', () => {
    const long = 'z'.repeat(2000);
    const slim = compactIntent({ ...INTENT, aboutCandidate: long });
    assert.ok(slim.aboutCandidate.length <= 1201);
    assert.ok(slim.aboutCandidate.endsWith('…'));
});

test('compactIntent emits skills/industries/YoE only when set', () => {
    const with_ext = compactIntent({
        ...INTENT,
        skills: ['Go', 'Python', 'Kubernetes'],
        industries: ['Finance'],
        minYearsOfExperience: 4,
        maxYearsOfExperience: 8,
    });
    assert.deepEqual(with_ext.skills, ['Go', 'Python', 'Kubernetes']);
    assert.deepEqual(with_ext.industries, ['Finance']);
    assert.equal(with_ext.minYearsOfExperience, 4);
    assert.equal(with_ext.maxYearsOfExperience, 8);

    const bare = compactIntent(INTENT);
    assert.equal('skills' in bare, false);
    assert.equal('industries' in bare, false);
    assert.equal('minYearsOfExperience' in bare, false);
});

test('compactIntent fills defaults for missing fields', () => {
    const slim = compactIntent({});
    assert.deepEqual(slim.roles, []);
    assert.deepEqual(slim.locations, []);
    assert.equal(slim.seniority, 'mid');
    assert.equal(slim.workAuth, '');
});

test('buildUserPrompt is deterministic for identical inputs', () => {
    const a = buildUserPrompt({ intent: INTENT, jobs: [JOB, JOB] });
    const b = buildUserPrompt({ intent: INTENT, jobs: [JOB, JOB] });
    assert.equal(a, b);
});

test('buildUserPrompt includes SEARCH INTENT + JOBS blocks + output instruction', () => {
    const p = buildUserPrompt({ intent: INTENT, jobs: [JOB] });
    assert.match(p, /SEARCH INTENT:/);
    assert.match(p, /JOBS \(1\):/);
    assert.match(p, /"decisions":\[/);
    // must NOT include the full description
    assert.doesNotMatch(p, /full description that should NOT appear/);
    // must include JR id so the model can echo it back
    assert.match(p, /"id": "jr1"/);
});
