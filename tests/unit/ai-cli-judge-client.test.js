// Tests for createCliJudgeClient. Every test injects a fake `runFn` (the
// spawn-and-collect boundary) so nothing ever launches a real `claude`/`codex`
// process — fully deterministic, no network, no CLI needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createCliJudgeClient, extractJsonObject } from '../../src/ai/cliJudgeClient.js';
import { createAiCache } from '../../src/ai/cache.js';

const DECISIONS = z.object({
    decisions: z.array(z.object({ id: z.string(), pick: z.boolean(), score: z.number() })),
});
const GOOD = '{"decisions":[{"id":"j1","pick":true,"score":80}]}';

// makeRun: a fake runFn returning a canned CLI result. `calls` records every
// invocation so a test can assert the CLI was (or wasn't) spawned.
function makeRun(result, calls = []) {
    const fn = async (args) => {
        calls.push(args);
        return typeof result === 'function' ? result(calls.length) : result;
    };
    fn.calls = calls;
    return fn;
}

// makeFallback: a fake OpenAI client exposing completeJson, recording calls.
function makeFallback(content = GOOD, calls = []) {
    return {
        calls,
        completeJson: async (args) => {
            calls.push(args);
            return { ok: true, value: { value: JSON.parse(content), cacheHit: false, key: 'fk', usage: {} } };
        },
    };
}

