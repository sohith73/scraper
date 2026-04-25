// Token pricing + accumulator for per-run cost tracking.
//
// Pricing is published by OpenAI per model, per million tokens:
//   gpt-4o-mini   input $0.15/M  output $0.60/M   (2026-04)
//   gpt-4o        input $2.50/M  output $10.00/M
//   gpt-4-turbo   input $10/M    output $30/M
//
// The scraper uses gpt-4o-mini by default (env.OPENAI_MODEL). If an operator
// switches model, we try to match a known prefix and fall back to mini
// pricing so cost estimates never blow up silently.

// Prices in USD per 1 token (published rates / 1_000_000).
const PRICES = Object.freeze({
    'gpt-4o-mini':        { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
    'gpt-4o':             { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
    'gpt-4-turbo':        { input: 10.0 / 1_000_000, output: 30.00 / 1_000_000 },
    'gpt-3.5-turbo':      { input: 0.50 / 1_000_000, output: 1.50 / 1_000_000 },
    // Newer models can be added without touching callers.
    'gpt-4o-mini-2024':   { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
});

// pricesFor: resolve the per-token USD pair for a model string. Matches on
// prefix so `gpt-4o-mini-2024-07-18` still resolves to the mini rate.
// Unknown → mini (cheapest known) so estimates lean conservative.
export function pricesFor(model) {
    const key = String(model || '').toLowerCase();
    // Exact match wins
    if (PRICES[key]) return PRICES[key];
    // Prefix match, longest-first
    const candidates = Object.keys(PRICES).sort((a, b) => b.length - a.length);
    for (const c of candidates) if (key.startsWith(c)) return PRICES[c];
    return PRICES['gpt-4o-mini'];
}

// costUsd: compute USD cost for a single (promptTokens, completionTokens)
// pair. Returns a plain number rounded to 6 decimals so JSON stringify is
// compact.
export function costUsd({ model, promptTokens = 0, completionTokens = 0 } = {}) {
    const p = pricesFor(model);
    const raw = promptTokens * p.input + completionTokens * p.output;
    return Math.round(raw * 1_000_000) / 1_000_000;
}

// createCostLedger: tiny accumulator — pipeline creates one per run and
// calls `ledger.add(usage)` after every AI call. `ledger.totals()` returns
// the snapshot to stamp into state.progress.cost + Discord message.
//
// Cache hits are counted separately (tokens = 0, calls counter increments
// with cacheHits++) so operators see how many calls were $0 replays.
export function createCostLedger({ model } = {}) {
    let promptTokens = 0;
    let completionTokens = 0;
    let calls = 0;
    let cacheHits = 0;

    function add(usage = {}) {
        calls += 1;
        promptTokens += Number(usage.promptTokens) || 0;
        completionTokens += Number(usage.completionTokens) || 0;
        if (usage.cacheHit === true) cacheHits += 1;
    }

    function totals() {
        const tokens = promptTokens + completionTokens;
        return {
            model,
            calls,
            cacheHits,
            promptTokens,
            completionTokens,
            totalTokens: tokens,
            usd: costUsd({ model, promptTokens, completionTokens }),
        };
    }

    return { add, totals };
}

// formatUsd: human-friendly cost string used in Discord + UI. Under 1¢
// prints as sub-cent ("$0.0008"); otherwise 4 decimals ("$0.1234"). Never
// scientific notation.
export function formatUsd(amount) {
    const n = Number(amount) || 0;
    if (n === 0) return '$0.00';
    if (n < 0.01) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(4)}`;
}
