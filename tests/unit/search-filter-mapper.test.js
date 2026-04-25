import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    searchIntentToJRFilter,
    SENIORITY_ENUM_MAP,
    WORK_MODEL,
    JOB_TYPES,
    DEFAULT_RADIUS_MILES,
} from '../../src/services/search/filterMapper.js';

const MIN_INTENT = {
    roles: ['Backend Engineer'],
    locations: ['San Francisco, CA'],
    seniority: 'senior',
    companies: ['Stripe'],
    workAuth: 'US Citizen',
    narrative: '',
    futurePreferences: '',
    exclusions: { companies: [], locations: [] },
};

test('throws on missing intent', () => {
    assert.throws(() => searchIntentToJRFilter({}), /intent is required/);
    assert.throws(() => searchIntentToJRFilter(), /intent is required/);
});

test('produces a payload with all JR keys present', () => {
    const f = searchIntentToJRFilter({ intent: MIN_INTENT });
    const requiredKeys = [
        'jobTitle',
        'jobTaxonomyList',
        'jobTypes',
        'country',
        'city',
        'seniority',
        'companyCategory',
        'annualSalaryMinimum',
        'isH1BOnly',
        'roleType',
        'skills',
        'companyStages',
        'excludedTitle',
        'excludedCompanies',
        'excludedSkills',
        'excludeStaffingAgency',
        'minYearsOfExperienceRange',
        'daysAgo',
        'companies',
        'excludeCompanyCategory',
        'excludeSecurityClearance',
        'excludeUsCitizen',
        'hiddenJobsOnly',
        'recommendationPreference',
        'workModel',
        'locations',
        'radiusRange',
    ];
    for (const k of requiredKeys) {
        assert.ok(k in f, `missing key: ${k}`);
    }
});

test('roles are joined as comma-separated jobTitle (first 2 only — JR 400s on long strings)', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, roles: ['Backend', 'Platform', 'Infra'] },
    });
    assert.equal(f.jobTitle, 'Backend, Platform');
});

test('seniority maps to JR integer array', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, seniority: 'senior' },
    });
    assert.deepEqual(f.seniority, [SENIORITY_ENUM_MAP.senior]);
});

test('unknown seniority falls back to mid', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, seniority: 'wizard' },
    });
    assert.deepEqual(f.seniority, [SENIORITY_ENUM_MAP.mid]);
});

test('H1B mention in workAuth sets isH1BOnly', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, workAuth: 'Requires H1B sponsorship' },
    });
    assert.equal(f.isH1BOnly, true);
});

test('non-H1B workAuth leaves isH1BOnly false', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, workAuth: 'US Citizen' },
    });
    assert.equal(f.isH1BOnly, false);
});

test('locations with Remote narrows workModel to [Remote, Hybrid]', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, locations: ['San Francisco, CA', 'Remote'] },
    });
    assert.deepEqual(f.workModel, [WORK_MODEL.REMOTE, WORK_MODEL.HYBRID]);
});

test('locations without Remote keeps all three workModels', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, locations: ['New York, NY'] },
    });
    assert.deepEqual(f.workModel, [
        WORK_MODEL.ONSITE,
        WORK_MODEL.REMOTE,
        WORK_MODEL.HYBRID,
    ]);
});

test('Remote-only intent strips Remote from locations list', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, locations: ['Remote'] },
    });
    // No city locations → fallback to country-wide
    assert.deepEqual(f.locations, [{ city: 'Within US', radiusRange: DEFAULT_RADIUS_MILES }]);
});

test('locations map to {city, radiusRange} objects', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, locations: ['Austin, TX', 'Denver, CO'] },
    });
    assert.deepEqual(f.locations, [
        { city: 'Austin, TX', radiusRange: DEFAULT_RADIUS_MILES },
        { city: 'Denver, CO', radiusRange: DEFAULT_RADIUS_MILES },
    ]);
});

test('empty locations → country-wide default', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, locations: [] },
    });
    assert.equal(f.locations[0].city, 'Within US');
});

