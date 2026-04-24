// Tests for createOpenAIClient. Every test injects a fake completionFn —
// no SDK, no network, no env var needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createOpenAIClient } from '../../src/ai/openaiClient.js';
import { createAiCache } from '../../src/ai/cache.js';

// makeCompletion: helper that returns a function simulating OpenAI's
// chat.completions.create with a canned JSON string content.
function makeCompletion({ content, throws, calls = [] } = {}) {
    const fn = async (args) => {
        calls.push({ args });
        if (throws) throw (typeof throws === 'function' ? throws(calls.length) : throws);
        return {
            id: 'mock',
            choices: [{ message: { content } }],
        };
    };
    fn.calls = calls;
    return fn;
}

test('BAD_INPUT when system or user is not a string', async () => {
    const ai = createOpenAIClient({ apiKey: 'x', completionFn: async () => ({}) });
    let r = await ai.completeJson({ system: 42, user: 'u' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
    r = await ai.completeJson({ system: 's', user: null });
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('happy path: returns parsed JSON, cacheHit=false', async () => {
    const completionFn = makeCompletion({ content: '{"a":1,"b":"x"}' });
    const ai = createOpenAIClient({ apiKey: 'x', completionFn });
    const r = await ai.completeJson({ system: 's', user: 'u' });
    assert.equal(r.ok, true);
    assert.equal(r.value.cacheHit, false);
    assert.deepEqual(r.value.value, { a: 1, b: 'x' });
    assert.equal(completionFn.calls.length, 1);
});

test('uses json_object response_format when no schema provided', async () => {
    const completionFn = makeCompletion({ content: '{}' });
    const ai = createOpenAIClient({ apiKey: 'x', completionFn });
    await ai.completeJson({ system: 's', user: 'u' });
    assert.deepEqual(completionFn.calls[0].args.response_format, { type: 'json_object' });
});

test('uses json_schema/strict when schema provided', async () => {
    const completionFn = makeCompletion({ content: '{}' });
    const ai = createOpenAIClient({ apiKey: 'x', completionFn });
    const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };
    await ai.completeJson({ system: 's', user: 'u', schema, schemaName: 'Foo' });
    const rf = completionFn.calls[0].args.response_format;
    assert.equal(rf.type, 'json_schema');
    assert.equal(rf.json_schema.name, 'Foo');
    assert.equal(rf.json_schema.strict, true);
    assert.deepEqual(rf.json_schema.schema, schema);
});

test('BAD_JSON when model returns non-JSON content', async () => {
    const completionFn = makeCompletion({ content: 'sorry, I cannot do that' });
    const ai = createOpenAIClient({ apiKey: 'x', completionFn });
    const r = await ai.completeJson({ system: 's', user: 'u' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_JSON');
});

test('BAD_SHAPE when choices[0].message.content missing', async () => {
    const completionFn = async () => ({ choices: [{}] });
    const ai = createOpenAIClient({ apiKey: 'x', completionFn });
    const r = await ai.completeJson({ system: 's', user: 'u' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_SHAPE');
});

test('zodSchema validation success', async () => {
    const completionFn = makeCompletion({ content: '{"age":30}' });
    const ai = createOpenAIClient({ apiKey: 'x', completionFn });
    const Schema = z.object({ age: z.number() });
    const r = await ai.completeJson({ system: 's', user: 'u', zodSchema: Schema });
    assert.equal(r.ok, true);
    assert.equal(r.value.value.age, 30);
});

test('zodSchema validation failure → BAD_SHAPE', async () => {
    const completionFn = makeCompletion({ content: '{"age":"thirty"}' });
    const ai = createOpenAIClient({ apiKey: 'x', completionFn });
    const Schema = z.object({ age: z.number() });
    const r = await ai.completeJson({ system: 's', user: 'u', zodSchema: Schema });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_SHAPE');
});

test('401 → AUTH, no retry', async () => {
    const err401 = Object.assign(new Error('bad key'), { status: 401 });
    const completionFn = makeCompletion({ throws: err401 });
    const ai = createOpenAIClient({ apiKey: 'x', completionFn, retries: 3 });
    const r = await ai.completeJson({ system: 's', user: 'u' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AUTH');
    assert.equal(completionFn.calls.length, 1);
});

test('429 retries then succeeds', async () => {
    const err429 = Object.assign(new Error('rate limited'), { status: 429 });
    const completionFn = makeCompletion({
        throws: (callNumber) => (callNumber <= 2 ? err429 : null),
    });
    // After 2 throws the helper returns the canned success — but our helper
    // above always rejects if `throws` is truthy. Re-do with a custom fn:
    const calls = [];
    const fn = async (args) => {
        calls.push(args);
        if (calls.length <= 2) throw err429;
        return { choices: [{ message: { content: '{"ok":true}' } }] };
    };
    const ai = createOpenAIClient({ apiKey: 'x', completionFn: fn, retries: 3 });
    const r = await ai.completeJson({ system: 's', user: 'u' });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 3);
});

test('5xx retries up to limit then SERVER_ERROR', async () => {
    const err503 = Object.assign(new Error('unavailable'), { status: 503 });
    const calls = [];
    const fn = async () => {
        calls.push(1);
        throw err503;
    };
    const ai = createOpenAIClient({ apiKey: 'x', completionFn: fn, retries: 2 });
    const r = await ai.completeJson({ system: 's', user: 'u' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'SERVER_ERROR');
    assert.equal(calls.length, 3); // initial + 2 retries
});

test('timeout → TIMEOUT', async () => {
    const abortErr = Object.assign(new Error('timeout'), { name: 'AbortError' });
    const fn = async () => {
        throw abortErr;
    };
    const ai = createOpenAIClient({ apiKey: 'x', completionFn: fn, retries: 0 });
    const r = await ai.completeJson({ system: 's', user: 'u' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'TIMEOUT');
});

test('cache hit: second identical call does not hit SDK', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-ai-'));
    try {
        const cache = createAiCache({ dir });
        const calls = [];
        const fn = async (args) => {
            calls.push(args);
            return { choices: [{ message: { content: '{"v":1}' } }] };
        };
        const ai = createOpenAIClient({ apiKey: 'x', completionFn: fn, cache });
        const r1 = await ai.completeJson({ system: 's', user: 'u' });
        const r2 = await ai.completeJson({ system: 's', user: 'u' });
        assert.equal(r1.ok, true);
        assert.equal(r2.ok, true);
        assert.equal(r1.value.cacheHit, false);
        assert.equal(r2.value.cacheHit, true);
        assert.deepEqual(r2.value.value, { v: 1 });
        assert.equal(calls.length, 1);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('cache: different user prompt bypasses cache and calls SDK', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-ai-'));
    try {
        const cache = createAiCache({ dir });
        const calls = [];
        const fn = async (args) => {
            calls.push(args.messages[1].content);
            return { choices: [{ message: { content: '{"v":1}' } }] };
        };
        const ai = createOpenAIClient({ apiKey: 'x', completionFn: fn, cache });
        await ai.completeJson({ system: 's', user: 'user-a' });
        await ai.completeJson({ system: 's', user: 'user-b' });
        assert.deepEqual(calls, ['user-a', 'user-b']);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('cache: different model invalidates the cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-ai-'));
    try {
        const cache = createAiCache({ dir });
        let n = 0;
        const fn = async () => {
            n += 1;
            return { choices: [{ message: { content: `{"n":${n}}` } }] };
        };
        const ai4o = createOpenAIClient({ apiKey: 'x', completionFn: fn, cache, model: 'gpt-4o-mini' });
        const ai4 = createOpenAIClient({ apiKey: 'x', completionFn: fn, cache, model: 'gpt-4o' });
        const r1 = await ai4o.completeJson({ system: 's', user: 'u' });
        const r2 = await ai4.completeJson({ system: 's', user: 'u' });
        assert.equal(r1.value.value.n, 1);
        assert.equal(r2.value.value.n, 2);
        assert.equal(n, 2);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('messages sent to SDK include our system and user roles', async () => {
    const calls = [];
    const fn = async (args) => {
        calls.push(args);
        return { choices: [{ message: { content: '{}' } }] };
    };
    const ai = createOpenAIClient({ apiKey: 'x', completionFn: fn, model: 'gpt-4o-mini' });
    await ai.completeJson({ system: 'SYS', user: 'USR' });
    assert.equal(calls[0].model, 'gpt-4o-mini');
    assert.equal(calls[0].messages[0].role, 'system');
    assert.equal(calls[0].messages[0].content, 'SYS');
    assert.equal(calls[0].messages[1].role, 'user');
    assert.equal(calls[0].messages[1].content, 'USR');
    assert.equal(calls[0].temperature, 0.1);
});
