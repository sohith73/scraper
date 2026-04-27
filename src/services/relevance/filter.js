// filterJobsByRelevance — Phase 10 entry point.
//
// Input  : canonical Job[] from Phase 9 + the SearchIntent from Phase 5.
// Output : one decision per job: { pick, score, reason } plus the original
//          Job for easy downstream consumption.
//
// Implementation notes:
//   - Jobs are batched (default 20) and batches run in parallel. Each batch
//     is a single gpt-4o-mini call with json_schema strict output.
//   - If the model drops or renames any id, we still return SOMETHING for
//     every input job (defaulting to pick=false, score=0, reason="no
//     decision returned") so the caller can trust the output shape.
//   - The Phase-4 AI client handles retries + caching. Identical
//     (intent + jobs) inputs return $0 replays.

import { ok, err } from '../../clients/common/result.js';
import {
    BATCH_DECISIONS_JSON_SCHEMA,
    BatchDecisionsSchema,
} from './schema.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';

const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 40; // cap — gpt-4o-mini starts silently dropping > ~40

// chunk: split an array into equal-sized chunks (last one may be smaller).
function chunk(list, size) {
    if (size <= 0) return [list];
    const out = [];
    for (let i = 0; i < list.length; i += size) {
        out.push(list.slice(i, i + size));
    }
    return out;
}

// runBatch: one AI call + validation + id-index lookup. Internal.
async function runBatch({ ai, intent, batch, batchIndex, schemaVersion, calibration }) {
    const user = buildUserPrompt({ intent, jobs: batch, calibration });
    const aiRes = await ai.completeJson({
        system: SYSTEM_PROMPT,
        user,
        schema: BATCH_DECISIONS_JSON_SCHEMA,
        schemaName: `Decisions_v${schemaVersion}`,
        zodSchema: BatchDecisionsSchema,
    });
    if (!aiRes.ok) {
        return err(aiRes.error.code, aiRes.error.message, {
            batchIndex,
            cause: aiRes.error.cause,
        });
    }
    const decisionsById = new Map();
    for (const d of aiRes.value.value.decisions) {
        decisionsById.set(d.id, d);
    }
    return ok({
        decisions: aiRes.value.value.decisions,
        decisionsById,
        cacheHit: aiRes.value.cacheHit,
        usage: aiRes.value.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
}

// filterJobsByRelevance: the only public export.
//
// input  : { ai, intent, jobs, batchSize?, schemaVersion? }
// output : Result<{
//            scored: [{ job, decision:{id,pick,score,reason} }],
//            picks:       Job[] (convenience — scored.filter(pick))
//            skips:       Job[]
//            borderline:  Job[] (pick=false but score >= 40)
//            stats: { totalJobs, picked, skipped, borderline, batches, cacheHits, durationMs }
//          }>
export async function filterJobsByRelevance({
    ai,
    intent,
    jobs,
    batchSize = DEFAULT_BATCH_SIZE,
    schemaVersion = 1,
    calibration = '',
} = {}) {
    if (!ai || typeof ai.completeJson !== 'function') {
        return err('BAD_INPUT', 'ai.completeJson is required');
    }
    if (!intent || typeof intent !== 'object') {
        return err('BAD_INPUT', 'intent is required');
    }
    if (!Array.isArray(jobs)) {
        return err('BAD_INPUT', 'jobs must be an array');
    }
    if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > MAX_BATCH_SIZE) {
        return err(
            'BAD_INPUT',
            `batchSize must be an integer in [1, ${MAX_BATCH_SIZE}]`,
        );
    }

    const startedAt = Date.now();

    if (jobs.length === 0) {
        return ok({
            scored: [],
            picks: [],
            skips: [],
            borderline: [],
            stats: {
                totalJobs: 0,
                picked: 0,
                skipped: 0,
                borderline: 0,
                batches: 0,
                cacheHits: 0,
                durationMs: 0,
            },
        });
    }

    const batches = chunk(jobs, batchSize);
    const results = await Promise.all(
        batches.map((batch, batchIndex) =>
            runBatch({ ai, intent, batch, batchIndex, schemaVersion, calibration }),
        ),
    );

    // If any batch failed, bubble the first error. Partial success is
    // worse than a clean failure for this stage.
    for (const r of results) {
        if (!r.ok) return r;
    }

    // Merge decisions + map back to original jobs in input order.
    const mergedById = new Map();
    for (const r of results) {
        for (const [id, d] of r.value.decisionsById) {
            mergedById.set(id, d);
        }
    }

    const scored = jobs.map((job) => {
        const d = mergedById.get(job.id);
        return {
            job,
            decision: d || {
                id: job.id,
                pick: false,
                score: 0,
                reason: 'no decision returned',
            },
        };
    });

    // Borderline = pick=false but score ≥ 30. Threshold lowered 2026-04-27
    // so the operator's wider-net request is honoured: anything ≥30 flows
    // through to push (pipeline forwards picks + borderline together).
    // Per-client JR accounts also mean candidates are pre-filtered by JR's
    // own recommender against the client's resume, so loose AI matches
    // are usually still good signal.
    const BORDERLINE_FLOOR = 30;
    const picks = scored.filter((s) => s.decision.pick === true).map((s) => s.job);
    const skips = scored
        .filter((s) => s.decision.pick !== true && s.decision.score < BORDERLINE_FLOOR)
        .map((s) => s.job);
    const borderline = scored
        .filter((s) => s.decision.pick !== true && s.decision.score >= BORDERLINE_FLOOR)
        .map((s) => s.job);

    const cacheHits = results.filter((r) => r.value.cacheHit).length;
    // Aggregate token usage across batches. Cache-hit batches contribute 0.
    const usage = results.reduce(
        (acc, r) => {
            const u = r.value.usage || {};
            acc.promptTokens += u.promptTokens || 0;
            acc.completionTokens += u.completionTokens || 0;
            acc.totalTokens += u.totalTokens || 0;
            return acc;
        },
        { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    );

    return ok({
        scored,
        picks,
        skips,
        borderline,
        stats: {
            totalJobs: jobs.length,
            picked: picks.length,
            skipped: skips.length,
            borderline: borderline.length,
            batches: batches.length,
            cacheHits,
            usage,
            durationMs: Date.now() - startedAt,
        },
    });
}
