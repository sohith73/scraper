import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SYSTEM_PROMPT,
    buildUserPrompt,
    pickProfileSignal,
    truncateResumeBlob,
} from '../../src/services/intent/prompts.js';

test('SYSTEM_PROMPT is stable text (snapshot by hash length)', () => {
    // We don't snapshot the full text — just assert it's non-trivial and
    // mentions the canonical seniority enum so accidental edits get flagged.
    assert.ok(SYSTEM_PROMPT.length > 400);
    assert.match(SYSTEM_PROMPT, /seniority/);
    assert.match(SYSTEM_PROMPT, /intern\s*\|\s*entry/);
    assert.match(SYSTEM_PROMPT, /JSON/);
});

test('pickProfileSignal keeps the whitelist and drops everything else', () => {
    const picked = pickProfileSignal({
        firstName: 'Alice',
        lastName: 'Doe',
        dob: '1990-01-01', // MUST drop — PII, not in whitelist
        ssn: '123', // MUST drop
        preferredRoles: ['Backend Engineer'],
        targetCompanies: ['Stripe'],
        unknownField: 'ignored',
    });
    assert.deepEqual(Object.keys(picked).sort(), [
        'firstName',
        'lastName',
        'preferredRoles',
        'targetCompanies',
    ]);
});

test('pickProfileSignal drops null / empty / empty-array values', () => {
    const picked = pickProfileSignal({
        firstName: 'Alice',
        lastName: '',
        preferredRoles: [],
        preferredLocations: null,
        targetCompanies: ['Stripe'],
    });
    assert.deepEqual(picked, {
        firstName: 'Alice',
        targetCompanies: ['Stripe'],
    });
});

test('pickProfileSignal handles null input', () => {
    assert.deepEqual(pickProfileSignal(null), {});
    assert.deepEqual(pickProfileSignal(undefined), {});
});

test('truncateResumeBlob returns full JSON when under limit', () => {
    const resume = { a: 1 };
    const out = truncateResumeBlob(resume, 4000);
    assert.equal(out, '{"a":1}');
});

test('truncateResumeBlob truncates long input', () => {
    const big = { blob: 'x'.repeat(10_000) };
    const out = truncateResumeBlob(big, 1000);
    assert.ok(out.length <= 1000 + 40);
    assert.match(out, /truncated from \d+ chars/);
});

test('truncateResumeBlob returns empty string for falsy input', () => {
    assert.equal(truncateResumeBlob(null), '');
    assert.equal(truncateResumeBlob(undefined), '');
});

test('buildUserPrompt is deterministic for identical input', () => {
    const profile = { firstName: 'A', preferredRoles: ['Backend'] };
    const a = buildUserPrompt({ profile });
    const b = buildUserPrompt({ profile });
    assert.equal(a, b);
});

test('buildUserPrompt includes profile JSON and omits resume when absent', () => {
    const prompt = buildUserPrompt({
        profile: { firstName: 'Alice', preferredRoles: ['Backend Engineer'] },
        clientEmail: 'a@b.com',
    });
    assert.match(prompt, /CLIENT: a@b\.com/);
    assert.match(prompt, /PROFILE/);
    assert.match(prompt, /"firstName": "Alice"/);
    assert.doesNotMatch(prompt, /RESUME/);
});

test('buildUserPrompt includes truncated resume when provided', () => {
    const prompt = buildUserPrompt({
        profile: { firstName: 'Alice' },
        resume: { summary: 'x'.repeat(10_000) },
    });
    assert.match(prompt, /RESUME/);
    assert.match(prompt, /truncated from/);
});
