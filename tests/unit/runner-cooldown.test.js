import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    readCooldown,
    setCooldown,
    clearCooldown,
    isCooldownActive,
    describeCooldown,
} from '../../src/services/runner/cooldown.js';

async function freshDir() {
    return mkdtemp(join(tmpdir(), 'scraper-cooldown-'));
}

test('readCooldown: returns null when no file', async () => {
    const dir = await freshDir();
    try {
        assert.equal(await readCooldown(dir), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('readCooldown: returns null on malformed JSON', async () => {
    const dir = await freshDir();
    try {
        await writeFile(join(dir, '.cooldown.json'), 'not-json');
        assert.equal(await readCooldown(dir), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('setCooldown: writes a record + readback returns it', async () => {
    const dir = await freshDir();
    try {
        const now = Date.parse('2026-04-23T09:00:00Z');
        const r = await setCooldown(dir, {
            ms: 60_000,
            reason: 'RATE_LIMITED',
            code: 'RATE_LIMITED',
            now,
        });
        assert.ok(r?.record);
        const record = await readCooldown(dir);
        assert.equal(record.code, 'RATE_LIMITED');
        assert.equal(record.until, '2026-04-23T09:01:00.000Z');
        assert.equal(record.setAt, '2026-04-23T09:00:00.000Z');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('setCooldown: rejects non-positive ms', async () => {
    const dir = await freshDir();
    try {
        assert.equal(await setCooldown(dir, { ms: 0 }), null);
        assert.equal(await setCooldown(dir, { ms: -1 }), null);
        assert.equal(await setCooldown(dir, { ms: 'nope' }), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('setCooldown: truncates huge reason strings', async () => {
    const dir = await freshDir();
    try {
        const longReason = 'x'.repeat(2000);
        await setCooldown(dir, { ms: 1000, reason: longReason });
        const record = await readCooldown(dir);
        assert.ok(record.reason.length <= 500);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('clearCooldown: removes the file; safe on missing', async () => {
    const dir = await freshDir();
    try {
        await setCooldown(dir, { ms: 1000 });
        await clearCooldown(dir);
        assert.equal(await readCooldown(dir), null);
        // calling again is a no-op
        await clearCooldown(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('isCooldownActive: time-based pure check', () => {
    const now = Date.parse('2026-04-23T09:00:00Z');
    assert.equal(
        isCooldownActive({ until: '2026-04-23T09:05:00Z' }, now),
        true,
    );
    assert.equal(
        isCooldownActive({ until: '2026-04-23T08:59:59Z' }, now),
        false,
    );
    assert.equal(isCooldownActive(null), false);
    assert.equal(isCooldownActive({}), false);
    assert.equal(isCooldownActive({ until: 'not-a-date' }), false);
});

test('describeCooldown: human-readable remaining', () => {
    const now = Date.parse('2026-04-23T09:00:00Z');
    const msg = describeCooldown(
        { code: 'RATE_LIMITED', reason: 'JR 429', until: '2026-04-23T09:02:30Z' },
        now,
    );
    assert.match(msg, /RATE_LIMITED/);
    assert.match(msg, /JR 429/);
    assert.match(msg, /retry in 2m 30s/);
});

test('describeCooldown: returns empty string when expired', () => {
    const now = Date.now();
    assert.equal(
        describeCooldown({ until: new Date(now - 1000).toISOString() }, now),
        '',
    );
});