test('excludedCompanies merge: intent + existing → {companyName} objects, deduped', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, exclusions: { companies: ['acme', 'BetaCo'], locations: [] } },
        existing: {
            excludedCompanies: [
                { companyName: 'acme' },
                { companyName: 'gamma' },
            ],
        },
    });
    const names = f.excludedCompanies.map((c) => c.companyName).sort();
    assert.deepEqual(names, ['BetaCo', 'acme', 'gamma']);
    for (const c of f.excludedCompanies) assert.ok(c.companyName);
});

test('empty existing → default jobTypes is Full-time', () => {
    const f = searchIntentToJRFilter({ intent: MIN_INTENT });
    assert.deepEqual(f.jobTypes, [JOB_TYPES.FULL_TIME]);
});

test('existing.jobTypes preserved when set', () => {
    const f = searchIntentToJRFilter({
        intent: MIN_INTENT,
        existing: { jobTypes: [JOB_TYPES.FULL_TIME, JOB_TYPES.CONTRACT] },
    });
    assert.deepEqual(f.jobTypes, [JOB_TYPES.FULL_TIME, JOB_TYPES.CONTRACT]);
});

test('jobTaxonomyList: resolvedTaxonomyList REPLACES existing stale entries', () => {
    // Reproduces + fixes the bug: a client's previously-saved
    // taxonomyList ("Backend Engineer" for a Data Scientist intent)
    // overrode our free-text jobTitle and caused JR to return wrong-role
    // jobs. runSearch now resolves intent.roles to canonical taxonomy IDs
    // via /swan/filter/support/titles and passes the result as
    // `resolvedTaxonomyList` — which always wins over existing.
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, roles: ['Data Scientist', 'ML Engineer'] },
        existing: {
            jobTaxonomyList: [
                { taxonomyId: '01-01-01', title: 'Backend Engineer' },
                { taxonomyId: '01-01-02', title: 'Java Engineer' },
            ],
        },
        resolvedTaxonomyList: [
            { taxonomyId: '01-08-02', title: 'Data Scientist' },
            { taxonomyId: '01-06-01', title: 'Machine Learning Engineer' },
        ],
    });
    assert.deepEqual(f.jobTaxonomyList, [
        { taxonomyId: '01-08-02', title: 'Data Scientist' },
        { taxonomyId: '01-06-01', title: 'Machine Learning Engineer' },
    ]);
    // jobTitle now prefers the canonical taxonomy titles (when resolved)
    // over the user's free-text role strings — the canonical titles are
    // guaranteed to be in JR's accepted vocabulary.
    assert.equal(f.jobTitle, 'Data Scientist, Machine Learning Engineer');
});

test('jobTitle: sanitises ampersand + odd chars to keep JR happy (R&D Engineer triggers 400)', () => {
    // Real prod failure: roles=['R&D Engineer','Product Development Engineer']
    // produced jobTitle="Product Development Engineer, R&D Engineer" and JR
    // returned filter-update status=400. The `&` is the culprit.
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, roles: ['R&D Engineer', 'Product (Lead) Engineer'] },
        existing: {},
        resolvedTaxonomyList: [],
    });
    assert.ok(!/&/.test(f.jobTitle), 'no & in jobTitle');
    assert.ok(!/[()]/.test(f.jobTitle), 'no parens in jobTitle');
    assert.match(f.jobTitle, /R and D Engineer/);
});

test('jobTaxonomyList: without resolvedTaxonomyList, existing entries are preserved', () => {
    // JR rejects empty taxonomyList with 400 "bad request". So when no
    // resolved list is supplied (legacy call sites, unit tests), we pass
    // through whatever existing had. runSearch is the only production
    // caller and always resolves first.
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, roles: ['Data Scientist'] },
        existing: {
            jobTaxonomyList: [{ taxonomyId: '01-01-01', title: 'Backend Engineer' }],
        },
    });
    assert.deepEqual(f.jobTaxonomyList, [{ taxonomyId: '01-01-01', title: 'Backend Engineer' }]);
});

test('companies: intent wishlist NOT forwarded (JR treats as exclusive — empty on purpose)', () => {
    // Rationale: JR filters to ONLY those companies. A 20-company wishlist
    // + entry-level + H1B usually yields 0 jobs. The wishlist is better
    // used as an AI-relevance-filter signal.
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, companies: ['Stripe', 'Cloudflare'] },
    });
    assert.deepEqual(f.companies, []);
});

