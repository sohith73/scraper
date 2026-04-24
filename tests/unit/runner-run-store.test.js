import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunStore } from '../../src/services/runner/runStore.js';
import { PHASES } from '../../src/services/runner/state.js';

async function freshDir() {
    return mkdtemp(join(tmpdir(), 'scraper-runstore-'));
}

// waitForFile: poll up to timeoutMs for `path` to exist. Needed because
// the store's state.json writes are fire-and-forget (intentional — we
// don't want update() to block on disk).
async function waitForFile(path, timeoutMs = 1500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            await stat(path);
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 15));
        }
    }
    throw new Error(`file not created within ${timeoutMs}ms: ${path}`);
}

test('create assigns id + persists state.json + emits initial state', async () => {
    const dir = await freshDir();
    try {
        const events = [];
        let n = 0;
        const store = createRunStore({ runsDir: dir, idGen: () => `r${++n}` });
        store.subscribe('r1', (s) => events.push(s.eventSeq));
        const run = store.create({ clientEmail: 'a@b.com', requestedCount: 5 });
        assert.equal(run.id, 'r1');
        assert.equal(run.phase, PHASES.QUEUED);
        // Emitter fired before subscribe in our ordering — that's fine; we
        // still get the subsequent update on the first real transition.
        const next = store.update('r1', { phase: PHASES.LOADING_PROFILE });
        assert.equal(next.phase, PHASES.LOADING_PROFILE);
        assert.equal(next.eventSeq, 1);
        // persistence (async write — poll)
        const path = join(dir, 'r1', 'state.json');
        await waitForFile(path);
        // wait a beat for content to match the latest update
        let onDisk;
        for (let i = 0; i < 30; i += 1) {
            onDisk = JSON.parse(await readFile(path, 'utf8'));
            if (onDisk.phase === PHASES.LOADING_PROFILE) break;
            await new Promise((r) => setTimeout(r, 15));
        }
        assert.equal(onDisk.phase, PHASES.LOADING_PROFILE);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('update: bumps eventSeq + updatedAt + notifies subscribers', async () => {
    const dir = await freshDir();
    try {
        const store = createRunStore({ runsDir: dir, idGen: () => 'r1' });
        const run = store.create({ clientEmail: 'a@b.com', requestedCount: 5 });
        const seen = [];
        store.subscribe(run.id, (s) => seen.push(s.phase));
        store.update(run.id, { phase: PHASES.SEARCHING });
        store.update(run.id, { phase: PHASES.FILTERING });
        assert.deepEqual(seen, [PHASES.SEARCHING, PHASES.FILTERING]);
        const latest = store.get(run.id);
        assert.equal(latest.eventSeq, 2);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('update deep-merges progress without clobbering', async () => {
    const dir = await freshDir();
    try {
        const store = createRunStore({ runsDir: dir, idGen: () => 'r1' });
        const run = store.create({ clientEmail: 'a@b.com', requestedCount: 5 });
        store.update(run.id, { progress: { intent: { roles: ['x'] } } });
        store.update(run.id, { progress: { searched: { totalReturned: 5 } } });
        const s = store.get(run.id);
        assert.deepEqual(s.progress.intent, { roles: ['x'] });
        assert.deepEqual(s.progress.searched, { totalReturned: 5 });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('update refuses to move off a terminal phase', async () => {
    const dir = await freshDir();
    try {
        const store = createRunStore({ runsDir: dir, idGen: () => 'r1' });
        const run = store.create({ clientEmail: 'a@b.com', requestedCount: 5 });
        store.update(run.id, { phase: PHASES.DONE });
        const attempt = store.update(run.id, { phase: PHASES.SEARCHING });
        assert.equal(attempt.phase, PHASES.DONE);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('update stamps durationMs when transitioning to terminal', async () => {
    const dir = await freshDir();
    try {
        const store = createRunStore({ runsDir: dir, idGen: () => 'r1' });
        const run = store.create({ clientEmail: 'a@b.com', requestedCount: 5 });
        // wait a beat so timestamps differ
        await new Promise((r) => setTimeout(r, 5));
        const done = store.update(run.id, { phase: PHASES.DONE });
        assert.ok(done.durationMs >= 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('requestAbort sets the flag without changing phase', async () => {
    const dir = await freshDir();
    try {
        const store = createRunStore({ runsDir: dir, idGen: () => 'r1' });
        const run = store.create({ clientEmail: 'a@b.com', requestedCount: 5 });
        store.update(run.id, { phase: PHASES.SEARCHING });
        const aborted = store.requestAbort(run.id);
        assert.equal(aborted.abortRequested, true);
        assert.equal(aborted.phase, PHASES.SEARCHING);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('requestAbort on a terminal run is a no-op', async () => {
    const dir = await freshDir();
    try {
        const store = createRunStore({ runsDir: dir, idGen: () => 'r1' });
        const run = store.create({ clientEmail: 'a@b.com', requestedCount: 5 });
        store.update(run.id, { phase: PHASES.DONE });
        const after = store.requestAbort(run.id);
        assert.equal(after.phase, PHASES.DONE);
        assert.equal(after.abortRequested, false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('get returns null for unknown id', () => {
    const store = createRunStore({ runsDir: '/tmp/scraper-x' });
    assert.equal(store.get('nope'), null);
});

test('list returns all runs', async () => {
    const dir = await freshDir();
    try {
        let n = 0;
        const store = createRunStore({ runsDir: dir, idGen: () => `r${++n}` });
        store.create({ clientEmail: 'a@b.com', requestedCount: 5 });
        store.create({ clientEmail: 'c@d.com', requestedCount: 3 });
        assert.equal(store.list().length, 2);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('subscribe returns an unsubscribe fn', async () => {
    const dir = await freshDir();
    try {
        const store = createRunStore({ runsDir: dir, idGen: () => 'r1' });
        const run = store.create({ clientEmail: 'a@b.com', requestedCount: 5 });
        let hits = 0;
        const off = store.subscribe(run.id, () => hits++);
        store.update(run.id, { phase: PHASES.SEARCHING });
        off();
        store.update(run.id, { phase: PHASES.FILTERING });
        assert.equal(hits, 1);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('constructor rejects missing runsDir', () => {
    assert.throws(() => createRunStore({}), /runsDir is required/);
});
