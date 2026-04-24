// runsService cooldown integration — ensure start() refuses when active.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunsService } from '../../src/services/runner/index.js';
import { setCooldown, clearCooldown } from '../../src/services/runner/cooldown.js';
import { PHASES } from '../../src/services/runner/state.js';

async function mkService(dir, pipelineImpl) {
    return createRunsService({
        container: { env: {}, logger: { info(){},warn(){},error(){},debug(){} } },
        runsDir: dir,
        logger: { info(){},warn(){},error(){},debug(){} },
        pipelineImpl: pipelineImpl
            || (async ({ store, runId }) => {
                store.update(runId, { phase: PHASES.DONE });
            }),
    });
}

test('start() throws COOLDOWN when cooldown file active', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-runs-cd-'));
    try {
        await setCooldown(dir, { ms: 60_000, reason: 'JR blocked', code: 'BLOCKED_BY_JOBRIGHT' });
        const svc = await mkService(dir);
        await svc.refreshCooldown(); // pull the fresh cooldown into memory
        assert.throws(
            () => svc.start({ clientEmail: 'a@b.com', requestedCount: 3 }),
            (e) => {
                assert.equal(e.code, 'COOLDOWN');
                assert.match(e.message, /BLOCKED_BY_JOBRIGHT/);
                return true;
            },
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('start() succeeds when cooldown has expired (file auto-cleared)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-runs-cd-'));
    try {
        await setCooldown(dir, {
            ms: 10,
            reason: 'old',
            code: 'RATE_LIMITED',
            now: Date.now() - 60_000,
        });
        const svc = await mkService(dir);
        // Force refresh — should see the expired record and clear it.
        await svc.refreshCooldown();
        const status = await svc.cooldownStatus();
        assert.equal(status.active, false);
        const run = svc.start({ clientEmail: 'a@b.com', requestedCount: 3 });
        assert.ok(run.id);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('cooldownStatus() reports the current active state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-runs-cd-'));
    try {
        const svc = await mkService(dir);
        // No cooldown file yet.
        let status = await svc.cooldownStatus();
        assert.equal(status.active, false);
        // Write one + re-check.
        await setCooldown(dir, { ms: 120_000, reason: 'r', code: 'RATE_LIMITED' });
        status = await svc.cooldownStatus();
        assert.equal(status.active, true);
        assert.match(status.message, /RATE_LIMITED/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('pipeline writing a cooldown causes the NEXT start() to refuse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-runs-cd-'));
    try {
        const svc = await mkService(dir, async ({ store, runId }) => {
            // Simulate the search layer writing a cooldown, then failing.
            await setCooldown(dir, {
                ms: 60_000,
                reason: 'JR 429',
                code: 'RATE_LIMITED',
            });
            store.update(runId, {
                phase: PHASES.FAILED,
                error: { code: 'RATE_LIMITED', message: 'slow down' },
            });
        });
        svc.start({ clientEmail: 'a@b.com', requestedCount: 3 });
        // Wait for the fire-and-forget pipeline + refresh to complete.
        await new Promise((r) => setTimeout(r, 30));
        await svc.refreshCooldown();
        assert.throws(
            () => svc.start({ clientEmail: 'c@d.com', requestedCount: 3 }),
            (e) => e.code === 'COOLDOWN',
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('after clearCooldown, start() works again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scraper-runs-cd-'));
    try {
        await setCooldown(dir, { ms: 60_000, reason: 'r', code: 'RATE_LIMITED' });
        const svc = await mkService(dir);
        await svc.refreshCooldown();
        assert.throws(() => svc.start({ clientEmail: 'a@b.com', requestedCount: 1 }));
        await clearCooldown(dir);
        await svc.refreshCooldown();
        const run = svc.start({ clientEmail: 'a@b.com', requestedCount: 1 });
        assert.ok(run.id);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