test('country is always US', () => {
    const f = searchIntentToJRFilter({ intent: MIN_INTENT });
    assert.equal(f.country, 'US');
});

test('empty roles → empty jobTitle string (JR accepts this)', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, roles: [] },
    });
    assert.equal(f.jobTitle, '');
});

// ----- Extended filter knobs ------------------------------------------

test('employmentTypes: aliases map to JR int codes + dedupe', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, employmentTypes: ['full-time', 'contract', 'full-time'] },
    });
    assert.deepEqual(f.jobTypes.sort(), [1, 2]);
});

test('employmentTypes: unknown alias → fallback to default Full-time', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, employmentTypes: ['wizard'] },
    });
    assert.deepEqual(f.jobTypes, [1]);
});

test('workModels: explicit override wins over Remote-in-locations signal', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, locations: ['Remote'], workModels: ['onsite'] },
    });
    assert.deepEqual(f.workModel, [1]);
});

test('daysAgo: intent > base > null', () => {
    const f1 = searchIntentToJRFilter({ intent: { ...MIN_INTENT, daysAgo: 7 } });
    assert.equal(f1.daysAgo, 7);
    const f2 = searchIntentToJRFilter({ intent: MIN_INTENT, existing: { daysAgo: 14 } });
    assert.equal(f2.daysAgo, 14);
    const f3 = searchIntentToJRFilter({ intent: MIN_INTENT });
    assert.equal(f3.daysAgo, null);
});

test('YoE range: minOnly→[min,40]; maxOnly→[0,max]; both→[min,max]; neither→null', () => {
    assert.deepEqual(
        searchIntentToJRFilter({ intent: { ...MIN_INTENT, minYearsOfExperience: 3 } }).minYearsOfExperienceRange,
        [3, 40],
    );
    assert.deepEqual(
        searchIntentToJRFilter({ intent: { ...MIN_INTENT, maxYearsOfExperience: 5 } }).minYearsOfExperienceRange,
        [0, 5],
    );
    assert.deepEqual(
        searchIntentToJRFilter({ intent: { ...MIN_INTENT, minYearsOfExperience: 2, maxYearsOfExperience: 7 } }).minYearsOfExperienceRange,
        [2, 7],
    );
    assert.equal(
        searchIntentToJRFilter({ intent: MIN_INTENT }).minYearsOfExperienceRange,
        null,
    );
});

test('salaryMinimumUsd → annualSalaryMinimum', () => {
    assert.equal(
        searchIntentToJRFilter({ intent: { ...MIN_INTENT, salaryMinimumUsd: 150000 } }).annualSalaryMinimum,
        150000,
    );
});

test('industries → companyCategory; excludedIndustries → excludeCompanyCategory', () => {
    const f = searchIntentToJRFilter({
        intent: {
            ...MIN_INTENT,
            industries: ['Finance', 'Information Technology'],
            excludedIndustries: ['Gambling'],
        },
    });
    assert.deepEqual(f.companyCategory, ['Finance', 'Information Technology']);
    assert.deepEqual(f.excludeCompanyCategory, ['Gambling']);
});

test('skills + excludedSkills pass through + dedupe', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, skills: ['Python', 'Python', 'Go'], excludedSkills: ['Perl'] },
    });
    assert.deepEqual(f.skills.sort(), ['Go', 'Python']);
    assert.deepEqual(f.excludedSkills, ['Perl']);
});

test('companyStages alias → JR string codes', () => {
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, companyStages: ['seed', 'growth-stage', 'public'] },
    });
    assert.deepEqual(f.companyStages.sort(), ['1', '3', '5']);
});

test('companyStages: empty → null', () => {
    assert.equal(
        searchIntentToJRFilter({ intent: MIN_INTENT }).companyStages,
        null,
    );
});

test('roleType alias → JR string', () => {
    assert.equal(
        searchIntentToJRFilter({ intent: { ...MIN_INTENT, roleType: 'ic' } }).roleType,
        'IC',
    );
    assert.equal(
        searchIntentToJRFilter({ intent: { ...MIN_INTENT, roleType: 'manager' } }).roleType,
        'Manager',
    );
});

