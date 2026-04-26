// Filter-relaxation planner.
//
// Why : when the pagination loop exhausts without hitting requestedCount,
//       we don't want to silently give up. Instead we compute a ranked
//       list of filter widenings (each with a concrete before/after value
//       and a one-line reason) and ask the operator which to apply.
//
// Algorithm :
//   1. Inspect the current SearchIntent field-by-field.
//   2. For each field that could plausibly be narrowing results, emit a
//      candidate `{ field, label, from, to, apply, reason, priority }`.
//   3. Sort by priority — the best-leverage widenings first. Priority
//      reflects rough "expected new jobs per 100 scanned":
//        date-posted → 10  (huge variance; narrow dates are the #1 culprit)
//        work-model  →  8
//        salary-floor → 7
//        locations   →  6
//        yoe-band    →  5
//        seniority   →  4
//        employment-types → 3
//        company-stages   → 3
//   4. Return top N (default 4) — operator picks one, we apply via
//      `applyRelaxation(intent, plan)`.
//
// Each plan entry carries an `apply(intent) => nextIntent` function so
// the caller doesn't need to reverse-engineer how to mutate each field.

const DAYS_AGO_LADDER = [null, 180, 90, 60, 30, 14, 7, 3, 1];

// nextDaysAgoBucket: walk up the ladder one rung (more days = less restrictive).
// Returns null once we're already at "all time".
function nextDaysAgoBucket(current) {
    if (!Number.isInteger(current)) return null; // already all-time
    const idx = DAYS_AGO_LADDER.indexOf(current);
    if (idx <= 0) return null;
    const next = DAYS_AGO_LADDER[idx - 1];
    return next; // null means "all time"
}

function fmtDaysAgo(v) {
    if (v === null || v === undefined) return 'all time';
    if (v === 1) return 'past 24 h';
    return `past ${v} days`;
}

