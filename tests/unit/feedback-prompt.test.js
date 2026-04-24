// Prompt builder — turn calibration groups into a user-prompt fragment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCalibrationBlock } from '../../src/services/feedback/prompt.js';

const entry = (o) => ({
    id: 'x', ts: 't', jobId: o.jobId || 'j',
    title: o.title || 'T', company: o.company || 'C',
    verdict: o.verdict, aiPick: !!o.aiPick, aiScore: o.aiScore ?? 0,
    aiReason: o.aiReason || '', note: o.note || '', sourceRunId: '',
});

test('empty groups → empty string (no cache noise)', () => {
    const s = buildCalibrationBlock({
        rejected: [], rescued: [], confirmedPick: [], confirmedSkip: [],
    });
    assert.equal(s, '');
});

test('rejected entries land under the REJECT section', () => {
    const s = buildCalibrationBlock({
        rejected: [entry({ title: 'Sales Engineer', company: 'Acme', verdict: 'bad_pick', aiScore: 62, aiReason: 'adjacent' })],
        rescued: [], confirmedPick: [], confirmedSkip: [],
    });
    assert.match(s, /CLIENT CALIBRATION/);
    assert.match(s, /REJECTED/);
    assert.match(s, /"Sales Engineer"/);
    assert.match(s, /@ Acme/);
    assert.match(s, /AI score 62/);
    assert.match(s, /adjacent/);
});

test('rescued entries land under the RESCUED section', () => {
    const s = buildCalibrationBlock({
        rejected: [],
        rescued: [entry({ title: 'Technical PM', company: 'Notion', verdict: 'good_skip', aiScore: 48, note: 'this is exactly what we want' })],
        confirmedPick: [], confirmedSkip: [],
    });
    assert.match(s, /RESCUED/);
    assert.match(s, /Technical PM/);
    assert.match(s, /operator note: "this is exactly what we want"/);
});

test('confirmations are labelled PICK / SKIP', () => {
    const s = buildCalibrationBlock({
        rejected: [], rescued: [],
        confirmedPick: [entry({ title: 'Backend Engineer', verdict: 'good_pick' })],
        confirmedSkip: [entry({ title: 'Data Analyst', verdict: 'bad_skip' })],
    });
    assert.match(s, /\[confirmed PICK\]/);
    assert.match(s, /\[confirmed SKIP\]/);
});

test('deterministic output for same input (cache-friendly)', () => {
    const groups = {
        rejected: [entry({ title: 'A', verdict: 'bad_pick' })],
        rescued: [entry({ title: 'B', verdict: 'good_skip' })],
        confirmedPick: [], confirmedSkip: [],
    };
    assert.equal(buildCalibrationBlock(groups), buildCalibrationBlock(groups));
});

test('closing override guidance is present so AI knows how to use the block', () => {
    const s = buildCalibrationBlock({
        rejected: [entry({ verdict: 'bad_pick' })],
        rescued: [], confirmedPick: [], confirmedSkip: [],
    });
    assert.match(s, /How to use/);
    assert.match(s, /hard-skip|pick/i);
});
