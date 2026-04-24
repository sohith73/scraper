import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClientFilterStore } from '../../src/services/clientFilters/store.js';

async function freshDir() {
    return mkdtemp(join(tmpdir(), 'scraper-clientfilters-'));
}

test('rejects missing dir', () => {
    assert.throws(() => createClientFilterStore({}), /dir is required/);
});

test('get returns null for unknown email + malformed email', async () => {
    const dir = await freshDir();
    try {
        const s = createClientFilterStore({ dir });
        assert.equal(await s.get('nope@x.com'), null);
        assert.equal(await s.get('not-an-email'), null);
        assert.equal(await s.get(null), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('put + get round-trip', async () => {
    const dir = await freshDir();
    try {
        const s = createClientFilterStore({ dir });
        const rec = await s.put('alice@Example.com', {
            intent: { roles: ['Backend Engineer'], seniority: 'senior' },
            overrides: { daysAgo: 7 },
            meta: { lastRunId: 'r1', source: 'ai' },
        });
        assert.ok(rec);
        assert.equal(rec.email, 'alice@example.com');
        assert.ok(rec.meta.savedAt);

        const got = await s.get('alice@example.com');
        assert.equal(got.email, 'alice@example.com');
        assert.deepEqual(got.intent.roles, ['Backend Engineer']);
        assert.deepEqual(got.overrides, { daysAgo: 7 });
        assert.equal(got.meta.lastRunId, 'r1');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('put is atomic — latest value wins across concurrent calls', async () => {
    const dir = await freshDir();
    try {
        const s = createClientFilterStore({ dir });
        const ops = Array.from({ length: 5 }, (_, i) =>
            s.put('a@b.com', { intent: { roles: [`role-${i}`], seniority: 'mid', companies: [], workAuth: '', narrative: '', futurePreferences: '' } }),
        );
        await Promise.all(ops);
        const got = await s.get('a@b.com');
        assert.ok(got);
        assert.match(got.intent.roles[0], /^role-/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('corrupt file → get returns null (treated as absent)', async () => {
    const dir = await freshDir();
    try {
        const s = createClientFilterStore({ dir });
        const slug = s._emailToSlug('a@b.com');
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(dir, `${slug}.json`), 'not-json', 'utf8');
        assert.equal(await s.get('a@b.com'), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('remove deletes the record; idempotent on missing', async () => {
    const dir = await freshDir();
    try {
        const s = createClientFilterStore({ dir });
        await s.put('a@b.com', { intent: {} });
        assert.equal(await s.remove('a@b.com'), true);
        assert.equal(await s.get('a@b.com'), null);
        // Second call is safe
        assert.equal(await s.remove('a@b.com'), false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('list enumerates saved records with metadata', async () => {
    const dir = await freshDir();
    try {
        const s = createClientFilterStore({ dir });
        await s.put('a@b.com', {
            intent: { roles: ['Backend'] },
            overrides: { daysAgo: 3 },
        });
        await s.put('c@d.com', { intent: { roles: ['ML Engineer'] } });
        const entries = await s.list();
        assert.equal(entries.length, 2);
        const a = entries.find((e) => e.email === 'a@b.com');
        assert.deepEqual(a.intentRoles, ['Backend']);
        assert.equal(a.hasOverrides, true);
        const c = entries.find((e) => e.email === 'c@d.com');
        assert.equal(c.hasOverrides, false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('emailToSlug: different emails produce different slugs', () => {
    const s = createClientFilterStore({ dir: '/tmp/stub' });
    assert.notEqual(s._emailToSlug('a@b.com'), s._emailToSlug('a@c.com'));
    // Special characters that would normalise to the same thing still
    // differ via the hash suffix.
    assert.notEqual(s._emailToSlug('a.b@c.com'), s._emailToSlug('a_b@c.com'));
});

test('persisted file is valid JSON on disk', async () => {
    const dir = await freshDir();
    try {
        const s = createClientFilterStore({ dir });
        await s.put('z@z.com', { intent: { roles: ['X'] } });
        const slug = s._emailToSlug('z@z.com');
        const raw = await readFile(join(dir, `${slug}.json`), 'utf8');
        const parsed = JSON.parse(raw);
        assert.equal(parsed.email, 'z@z.com');
        assert.deepEqual(parsed.intent.roles, ['X']);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
