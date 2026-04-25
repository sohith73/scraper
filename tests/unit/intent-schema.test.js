import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    AiIntent,
    SearchIntent,
    SeniorityEnum,
    AI_INTENT_JSON_SCHEMA,
} from '../../src/services/intent/schema.js';

const VALID_AI = {
    roles: ['Backend Engineer'],
    locations: ['San Francisco, CA', 'Remote'],
    seniority: 'senior',
    companies: ['Stripe'],
    workAuth: 'H1B required',
    narrative: 'Senior backend engineer on F1 OPT seeking US-remote roles.',
    futurePreferences: '',
    aboutCandidate: 'Senior backend engineer specialising in distributed systems.',
};

test('AiIntent accepts a minimal valid shape', () => {
    const r = AiIntent.safeParse(VALID_AI);
    assert.equal(r.success, true);
});

test('AiIntent rejects unknown seniority value', () => {
    const r = AiIntent.safeParse({ ...VALID_AI, seniority: 'principal' });
    assert.equal(r.success, false);
});

test('AiIntent caps roles at 15', () => {
    const r = AiIntent.safeParse({
        ...VALID_AI,
        roles: Array.from({ length: 16 }, (_, i) => `r${i}`),
    });
    assert.equal(r.success, false);
});

test('AiIntent requires every field', () => {
    const missing = { ...VALID_AI };
    delete missing.narrative;
    const r = AiIntent.safeParse(missing);
    assert.equal(r.success, false);
});

test('SearchIntent requires exclusions object', () => {
    const r = SearchIntent.safeParse({ ...VALID_AI });
    assert.equal(r.success, false);

    const ok = SearchIntent.safeParse({
        ...VALID_AI,
        exclusions: { companies: [], locations: [] },
    });
    assert.equal(ok.success, true);
});

test('SeniorityEnum lists the expected six levels', () => {
    assert.deepEqual(SeniorityEnum.options, [
        'intern',
        'entry',
        'mid',
        'senior',
        'lead',
        'exec',
    ]);
});

test('AI_INTENT_JSON_SCHEMA required list covers every zod key including extended filters', () => {
    const required = AI_INTENT_JSON_SCHEMA.required.slice().sort();
    // Core fields
    for (const k of ['roles', 'locations', 'seniority', 'companies', 'workAuth', 'narrative', 'futurePreferences', 'aboutCandidate']) {
        assert.ok(required.includes(k), `missing core required: ${k}`);
    }
    // Extended filter knobs — optional semantically but listed in required per
    // OpenAI strict-mode convention (with `type: [X, 'null']`).
    for (const k of [
        'employmentTypes',
        'workModels',
        'daysAgo',
        'minYearsOfExperience',
        'maxYearsOfExperience',
        'salaryMinimumUsd',
        'industries',
        'skills',
        'companyStages',
        'roleType',
        'excludedTitles',
        'excludedSkills',
        'excludedIndustries',
        'excludeStaffingAgency',
        'excludeSecurityClearance',
        'excludeUsCitizenOnly',
    ]) {
        assert.ok(required.includes(k), `missing extended required: ${k}`);
    }
    assert.equal(AI_INTENT_JSON_SCHEMA.additionalProperties, false);
});
