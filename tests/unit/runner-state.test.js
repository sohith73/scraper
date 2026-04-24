import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASES, isTerminal, makeInitialState, emptyProgress } from '../../src/services/runner/state.js';

test('PHASES has the expected members', () => {
    for (const k of [
        'QUEUED', 'LOADING_PROFILE', 'LOADING_EXCLUSIONS', 'LOADING_RESUME',
        'SUMMARISING', 'SEARCHING', 'FILTERING', 'ENRICHING',
        'PREFLIGHT', 'PUSHING', 'DONE', 'FAILED', 'ABORTED',
    ]) {
        assert.ok(k in PHASES, `missing ${k}`);
    }
});

test('isTerminal recognises done / failed / aborted', () => {
    assert.equal(isTerminal(PHASES.DONE), true);
    assert.equal(isTerminal(PHASES.FAILED), true);
    assert.equal(isTerminal(PHASES.ABORTED), true);
    assert.equal(isTerminal(PHASES.QUEUED), false);
    assert.equal(isTerminal(PHASES.SEARCHING), false);
});

test('makeInitialState returns a fresh-looking run', () => {
    const s = makeInitialState({ id: 'r1', clientEmail: 'a@b.com', requestedCount: 5 });
    assert.equal(s.id, 'r1');
    assert.equal(s.phase, PHASES.QUEUED);
    assert.equal(s.clientEmail, 'a@b.com');
    assert.equal(s.requestedCount, 5);
    assert.equal(s.eventSeq, 0);
    assert.equal(s.abortRequested, false);
    assert.deepEqual(s.picks, []);
    assert.ok(typeof s.createdAt === 'string');
    assert.ok(typeof s.updatedAt === 'string');
});

test('emptyProgress returns a fresh object each call', () => {
    const a = emptyProgress();
    const b = emptyProgress();
    a.intent = 'x';
    assert.equal(b.intent, null);
});