test('BAD_INPUT when system/user are not strings', async () => {
    const judge = createCliJudgeClient({ runFn: makeRun({}) });
    const r = await judge.completeJson({ system: 1, user: 'u' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('happy path: parses CLI stdout, tags backend, never touches fallback', async () => {
    const fallback = makeFallback();
    const runFn = makeRun({ code: 0, stdout: GOOD, stderr: '', timedOut: false, spawnError: null });
    const judge = createCliJudgeClient({ backend: 'claude', fallback, runFn, zodSchema: null });
    const r = await judge.completeJson({ system: 's', user: 'u', zodSchema: DECISIONS });
    assert.equal(r.ok, true);
    assert.equal(r.value.backend, 'claude');
    assert.deepEqual(r.value.value, JSON.parse(GOOD));
    assert.equal(r.value.usage.totalTokens, 0); // CLI spend is plan-billed → 0 tokens
    assert.equal(fallback.calls.length, 0);
    assert.equal(runFn.calls.length, 1);
});

test('strips prose/code-fences around the JSON', async () => {
    const stdout = 'Here is the result:\n```json\n' + GOOD + '\n```\nDone.';
    const judge = createCliJudgeClient({ fallback: makeFallback(), runFn: makeRun({ code: 0, stdout, stderr: '', timedOut: false, spawnError: null }) });
    const r = await judge.completeJson({ system: 's', user: 'u', zodSchema: DECISIONS });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.value, JSON.parse(GOOD));
});

test('non-JSON output falls back to the API', async () => {
    const fallback = makeFallback();
    const judge = createCliJudgeClient({ fallback, runFn: makeRun({ code: 0, stdout: 'I cannot help with that.', stderr: '', timedOut: false, spawnError: null }) });
    const r = await judge.completeJson({ system: 's', user: 'u', zodSchema: DECISIONS });
    assert.equal(r.ok, true);
    assert.equal(r.value.backend, 'api-fallback');
    assert.equal(fallback.calls.length, 1);
});

test('schema mismatch falls back to the API', async () => {
    const fallback = makeFallback();
    const bad = '{"decisions":[{"id":"j1","pick":"yes"}]}'; // pick not boolean, no score
    const judge = createCliJudgeClient({ fallback, runFn: makeRun({ code: 0, stdout: bad, stderr: '', timedOut: false, spawnError: null }) });
    const r = await judge.completeJson({ system: 's', user: 'u', zodSchema: DECISIONS });
    assert.equal(r.ok, true);
    assert.equal(r.value.backend, 'api-fallback');
    assert.equal(fallback.calls.length, 1);
});

test('timeout falls back to the API', async () => {
    const fallback = makeFallback();
    const judge = createCliJudgeClient({ fallback, runFn: makeRun({ code: null, stdout: '', stderr: '', timedOut: true, spawnError: null }) });
    const r = await judge.completeJson({ system: 's', user: 'u', zodSchema: DECISIONS });
    assert.equal(r.ok, true);
    assert.equal(r.value.backend, 'api-fallback');
});

test('non-zero exit falls back to the API', async () => {
    const fallback = makeFallback();
    const judge = createCliJudgeClient({ fallback, runFn: makeRun({ code: 1, stdout: '', stderr: 'boom', timedOut: false, spawnError: null }) });
    const r = await judge.completeJson({ system: 's', user: 'u', zodSchema: DECISIONS });
    assert.equal(r.ok, true);
    assert.equal(r.value.backend, 'api-fallback');
});

test('missing binary (ENOENT) hard-disables the CLI: later calls skip spawn entirely', async () => {
    const fallback = makeFallback();
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const runFn = makeRun({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: enoent });
    const judge = createCliJudgeClient({ fallback, runFn });
    const r1 = await judge.completeJson({ system: 's', user: 'u', zodSchema: DECISIONS });
    const r2 = await judge.completeJson({ system: 's', user: 'u2', zodSchema: DECISIONS });
    assert.equal(r1.value.backend, 'api-fallback');
    assert.equal(r2.value.backend, 'api-fallback');
    assert.equal(runFn.calls.length, 1); // CLI tried once, then latched off
    assert.equal(fallback.calls.length, 2);
});

test('latch trips after maxFailures consecutive failures', async () => {
    const fallback = makeFallback();
    const runFn = makeRun({ code: 1, stdout: '', stderr: 'err', timedOut: false, spawnError: null });
    const judge = createCliJudgeClient({ fallback, runFn, maxFailures: 2 });
    await judge.completeJson({ system: 's', user: 'a', zodSchema: DECISIONS });
    await judge.completeJson({ system: 's', user: 'b', zodSchema: DECISIONS });
    await judge.completeJson({ system: 's', user: 'c', zodSchema: DECISIONS }); // latched before spawn
    assert.equal(runFn.calls.length, 2); // 3rd call never spawned
    assert.equal(fallback.calls.length, 3);
});

test('a success resets the consecutive-failure latch', async () => {
    const fallback = makeFallback();
    let n = 0;
    const runFn = makeRun(() => {
        n += 1;
        if (n === 1) return { code: 1, stdout: '', stderr: 'e', timedOut: false, spawnError: null };
        return { code: 0, stdout: GOOD, stderr: '', timedOut: false, spawnError: null };
    });
    const judge = createCliJudgeClient({ fallback, runFn, maxFailures: 2 });
    await judge.completeJson({ system: 's', user: 'a', zodSchema: DECISIONS }); // fail (1)
    await judge.completeJson({ system: 's', user: 'b', zodSchema: DECISIONS }); // ok → reset
    const r = await judge.completeJson({ system: 's', user: 'c', zodSchema: DECISIONS }); // fail (1), not latched
    assert.equal(r.value.backend, 'claude'); // 'c' prompt was judged by CLI... wait: it failed
    // 'c' failed (code 1) so it falls back, but the CLI WAS spawned (not latched):
    assert.equal(runFn.calls.length, 3);
});

test('per-process budget (maxCalls) routes overflow to the fallback', async () => {
    const fallback = makeFallback();
    const runFn = makeRun({ code: 0, stdout: GOOD, stderr: '', timedOut: false, spawnError: null });
    const judge = createCliJudgeClient({ fallback, runFn, maxCalls: 1 });
    const r1 = await judge.completeJson({ system: 's', user: 'a', zodSchema: DECISIONS });
    const r2 = await judge.completeJson({ system: 's', user: 'b', zodSchema: DECISIONS });
    assert.equal(r1.value.backend, 'claude');
    assert.equal(r2.value.backend, 'api-fallback');
    assert.equal(runFn.calls.length, 1);
});

test('no fallback configured → CLI_JUDGE_FAILED instead of a crash', async () => {
    const judge = createCliJudgeClient({ fallback: null, runFn: makeRun({ code: 1, stdout: '', stderr: 'x', timedOut: false, spawnError: null }) });
    const r = await judge.completeJson({ system: 's', user: 'u', zodSchema: DECISIONS });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'CLI_JUDGE_FAILED');
});

test('cache: identical prompt replays from disk without spawning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-judge-cache-'));
    try {
        const cache = createAiCache({ dir });
        const fallback = makeFallback();
        const runFn = makeRun({ code: 0, stdout: GOOD, stderr: '', timedOut: false, spawnError: null });
        const judge = createCliJudgeClient({ fallback, runFn, cache });
        const r1 = await judge.completeJson({ system: 's', user: 'u', schemaName: 'D', zodSchema: DECISIONS });
        const r2 = await judge.completeJson({ system: 's', user: 'u', schemaName: 'D', zodSchema: DECISIONS });
        assert.equal(r1.value.cacheHit, false);
        assert.equal(r2.value.cacheHit, true);
        assert.deepEqual(r2.value.value, JSON.parse(GOOD));
        assert.equal(runFn.calls.length, 1); // second call served from cache
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('codex backend builds a `codex exec … -` argv with stdin prompt', async () => {
    const runFn = makeRun({ code: 0, stdout: GOOD, stderr: '', timedOut: false, spawnError: null });
    const judge = createCliJudgeClient({ backend: 'codex', fallback: makeFallback(), runFn, model: 'gpt-5' });
    await judge.completeJson({ system: 's', user: 'u', zodSchema: DECISIONS });
    const call = runFn.calls[0];
    assert.equal(call.bin, 'codex');
    assert.deepEqual(call.args, ['exec', '--model', 'gpt-5', '-']);
    assert.match(call.prompt, /OUTPUT CONTRACT/);
});

test('extractJsonObject ignores braces inside strings', () => {
    const s = 'noise {"a":"has } brace","b":1} trailing';
    assert.equal(extractJsonObject(s), '{"a":"has } brace","b":1}');
    assert.equal(extractJsonObject('no object here'), null);
});
