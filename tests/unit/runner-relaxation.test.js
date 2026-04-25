// Relaxation planner — suggests which filter to widen when the run
// exhausts below target. Pure-function algorithm, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeRelaxationPlan,
    applyRelaxation,
    serialisePlan,
} from '../../src/services/runner/relaxation.js';

function intent(overrides = {}) {
    return {
        roles: ['PM'],
        locations: [],
        seniority: 'mid',
        companies: [],
        workAuth: '',
        narrative: '',
        futurePreferences: '',
        exclusions: { companies: [], locations: [] },
        ...overrides,
    };
}

test('empty intent → only the seniority step (mid → senior bucket added)', () => {
    // The seniority chain is now complete (intern→entry→mid→senior→lead→exec),
    // so "mid" produces a single plan adding "senior" to extraSeniorities.
    const p = computeRelaxationPlan({ intent: intent() });
    assert.equal(p.length, 1);
    assert.equal(p[0].field, 'seniority');
    assert.match(p[0].to, /senior/);
});

test('daysAgo narrow → highest-priority widening', () => {
    const p = computeRelaxationPlan({ intent: intent({ daysAgo: 1 }) });
    assert.ok(p.length > 0);
    assert.equal(p[0].field, 'daysAgo');
    assert.match(p[0].from, /24 h|past 1/i);
    assert.match(p[0].to, /3 days|past 3/i);
});

test('daysAgo ladder: 1→3, 3→7, 7→14, 14→30, 30→60, 60→90, 90→180, 180→omitted', () => {
    const cases = [
        [1, 'past 3 days'],
        [3, 'past 7 days'],
        [7, 'past 14 days'],
        [14, 'past 30 days'],
        [30, 'past 60 days'],
        [60, 'past 90 days'],
        [90, 'past 180 days'],
    ];
    for (const [from, toSubstr] of cases) {
        const p = computeRelaxationPlan({ intent: intent({ daysAgo: from }) });
        assert.ok(p[0], `no plan for daysAgo=${from}`);
        assert.equal(p[0].field, 'daysAgo');
        assert.ok(
            p[0].to.includes(toSubstr),
            `daysAgo=${from}: expected "${toSubstr}" in "${p[0].to}"`,
        );
    }
    // 180 should NOT be proposed as a widening target (already at max before "all time").
    const at180 = computeRelaxationPlan({ intent: intent({ daysAgo: 180 }) });
    // 180 bucket widens to "all time" (null).
    const dayPlan = at180.find((x) => x.field === 'daysAgo');
    if (dayPlan) assert.match(dayPlan.to, /all time/i);
});

test('single-model workModels proposed', () => {
    const p = computeRelaxationPlan({ intent: intent({ workModels: ['hybrid'] }) });
    const wm = p.find((x) => x.field === 'workModels');
    assert.ok(wm);
    assert.equal(wm.from, 'hybrid');
    assert.match(wm.to, /any/i);
});

test('salaryMinimumUsd > 0 proposed with $30k drop for high floors', () => {
    const p = computeRelaxationPlan({ intent: intent({ salaryMinimumUsd: 200000 }) });
    const s = p.find((x) => x.field === 'salaryMinimumUsd');
    assert.ok(s);
    assert.match(s.from, /200,000|200k/);
    assert.match(s.to, /170,000|170k/);
});

test('small-city locations → add Remote', () => {
    const p = computeRelaxationPlan({
        intent: intent({ locations: ['Chicago', 'Austin'] }),
    });
    const l = p.find((x) => x.field === 'locations');
    assert.ok(l);
    assert.match(l.to, /Remote/);
});

test('narrow YoE band → widen ±2', () => {
    const p = computeRelaxationPlan({
        intent: intent({ minYearsOfExperience: 5, maxYearsOfExperience: 8 }),
    });
    const y = p.find((x) => x.field === 'yoe');
    assert.ok(y);
    assert.match(y.from, /5–8 yrs/);
    assert.match(y.to, /3–10 yrs/);
});

test('seniority step: entry → entry+mid (UNION, not replace)', () => {
    // Bug fix 2026-04-25: replacing entry with mid made JR drop the
    // entry-level jobs from results. The fix appends to extraSeniorities
    // so JR sees seniority=[entry, mid] = wider pool, not narrower.
    const p = computeRelaxationPlan({ intent: intent({ seniority: 'entry' }) });
    const s = p.find((x) => x.field === 'seniority');
    assert.ok(s);
    assert.equal(s.from, 'entry');
    assert.match(s.to, /entry \+ mid/);
    // applyRelaxation should put `mid` into extraSeniorities, leave
    // primary `seniority` alone.
    const next = s.apply({ seniority: 'entry' });
    assert.equal(next.seniority, 'entry');
    assert.deepEqual(next.extraSeniorities, ['mid']);
});

test('plans returned sorted by priority (descending)', () => {
    const p = computeRelaxationPlan({
        intent: intent({
            daysAgo: 1,                    // priority 10
            workModels: ['remote'],         // 8
            salaryMinimumUsd: 150000,       // 7
            seniority: 'entry',             // 4
        }),
    });
    for (let i = 1; i < p.length; i += 1) {
        assert.ok(p[i - 1].priority >= p[i].priority, `not sorted at ${i}`);
    }
});

test('applyRelaxation produces new object with mutated field', () => {
    const i = intent({ daysAgo: 1 });
    const [plan] = computeRelaxationPlan({ intent: i });
    const next = applyRelaxation(i, plan);
    assert.notEqual(next, i); // new object
    assert.notEqual(next.daysAgo, 1); // widened
    assert.equal(i.daysAgo, 1); // input unchanged
});

test('serialisePlan strips the apply fn for wire transport', () => {
    const [plan] = computeRelaxationPlan({ intent: intent({ daysAgo: 1 }) });
    const [wire] = serialisePlan([plan]);
    assert.equal('apply' in wire, false);
    assert.equal(wire.field, 'daysAgo');
    assert.equal(wire.index, 0);
    assert.equal(typeof wire.reason, 'string');
});

test('limit caps returned plans', () => {
    const p = computeRelaxationPlan({
        intent: intent({
            daysAgo: 1,
            workModels: ['remote'],
            salaryMinimumUsd: 200000,
            locations: ['Chicago', 'Austin'],
            minYearsOfExperience: 5,
            maxYearsOfExperience: 8,
            seniority: 'entry',
        }),
        limit: 2,
    });
    assert.equal(p.length, 2);
    // Top two by priority: daysAgo (10), workModels (8)
    assert.equal(p[0].field, 'daysAgo');
    assert.equal(p[1].field, 'workModels');
});
