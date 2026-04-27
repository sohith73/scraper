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

test('daysAgo never proposed — hardcoded past-24-h, relaxation skips it', () => {
    // 2026-04-26: filterMapper always sends daysAgo=1 regardless of intent;
    // relaxation no longer proposes Date-posted widenings so the UI
    // "auto-changed filters" panel doesn't show changes that wouldn't
    // actually reach JR.
    for (const d of [1, 3, 7, 14, 30, 60, 90, 180]) {
        const p = computeRelaxationPlan({ intent: intent({ daysAgo: d }) });
        assert.equal(p.find((x) => x.field === 'daysAgo'), undefined,
            `daysAgo=${d} should NOT appear in plan`);
    }
});

test('single-model workModels proposed', () => {
    const p = computeRelaxationPlan({ intent: intent({ workModels: ['hybrid'] }) });
    const wm = p.find((x) => x.field === 'workModels');
    assert.ok(wm);
    assert.equal(wm.from, 'hybrid');
    assert.match(wm.to, /any/i);
});

test('salaryMinimumUsd no longer in plan — mapper hardcodes null', () => {
    // 2026-04-27: filterMapper forces annualSalaryMinimum=null regardless
    // of intent; relaxation skips salary widening so the operator-visible
    // "auto-changed filters" panel never lists Min-salary changes that
    // wouldn't reach JR.
    const p = computeRelaxationPlan({ intent: intent({ salaryMinimumUsd: 200000 }) });
    assert.equal(p.find((x) => x.field === 'salaryMinimumUsd'), undefined);
});

test('locations no longer in plan — mapper hardcodes country-wide', () => {
    // mapLocations always emits "Within US"/"Within CA"; nothing to widen.
    const p = computeRelaxationPlan({
        intent: intent({ locations: ['Chicago', 'Austin'] }),
    });
    assert.equal(p.find((x) => x.field === 'locations'), undefined);
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
    const i = intent({ workModels: ['remote'] });
    const [plan] = computeRelaxationPlan({ intent: i });
    const next = applyRelaxation(i, plan);
    assert.notEqual(next, i); // new object
    assert.notDeepEqual(next.workModels, i.workModels);
    assert.deepEqual(i.workModels, ['remote']); // input unchanged
});

test('serialisePlan strips the apply fn for wire transport', () => {
    const [plan] = computeRelaxationPlan({ intent: intent({ workModels: ['remote'] }) });
    const [wire] = serialisePlan([plan]);
    assert.equal('apply' in wire, false);
    assert.equal(wire.field, 'workModels');
    assert.equal(wire.index, 0);
    assert.equal(typeof wire.reason, 'string');
});

test('limit caps returned plans', () => {
    const p = computeRelaxationPlan({
        intent: intent({
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
    // Top two by priority after daysAgo + salary removed: workModels (8), yoe (5)
    assert.equal(p[0].field, 'workModels');
    assert.equal(p[1].field, 'yoe');
});
