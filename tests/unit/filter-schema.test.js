// Unit tests for the JR filter schema gate.
//
// These pin the exact field types JR's Java backend expects and protect
// against future regressions where a string sneaks into an array slot
// (the prod failure that motivated the gate: excludedTitle as a comma-
// joined string → 400 with a Jackson stack trace).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJRFilter } from '../../src/services/search/filterSchema.js';

const VALID = {
    jobTitle: 'Software Engineer',
    country: 'US',
    jobTaxonomyList: [{ taxonomyId: '01-01-01', title: 'Software Engineer' }],
    skills: ['TypeScript', 'Node.js'],
    companies: [],
    excludedCompanies: [],
    excludedTitle: [],
    companyCategory: [],
    jobTypes: [1],
    seniority: [3],
    workModel: [1, 2],
    locations: [{ city: 'San Francisco', radiusRange: 25 }],
    excludedSkills: null,
    minYearsOfExperienceRange: [0, 4],
    companyStages: null,
    roleType: null,
    excludeCompanyCategory: null,
    city: null,
    annualSalaryMinimum: null,
    daysAgo: 14,
    radiusRange: 25,
    isH1BOnly: false,
    excludeSecurityClearance: true,
    excludeUsCitizen: true,
    excludeStaffingAgency: false,
    hiddenJobsOnly: null,
    recommendationPreference: null,
};

test('validateJRFilter: passes a fully-shaped payload', () => {
    const r = validateJRFilter(VALID);
    assert.equal(r.ok, true);
});

test('validateJRFilter: rejects excludedTitle as STRING (the actual prod 400)', () => {
    const r = validateJRFilter({ ...VALID, excludedTitle: 'Technician' });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.path === 'excludedTitle'));
});

test('validateJRFilter: rejects skills/companies as a string', () => {
    const a = validateJRFilter({ ...VALID, skills: 'TypeScript' });
    assert.equal(a.ok, false);
    assert.ok(a.issues.some((i) => i.path === 'skills'));
    const b = validateJRFilter({ ...VALID, companies: 'Acme' });
    assert.equal(b.ok, false);
});

test('validateJRFilter: array-of-int fields reject strings', () => {
    for (const f of ['jobTypes', 'seniority', 'workModel']) {
        const r = validateJRFilter({ ...VALID, [f]: ['1', '2'] });
        assert.equal(r.ok, false, `${f} should reject string array`);
        assert.ok(r.issues.some((i) => i.path.startsWith(f)));
    }
});

test('validateJRFilter: locations entries must have city + numeric radius', () => {
    const r = validateJRFilter({
        ...VALID,
        locations: [{ city: 'Durham' }], // missing radiusRange
    });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.path.includes('radiusRange')));
});

test('validateJRFilter: jobTitle must be a string (not array)', () => {
    const r = validateJRFilter({ ...VALID, jobTitle: ['Software Engineer'] });
    assert.equal(r.ok, false);
});

test('validateJRFilter: nullable arrays allow null OR array', () => {
    const a = validateJRFilter({ ...VALID, companyStages: null });
    assert.equal(a.ok, true);
    const b = validateJRFilter({ ...VALID, companyStages: [1, 2] });
    assert.equal(b.ok, true);
});

test('validateJRFilter: passthrough — unknown JR fields do not fail', () => {
    const r = validateJRFilter({ ...VALID, futureFieldFromJR: { some: 'shape' } });
    assert.equal(r.ok, true);
});

test('validateJRFilter: company arrays accept either strings or {companyName} objects', () => {
    const a = validateJRFilter({ ...VALID, excludedCompanies: ['Acme'] });
    assert.equal(a.ok, true);
    const b = validateJRFilter({
        ...VALID,
        excludedCompanies: [{ companyName: 'Acme' }, { companyName: 'RulAout' }],
    });
    assert.equal(b.ok, true);
});

test('validateJRFilter: surfaces issue path + expected/received for diagnostics', () => {
    const r = validateJRFilter({ ...VALID, jobTypes: 'oops' });
    assert.equal(r.ok, false);
    const iss = r.issues.find((i) => i.path === 'jobTypes');
    assert.ok(iss, 'must report jobTypes path');
    assert.match(iss.message + ' ' + (iss.expected || ''), /array/i);
});