// computeRelaxationPlan: returns up to `limit` ranked widenings.
// input  : { intent, stats?: {picked, pushed, requested} }
// output : Array<{ field, label, from, to, reason, apply, priority }>
export function computeRelaxationPlan({ intent, limit = 4 } = {}) {
    if (!intent || typeof intent !== 'object') return [];
    const plans = [];

    // --- date posted ---------------------------------------------------
    // HARDCODED to past 24 h (filterMapper enforces daysAgo=1 regardless
    // of intent). Skipping this widening so the operator-visible
    // "auto-changed filters" panel never lists Date-posted changes that
    // wouldn't actually reach JR.

    // --- work model -----------------------------------------------------
    const wm = Array.isArray(intent.workModels) ? intent.workModels : [];
    if (wm.length > 0 && wm.length < 3) {
        plans.push({
            field: 'workModels',
            label: 'Work model',
            from: wm.join(', '),
            to: 'any (onsite / remote / hybrid)',
            reason: 'A single work-model filter cuts the candidate pool by ~60%.',
            priority: 8,
            apply: (i) => ({ ...i, workModels: null }),
        });
    }

    // --- salary floor ---------------------------------------------------
    if (Number.isInteger(intent.salaryMinimumUsd) && intent.salaryMinimumUsd > 0) {
        const cur = intent.salaryMinimumUsd;
        const next = cur > 120000 ? cur - 30000 : null;
        plans.push({
            field: 'salaryMinimumUsd',
            label: 'Min salary',
            from: `$${cur.toLocaleString()}`,
            to: next ? `$${next.toLocaleString()}` : 'any (many postings omit salary)',
            reason: 'Most postings don\'t publish salary; the filter drops them all.',
            priority: 7,
            apply: (i) => ({ ...i, salaryMinimumUsd: next }),
        });
    }

    // --- locations ------------------------------------------------------
    // Locations widening removed — mapLocations now hardcodes the JR
    // filter to country-wide (Within US / Within CA), so there's nothing
    // to widen. Country still flips US ↔ CA via the operator dropdown.

    // --- YoE band -------------------------------------------------------
    if (Number.isInteger(intent.minYearsOfExperience) && Number.isInteger(intent.maxYearsOfExperience)) {
        const a = intent.minYearsOfExperience;
        const b = intent.maxYearsOfExperience;
        if (b - a <= 4) {
            const newMin = Math.max(0, a - 2);
            const newMax = Math.min(40, b + 2);
            plans.push({
                field: 'yoe',
                label: 'Years of experience',
                from: `${a}–${b} yrs`,
                to: `${newMin}–${newMax} yrs`,
                reason: 'Widening the YoE band by 2 on each side catches adjacent postings.',
                priority: 5,
                apply: (i) => ({
                    ...i,
                    minYearsOfExperience: newMin,
                    maxYearsOfExperience: newMax,
                }),
            });
        }
    }

    // --- seniority ------------------------------------------------------
    // Each step ADDS the next bucket to `extraSeniorities` instead of
    // replacing the primary. JR's filter then sees the union, e.g. an
    // entry candidate keeps entry jobs AND gains mid jobs after the
    // first relaxation round. Replacing was causing the candidate pool
    // to shrink instead of grow when the operator clicked "widen".
    const s = intent.seniority;
    const SENIORITY_STEPS = { intern: 'entry', entry: 'mid', mid: 'senior', senior: 'lead', lead: 'exec' };
    const existingExtras = Array.isArray(intent.extraSeniorities) ? intent.extraSeniorities : [];
    const allCovered = new Set([s, ...existingExtras]);
    let candidate = SENIORITY_STEPS[s];
    while (candidate && allCovered.has(candidate)) {
        candidate = SENIORITY_STEPS[candidate];
    }
    if (candidate) {
        const fromLabel = [s, ...existingExtras].filter(Boolean).join(' + ');
        plans.push({
            field: 'seniority',
            label: 'Seniority',
            from: fromLabel,
            to: `${fromLabel} + ${candidate}`,
            reason: `Adding "${candidate}" to the seniority pool widens the role pool without dropping current matches.`,
            priority: 4,
            apply: (i) => ({
                ...i,
                extraSeniorities: [...new Set([...existingExtras, candidate])],
            }),
        });
    }

    // --- employment types ----------------------------------------------
    const et = Array.isArray(intent.employmentTypes) ? intent.employmentTypes : [];
    if (et.length === 1 && et[0] === 'full-time') {
        plans.push({
            field: 'employmentTypes',
            label: 'Employment type',
            from: 'full-time only',
            to: 'any (full-time / contract / part-time)',
            reason: 'Including contract + part-time captures ~15% more roles.',
            priority: 3,
            apply: (i) => ({ ...i, employmentTypes: null }),
        });
    }

    // --- company stages -------------------------------------------------
    const cs = Array.isArray(intent.companyStages) ? intent.companyStages : [];
    if (cs.length > 0 && cs.length < 5) {
        plans.push({
            field: 'companyStages',
            label: 'Company stages',
            from: cs.join(', '),
            to: 'any',
            reason: 'Company-stage filters are advisory; clearing widens significantly.',
            priority: 3,
            apply: (i) => ({ ...i, companyStages: null }),
        });
    }

    plans.sort((a, b) => b.priority - a.priority);
    return plans.slice(0, limit);
}

// applyRelaxation: mutates an intent by running a plan entry's apply fn.
// Safe for the calling pipeline — returns a NEW object, never mutates the
// input.
export function applyRelaxation(intent, plan) {
    if (!plan || typeof plan.apply !== 'function') return intent;
    return plan.apply(intent);
}

// serialiseForWire: strip the function so we can ship the plan over JSON.
// Caller (route handler) gets a plain object suitable for `store.update`.
export function serialisePlan(plans) {
    return plans.map((p, index) => ({
        index,
        field: p.field,
        label: p.label,
        from: p.from,
        to: p.to,
        reason: p.reason,
        priority: p.priority,
    }));
}
