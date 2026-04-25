// Token pricing + per-run cost ledger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    pricesFor,
    costUsd,
    createCostLedger,
    formatUsd,
} from '../../src/ai/costs.js';

test('pricesFor: exact model match', () => {
    const p = pricesFor('gpt-4o-mini');
    assert.ok(p.input > 0 && p.output > p.input);
});

test('pricesFor: prefix match finds longest candidate', () => {
    const p = pricesFor('gpt-4o-mini-2024-07-18');
    // Should match gpt-4o-mini, not gpt-4o (which would be more expensive).
    assert.equal(p.input, 0.15 / 1_000_000);
});

test('pricesFor: unknown model falls back to mini pricing (never explodes)', () => {
    const p = pricesFor('mystery-model-99');
    assert.equal(p.input, 0.15 / 1_000_000);
});

test('costUsd: 1M prompt + 1M completion tokens on mini = $0.75', () => {
    const cost = costUsd({
        model: 'gpt-4o-mini',
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
    });
    assert.equal(cost, 0.75);
});

test('costUsd: zero tokens = $0', () => {
    assert.equal(costUsd({ model: 'gpt-4o-mini', promptTokens: 0, completionTokens: 0 }), 0);
});

test('costUsd: rounds to 6 decimals so JSON stringify stays compact', () => {
    const c = costUsd({ model: 'gpt-4o-mini', promptTokens: 123, completionTokens: 456 });
    const decimals = (String(c).split('.')[1] || '').length;
    assert.ok(decimals <= 6, `too many decimals: ${decimals}`);
});

test('ledger: accumulates tokens + $ across calls', () => {
    const l = createCostLedger({ model: 'gpt-4o-mini' });
    l.add({ promptTokens: 1000, completionTokens: 500 });
    l.add({ promptTokens: 2000, completionTokens: 1000 });
    const t = l.totals();
    assert.equal(t.promptTokens, 3000);
    assert.equal(t.completionTokens, 1500);
    assert.equal(t.totalTokens, 4500);
    assert.equal(t.calls, 2);
    assert.equal(t.cacheHits, 0);
    assert.ok(t.usd > 0);
});

test('ledger: cache hits counted separately (zero tokens still count as a call)', () => {
    const l = createCostLedger({ model: 'gpt-4o-mini' });
    l.add({ promptTokens: 1000, completionTokens: 500 });
    l.add({ cacheHit: true });
    l.add({ cacheHit: true });
    const t = l.totals();
    assert.equal(t.calls, 3);
    assert.equal(t.cacheHits, 2);
    // Only the first call paid tokens
    assert.equal(t.promptTokens, 1000);
});

test('ledger: model stamp appears in totals for audit', () => {
    const l = createCostLedger({ model: 'gpt-4o-mini' });
    l.add({ promptTokens: 100, completionTokens: 50 });
    assert.equal(l.totals().model, 'gpt-4o-mini');
});

test('formatUsd: under 1¢ shows 4 decimals; above shows 4 decimals', () => {
    assert.equal(formatUsd(0), '$0.00');
    assert.equal(formatUsd(0.0008), '$0.0008');
    assert.equal(formatUsd(1.2345), '$1.2345');
});
