// Summariser tests. We inject a fake `ai` object (createOpenAIClient-shaped)
// so nothing hits OpenAI. Real schema + real prompt builder are exercised.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProfile } from '../../src/services/intent/summarizer.js';

// fakeAi: returns { completeJson(args) } with canned responses. Records
// every call so tests can assert what we sent to the model.
function fakeAi({ aiIntent, throwResult, calls = [] }) {
    return {
        completeJson: async (args) => {
            calls.push(args);
            if (throwResult) return throwResult;
            // Simulate the openaiClient success envelope shape.
            return {
                ok: true,
                value: { value: aiIntent, cacheHit: false, key: 'k' },
            };
        },
        _calls: calls,
    };
}

const VALID_AI_INTENT = {
    roles: ['Backend Engineer'],
    locations: ['Remote'],
    seniority: 'senior',
    companies: ['Stripe'],
    workAuth: 'H1B required',
    narrative: 'Senior backend engineer seeking remote roles.',
    futurePreferences: '',
};

const VALID_PROFILE = {
    firstName: 'Alice',
    preferredRoles: ['Backend Engineer'],
    preferredLocations: ['Remote'],
    visaStatus: 'F1 OPT',
    experienceLevel: '4-7 Years',
    targetCompanies: ['Stripe'],
};

test('BAD_INPUT when ai missing', async () => {
    const r = await summarizeProfile({ profile: VALID_PROFILE });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('BAD_INPUT when profile missing', async () => {
    const r = await summarizeProfile({ ai: fakeAi({ aiIntent: VALID_AI_INTENT }) });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('happy path: returns fused SearchIntent with exclusions', async () => {
    const ai = fakeAi({ aiIntent: VALID_AI_INTENT });
    const r = await summarizeProfile({
        ai,
        profile: VALID_PROFILE,
        exclusions: { companies: ['Acme', 'acme'], locations: ['NYC'] },
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.intent.seniority, 'senior');
    assert.deepEqual(r.value.intent.roles, ['Backend Engineer']);
    assert.deepEqual(r.value.intent.exclusions, {
        companies: ['acme'], // normalised + deduped
        locations: ['nyc'],
    });
});

test('exclusions default to empty lists when not provided', async () => {
    const ai = fakeAi({ aiIntent: VALID_AI_INTENT });
    const r = await summarizeProfile({ ai, profile: VALID_PROFILE });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.intent.exclusions, { companies: [], locations: [] });
});

test('bubbles AI error untouched', async () => {
    const ai = fakeAi({
        throwResult: { ok: false, error: { code: 'RATE_LIMITED', message: 'slow down' } },
    });
    const r = await summarizeProfile({ ai, profile: VALID_PROFILE });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'RATE_LIMITED');
});

test('BAD_SHAPE if AI returns value that violates fused SearchIntent', async () => {
    // The AI output validation happens inside `ai.completeJson` via zodSchema;
    // here we simulate an edge case where the AI envelope is malformed post-parse.
    const ai = {
        completeJson: async () => ({
            ok: true,
            value: {
                value: { ...VALID_AI_INTENT, seniority: 'totally-bogus' },
                cacheHit: false,
                key: 'k',
            },
        }),
    };
    const r = await summarizeProfile({ ai, profile: VALID_PROFILE });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_SHAPE');
});

test('passes our system prompt + schema + zod validator to the AI', async () => {
    const ai = fakeAi({ aiIntent: VALID_AI_INTENT });
    await summarizeProfile({ ai, profile: VALID_PROFILE });
    const call = ai._calls[0];
    assert.match(call.system, /job-search strategist/i);
    assert.equal(call.schemaName, 'AiIntent');
    assert.equal(call.schema.properties.seniority.enum.includes('senior'), true);
    assert.ok(call.zodSchema, 'zodSchema should be set for double-validation');
});

test('includes clientEmail in the user prompt when provided', async () => {
    const ai = fakeAi({ aiIntent: VALID_AI_INTENT });
    await summarizeProfile({ ai, profile: VALID_PROFILE, clientEmail: 'alice@co.com' });
    assert.match(ai._calls[0].user, /CLIENT: alice@co\.com/);
});

test('propagates resume truncation flag into prompt', async () => {
    const ai = fakeAi({ aiIntent: VALID_AI_INTENT });
    const big = { summary: 'x'.repeat(10_000) };
    await summarizeProfile({ ai, profile: VALID_PROFILE, resume: big });
    assert.match(ai._calls[0].user, /truncated from/);
});

test('cacheHit flag surfaces through to caller', async () => {
    const ai = {
        completeJson: async () => ({
            ok: true,
            value: { value: VALID_AI_INTENT, cacheHit: true, key: 'hash' },
        }),
    };
    const r = await summarizeProfile({ ai, profile: VALID_PROFILE });
    assert.equal(r.ok, true);
    assert.equal(r.value.cacheHit, true);
    assert.equal(r.value.key, 'hash');
});
