// Event formatters — assert the embed shape each helper produces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    notifyRunDone,
    notifyRunFailed,
    notifyNoJobs,
    notifyCooldown,
    computeCulprits,
} from '../../src/services/notify/events.js';

// makeNotifier: minimal notifier with call capture.
function makeNotifier({ enabled = true } = {}) {
    const calls = [];
    return {
        enabled,
        async send(payload) {
            calls.push(payload);
            return { sent: true, status: 204 };
        },
        calls,
    };
}

const RUN = {
    id: 'abcdef12-3456',
    clientEmail: 'x@y.com',
    clientName: 'X Y',
    requestedCount: 4,
    phase: 'done',
    durationMs: 8200,
    progress: {
        intent: { roles: ['PM'] },
        searched: { totalNormalized: 15, pages: 1 },
        filtered: { picked: 3, skipped: 12, borderline: 0 },
        pushed: { pushed: 4, duplicates: 1, blocked: 0, errors: 0 },
    },
    picks: [
        { title: 'Product Manager', company: 'Acme' },
        { title: 'Senior PM', company: 'Stripe' },
    ],
};

test('notifyRunDone — success colour + counts + top picks', async () => {
    const n = makeNotifier();
    await notifyRunDone({ notifier: n, run: RUN });
    assert.equal(n.calls.length, 1);
    const p = n.calls[0];
    assert.match(p.title, /Scrape complete.*4/);
    assert.equal(p.color, 0x3FB950);
    assert.ok(p.fields.find((f) => f.name === 'Client' && f.value === 'x@y.com'));
    assert.ok(p.fields.find((f) => f.name === 'Pushed' && f.value === '4 / 4'));
    assert.ok(p.fields.find((f) => f.name.startsWith('Top')));
});

test('notifyRunDone — warning colour when 0 pushed but jobs scanned', async () => {
    const n = makeNotifier();
    const run = {
        ...RUN,
        progress: { ...RUN.progress, pushed: { pushed: 0 } },
        picks: [],
    };
    await notifyRunDone({ notifier: n, run });
    assert.equal(n.calls[0].color, 0xD29922);
    assert.match(n.calls[0].title, /0 jobs pushed/);
});

test('notifyRunDone — no-op when notifier disabled', async () => {
    const n = makeNotifier({ enabled: false });
    await notifyRunDone({ notifier: n, run: RUN });
    assert.equal(n.calls.length, 0);
});

test('notifyRunDone — surfaces applied relaxations', async () => {
    const n = makeNotifier();
    const run = {
        ...RUN,
        progress: {
            ...RUN.progress,
            appliedRelaxations: [{ label: 'Date posted', from: 'past 24 h', to: 'past 7 days' }],
        },
    };
    await notifyRunDone({ notifier: n, run });
    const f = n.calls[0].fields.find((x) => x.name === 'Filters widened');
    assert.ok(f);
    assert.match(f.value, /Date posted/);
});

test('notifyRunFailed — failure colour + error fields', async () => {
    const n = makeNotifier();
    await notifyRunFailed({
        notifier: n,
        run: { ...RUN, phase: 'failed', error: { code: 'NEEDS_REAUTH', message: 'session lost' } },
    });
    assert.equal(n.calls.length, 1);
    const p = n.calls[0];
    assert.match(p.title, /failed.*NEEDS_REAUTH/);
    assert.equal(p.color, 0xF85149);
    assert.ok(p.fields.find((f) => f.name === 'Code' && f.value.includes('NEEDS_REAUTH')));
    assert.ok(p.fields.find((f) => f.name === 'Action'));
});

test('notifyRunFailed — RESUME_MISSING suggests gemini-resume in Action', async () => {
    const n = makeNotifier();
    await notifyRunFailed({
        notifier: n,
        run: { ...RUN, phase: 'failed', error: { code: 'RESUME_MISSING', message: '' } },
    });
    const action = n.calls[0].fields.find((f) => f.name === 'Action');
    assert.ok(action);
    assert.match(action.value, /gemini-resume/);
});

test('notifyNoJobs — includes culprits list', async () => {
    const n = makeNotifier();
    await notifyNoJobs({
        notifier: n,
        run: RUN,
        culprits: ['Date posted = past 1d', 'Work model = hybrid only'],
    });
    const p = n.calls[0];
    assert.equal(p.color, 0xD29922);
    const c = p.fields.find((f) => f.name === 'Most likely culprits');
    assert.ok(c);
    assert.match(c.value, /past 1d/);
    assert.match(c.value, /hybrid only/);
});

test('notifyCooldown — includes expiry + trigger code', async () => {
    const n = makeNotifier();
    await notifyCooldown({
        notifier: n,
        run: RUN,
        cooldown: {
            code: 'RATE_LIMITED',
            reason: 'RATE_LIMITED: JR 429',
            expiresAt: '2026-04-24T12:00:00.000Z',
        },
    });
    const p = n.calls[0];
    assert.match(p.title, /Cooldown.*RATE_LIMITED/);
    assert.ok(p.fields.find((f) => f.name === 'Expires' && f.value.startsWith('2026-')));
});

test('all notifiers are silent when disabled', async () => {
    const n = makeNotifier({ enabled: false });
    await notifyRunDone({ notifier: n, run: RUN });
    await notifyRunFailed({ notifier: n, run: { ...RUN, error: { code: 'X' } } });
    await notifyNoJobs({ notifier: n, run: RUN, culprits: ['a'] });
    await notifyCooldown({ notifier: n, run: RUN, cooldown: { code: 'X' } });
    assert.equal(n.calls.length, 0);
});

test('computeCulprits flags narrow daysAgo', () => {
    const c = computeCulprits({ daysAgo: 1 });
    assert.ok(c.some((x) => /past 1d/.test(x)));
});

test('computeCulprits flags single-model workModels', () => {
    const c = computeCulprits({ workModels: ['hybrid'] });
    assert.ok(c.some((x) => /hybrid only/i.test(x)));
});

test('computeCulprits flags narrow YoE band', () => {
    const c = computeCulprits({ minYearsOfExperience: 5, maxYearsOfExperience: 7 });
    assert.ok(c.some((x) => /YoE/i.test(x)));
});

test('computeCulprits returns empty on loose intent', () => {
    const c = computeCulprits({ daysAgo: 30, workModels: ['remote', 'hybrid'] });
    assert.equal(c.length, 0);
});
