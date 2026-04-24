// Detail enrichment / completeness gate.
//
// Phase 0 recon showed JR's `/swan/recommend/list/jobs` returns fully
// hydrated jobs — summary + responsibilities + qualifications + applyLink
// — in a single payload. The planned Phase 11 click-and-capture flow is
// therefore unnecessary in the common case.
//
// What this module DOES do:
//   1. validate every canonical Job has the fields Phase 12 needs for
//      `POST /addjob` (jobTitle, companyName, joblink, jobDescription).
//   2. partition the input into `ready` (safe to push) vs `sparse` (missing
//      at least one required field — either JR returned a thin record or
//      the adapter produced an edge-case output).
//   3. expose a clean injection point for a FUTURE fetchJobDetail hook.
//      When JR starts returning sparse data, plug it in here; no caller
//      changes needed.
//
// Rejection reasons are stable strings so the UI / logs can tell operators
// what's wrong with each skipped job.

import { ok, err } from '../../clients/common/result.js';

// DEFAULT_MIN_DESCRIPTION_CHARS — dashboard backend doesn't reject short
// descriptions, but a 50-char blurb is rarely useful to a client. 300 is
// empirically sufficient (our first real job produced 2118 chars).
export const DEFAULT_MIN_DESCRIPTION_CHARS = 300;

// inspectJobCompleteness: pure validator. No side effects.
// input  : canonical Job, { minDescriptionChars }
// output : { complete:boolean, missingFields:string[], reason:string }
export function inspectJobCompleteness(
    job,
    { minDescriptionChars = DEFAULT_MIN_DESCRIPTION_CHARS } = {},
) {
    if (!job || typeof job !== 'object') {
        return {
            complete: false,
            missingFields: ['<all>'],
            reason: 'job is not an object',
        };
    }
    const missing = [];
    if (!job.id) missing.push('id');
    if (!job.title || !String(job.title).trim()) missing.push('title');
    if (!job.companyName || !String(job.companyName).trim()) missing.push('companyName');
    if (!job.applyUrl || !String(job.applyUrl).trim()) missing.push('applyUrl');
    const desc = typeof job.description === 'string' ? job.description : '';
    if (desc.trim().length < minDescriptionChars) missing.push('description');
    if (missing.length === 0) {
        return { complete: true, missingFields: [], reason: '' };
    }
    return {
        complete: false,
        missingFields: missing,
        reason: missing.includes('description')
            ? `description shorter than ${minDescriptionChars} chars`
            : `missing required fields: ${missing.join(', ')}`,
    };
}

// enrichJobs: partition jobs into `ready` / `sparse`. No network — just a
// completeness gate until click-and-capture lands (deferred indefinitely).
//
// input  : { jobs, minDescriptionChars?, fetchDetail?, logger? }
//          fetchDetail  optional async (job) => enrichedJob | null. Reserved
//                       for a future Phase-11.5 that pulls full JD from a
//                       per-job detail endpoint when one appears. v1 does
//                       not call this even if provided — keeps the hook
//                       compatible without executing anything.
// output : Result<{
//            ready: Job[],
//            sparse: [{ job, missingFields, reason }],
//            stats: { total, ready, sparse, durationMs }
//          }>
export async function enrichJobs({
    jobs,
    minDescriptionChars = DEFAULT_MIN_DESCRIPTION_CHARS,
    logger = null,
} = {}) {
    if (!Array.isArray(jobs)) {
        return err('BAD_INPUT', 'jobs must be an array');
    }
    if (!Number.isInteger(minDescriptionChars) || minDescriptionChars < 0) {
        return err('BAD_INPUT', 'minDescriptionChars must be a non-negative integer');
    }

    const startedAt = Date.now();
    const ready = [];
    const sparse = [];
    for (const job of jobs) {
        const check = inspectJobCompleteness(job, { minDescriptionChars });
        if (check.complete) {
            ready.push(job);
        } else {
            logger?.debug?.(
                { jobId: job?.id, missing: check.missingFields, reason: check.reason },
                'enrichJobs: job is sparse',
            );
            sparse.push({
                job,
                missingFields: check.missingFields,
                reason: check.reason,
            });
        }
    }

    return ok({
        ready,
        sparse,
        stats: {
            total: jobs.length,
            ready: ready.length,
            sparse: sparse.length,
            durationMs: Date.now() - startedAt,
        },
    });
}
