// Per-client feedback store — append, dedupe, trim, calibration selection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeedbackStore, VERDICTS } from '../../src/services/feedback/store.js';

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-feedback-'));
    const store = createFeedbackStore({ dir });
    return { dir, store };
}

test('append rejects invalid email', async () => {
    const { dir, store } = await setup();
    try {
        await assert.rejects(
            () => store.append('nope', { jobId: 'x', verdict: 'bad_pick' }),
            /valid email/i,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('append rejects unknown verdict', async () => {
    const { dir, store } = await setup();
    try {
        await assert.rejects(
            () => store.append('a@b.com', { jobId: 'x', verdict: 'whatever' }),
            /verdict must be/i,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('VERDICTS is the expected four-way taxonomy', () => {
    assert.deepEqual(
        [...VERDICTS].sort(),
        ['bad_pick', 'bad_skip', 'good_pick', 'good_skip'],
    );
});

test('append returns entry + persists across list calls', async () => {
    const { dir, store } = await setup();
    try {
        const e = await store.append('a@b.com', {
            jobId: 'j1',
            title: 'Senior PM',
            company: 'Acme',
            verdict: 'bad_pick',
            aiPick: true,
            aiScore: 65,
            aiReason: 'adjacent role',
            note: 'no pm consulting',
        });
        assert.match(e.id, /^[0-9a-f-]+$/i);
        assert.equal(e.verdict, 'bad_pick');
        assert.equal(e.title, 'Senior PM');
        const list = await store.list('a@b.com');
        assert.equal(list.length, 1);
        assert.equal(list[0].id, e.id);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('append dedupes same (jobId, verdict) — newest wins', async () => {
    const { dir, store } = await setup();
    try {
        await store.append('a@b.com', { jobId: 'j1', verdict: 'bad_pick', note: 'old' });
        await new Promise((r) => setTimeout(r, 2));
        await store.append('a@b.com', { jobId: 'j1', verdict: 'bad_pick', note: 'new' });
        const list = await store.list('a@b.com');
        assert.equal(list.length, 1);
        assert.equal(list[0].note, 'new');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('append keeps different verdicts for the same job', async () => {
    const { dir, store } = await setup();
    try {
        await store.append('a@b.com', { jobId: 'j1', verdict: 'bad_pick' });
        await store.append('a@b.com', { jobId: 'j1', verdict: 'good_skip' });
        const list = await store.list('a@b.com');
        assert.equal(list.length, 2);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('append trims to at most MAX_ENTRIES (50)', async () => {
    const { dir, store } = await setup();
    try {
        for (let i = 0; i < 55; i += 1) {
            await store.append('a@b.com', { jobId: `j${i}`, verdict: 'bad_pick' });
        }
        const list = await store.list('a@b.com');
        assert.equal(list.length, 50);
        // oldest 5 should have been trimmed
        assert.equal(list[0].jobId, 'j5');
        assert.equal(list[list.length - 1].jobId, 'j54');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('remove by entry id', async () => {
    const { dir, store } = await setup();
    try {
        const e = await store.append('a@b.com', { jobId: 'j1', verdict: 'bad_pick' });
        const removed = await store.remove('a@b.com', e.id);
        assert.equal(removed, true);
        const list = await store.list('a@b.com');
        assert.equal(list.length, 0);
        // second remove returns false
        const again = await store.remove('a@b.com', e.id);
        assert.equal(again, false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('selectCalibration groups verdicts + enforces per-group caps', async () => {
    const { dir, store } = await setup();
    try {
        // 4 rejected (cap 3), 4 rescued (cap 3), 3 confirmedPick (cap 2),
        // 3 confirmedSkip (cap 2). Newest-first wins.
        for (let i = 0; i < 4; i += 1) {
            await store.append('a@b.com', { jobId: `bp${i}`, verdict: 'bad_pick' });
        }
        for (let i = 0; i < 4; i += 1) {
            await store.append('a@b.com', { jobId: `gs${i}`, verdict: 'good_skip' });
        }
        for (let i = 0; i < 3; i += 1) {
            await store.append('a@b.com', { jobId: `gp${i}`, verdict: 'good_pick' });
        }
        for (let i = 0; i < 3; i += 1) {
            await store.append('a@b.com', { jobId: `bs${i}`, verdict: 'bad_skip' });
        }
        const groups = await store.selectCalibration('a@b.com');
        assert.equal(groups.rejected.length, 3);
        assert.equal(groups.rescued.length, 3);
        assert.equal(groups.confirmedPick.length, 2);
        assert.equal(groups.confirmedSkip.length, 2);
        // newest-first: bp3, bp2, bp1 (bp0 is oldest, dropped)
        assert.deepEqual(groups.rejected.map((e) => e.jobId), ['bp3', 'bp2', 'bp1']);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('selectCalibration returns empty groups for untouched client', async () => {
    const { dir, store } = await setup();
    try {
        const groups = await store.selectCalibration('nobody@b.com');
        assert.deepEqual(groups, {
            rejected: [], rescued: [], confirmedPick: [], confirmedSkip: [],
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('selectCalibration de-dupes by jobId across groups (latest verdict wins)', async () => {
    const { dir, store } = await setup();
    try {
        // Same job: first bad_pick then later good_skip. Newest verdict
        // should be the only one surfaced for that job.
        await store.append('a@b.com', { jobId: 'j1', verdict: 'bad_pick' });
        await store.append('a@b.com', { jobId: 'j1', verdict: 'good_skip' });
        const groups = await store.selectCalibration('a@b.com');
        assert.equal(groups.rejected.length, 0);
        assert.equal(groups.rescued.length, 1);
        assert.equal(groups.rescued[0].jobId, 'j1');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('coerces + truncates runaway string fields', async () => {
    const { dir, store } = await setup();
    try {
        const long = 'x'.repeat(500);
        const e = await store.append('a@b.com', {
            jobId: 'j1',
            verdict: 'bad_pick',
            title: long,
            note: long,
        });
        assert.ok(e.title.length <= 141); // 140 + ellipsis
        assert.ok(e.note.length <= 301);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