test('excludedTitles passed as ARRAY (JR deserializer rejects strings)', () => {
    // Real prod failure 2026-04-25: sending a comma-joined string for
    // excludedTitle made JR return 400 with
    // "Cannot construct instance of java.util.ArrayList ... String value ('Technician')"
    // because their server expects an array of titles.
    const f = searchIntentToJRFilter({
        intent: { ...MIN_INTENT, excludedTitles: ['QA Engineer', 'Test Engineer'] },
    });
    assert.deepEqual(f.excludedTitle, ['QA Engineer', 'Test Engineer']);
});

test('excludedTitle: stale string in `existing` is split into array', () => {
    const f = searchIntentToJRFilter({
        intent: MIN_INTENT,
        existing: { excludedTitle: 'Technician, Intern' },
    });
    assert.deepEqual(f.excludedTitle, ['Technician', 'Intern']);
});

test('excludeStaffingAgency / excludeSecurityClearance / excludeUsCitizenOnly pass through', () => {
    const f = searchIntentToJRFilter({
        intent: {
            ...MIN_INTENT,
            excludeStaffingAgency: true,
            excludeSecurityClearance: true,
            excludeUsCitizenOnly: true,
        },
    });
    assert.equal(f.excludeStaffingAgency, true);
    assert.equal(f.excludeSecurityClearance, true);
    assert.equal(f.excludeUsCitizen, true);
});

test('strips trailing ", USA" / ", US" from city strings (JR rejects 3-part form)', () => {
    const f = searchIntentToJRFilter({
        intent: {
            ...MIN_INTENT,
            locations: ['Cambridge, MA, USA', 'Austin, TX, United States'],
        },
    });
    assert.deepEqual(f.locations.map((l) => l.city), ['Cambridge, MA', 'Austin, TX']);
});

test('jobTitle trims to first two roles + 80-char cap', () => {
    const f = searchIntentToJRFilter({
        intent: {
            ...MIN_INTENT,
            roles: [
                'Biostatistician',
                'Epidemiologist',
                'Program Manager',
                'Research Analyst in Public Health',
                'Data Analyst in Public Health',
            ],
        },
    });
    assert.ok(f.jobTitle.length <= 80, `jobTitle too long: ${f.jobTitle.length}`);
    // Only the first 2 roles should appear.
    assert.match(f.jobTitle, /^Biostatistician.*Epidemiologist/);
    assert.equal(f.jobTitle.includes('Program Manager'), false);
});

test('country: defaults to US when intent omits it', () => {
    const f = searchIntentToJRFilter({ intent: MIN_INTENT });
    assert.equal(f.country, 'US');
});

test('country: accepts US + CA aliases only', () => {
    for (const [input, expected] of [
        ['US', 'US'], ['us', 'US'], ['USA', 'US'], ['United States', 'US'], ['United States of America', 'US'],
        ['CA', 'CA'], ['ca', 'CA'], ['can', 'CA'], ['Canada', 'CA'], ['canada', 'CA'],
    ]) {
        const f = searchIntentToJRFilter({ intent: { ...MIN_INTENT, country: input } });
        assert.equal(f.country, expected, `"${input}" → expected ${expected}, got ${f.country}`);
    }
});

test('country: any non-US/CA value falls back to US (stale saved records never leak to JR)', () => {
    for (const input of ['Atlantis', 'UK', 'IN', 'AU', 'DE', 'SG', 'britain']) {
        const f = searchIntentToJRFilter({ intent: { ...MIN_INTENT, country: input } });
        assert.equal(f.country, 'US', `"${input}" must fall back to US, got ${f.country}`);
    }
});

test('jobTitle very long single role → truncated with ellipsis', () => {
    const f = searchIntentToJRFilter({
        intent: {
            ...MIN_INTENT,
            roles: ['x'.repeat(200)],
        },
    });
    assert.ok(f.jobTitle.length <= 80);
    assert.ok(f.jobTitle.endsWith('...'));
});
