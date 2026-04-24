// Discord webhook sender — protocol shape + no-op-when-disabled behaviour.
// fetch is injected so no network I/O in tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordNotifier, DISCORD_COLORS } from '../../src/services/notify/discord.js';

function captureFetch() {
    const calls = [];
    const fn = async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, status: 204, text: async () => '' };
    };
    fn.calls = calls;
    return fn;
}

test('disabled when webhookUrl blank — send() is a no-op', async () => {
    const fetchImpl = captureFetch();
    const n = createDiscordNotifier({ webhookUrl: '', fetchImpl });
    assert.equal(n.enabled, false);
    const r = await n.send({ title: 'hi' });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'disabled');
    assert.equal(fetchImpl.calls.length, 0);
});

test('enabled when webhookUrl set — send() POSTs an embed to the URL', async () => {
    const fetchImpl = captureFetch();
    const n = createDiscordNotifier({ webhookUrl: 'https://discord.test/webhook/X/Y', fetchImpl });
    assert.equal(n.enabled, true);
    await n.send({
        title: 'Scrape complete',
        description: 'Run ok',
        color: DISCORD_COLORS.success,
        fields: [{ name: 'A', value: 'B', inline: true }],
    });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, 'https://discord.test/webhook/X/Y');
    const body = JSON.parse(fetchImpl.calls[0].opts.body);
    assert.equal(body.username, 'JobRight Scraper');
    assert.equal(body.embeds.length, 1);
    assert.equal(body.embeds[0].title, 'Scrape complete');
    assert.equal(body.embeds[0].color, DISCORD_COLORS.success);
    assert.equal(body.embeds[0].fields[0].name, 'A');
    assert.match(body.embeds[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('truncates long title + description so Discord never 400s', async () => {
    const fetchImpl = captureFetch();
    const n = createDiscordNotifier({ webhookUrl: 'https://discord.test/hook', fetchImpl });
    await n.send({
        title: 'x'.repeat(500),
        description: 'y'.repeat(4000),
    });
    const body = JSON.parse(fetchImpl.calls[0].opts.body);
    assert.ok(body.embeds[0].title.length <= 200);
    assert.ok(body.embeds[0].description.length <= 1800);
});

test('swallows 429 rate limit without throwing', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'slow down' });
    const n = createDiscordNotifier({ webhookUrl: 'https://discord.test/hook', fetchImpl });
    const r = await n.send({ title: 'x' });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'rate-limited');
});

test('swallows non-2xx without throwing', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'server error' });
    const n = createDiscordNotifier({ webhookUrl: 'https://discord.test/hook', fetchImpl });
    const r = await n.send({ title: 'x' });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'status-500');
});

test('swallows transport errors (thrown fetch) without throwing', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const n = createDiscordNotifier({ webhookUrl: 'https://discord.test/hook', fetchImpl });
    const r = await n.send({ title: 'x' });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'error');
});

test('caps fields at 25 (Discord limit)', async () => {
    const fetchImpl = captureFetch();
    const n = createDiscordNotifier({ webhookUrl: 'https://discord.test/hook', fetchImpl });
    const manyFields = Array.from({ length: 40 }, (_, i) => ({ name: `F${i}`, value: 'v' }));
    await n.send({ title: 'x', fields: manyFields });
    const body = JSON.parse(fetchImpl.calls[0].opts.body);
    assert.equal(body.embeds[0].fields.length, 25);
});
