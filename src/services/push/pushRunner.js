// pushRunner — POST each job to the dashboard's /addjob with bounded
// concurrency, then classify the outcome.
//
// We don't use p-queue; a ~15-line worker-pool gets the same result with
// zero deps. Concurrency defaults to 2 — high enough to be faster than
// serial, low enough to avoid hammering the shared dashboard backend.
//
// Outcome classification funnels Result<{outcome}> | Result<err> into four
// stable buckets the UI displays directly:
//   pushed      — new job created (createdJobId returned)
//   duplicate   — already in the client's tracker (server or local detection)
//   blocked     — exclusion / lock-period refusal from the dashboard
//   errors      — transport / shape / unexpected-status failures

import { ok, err } from '../../clients/common/result.js';
import { toDashboardJob } from '../../adapters/jobright.js';

// runWorkers: runs `fn(item, index)` over `items` with at most `concurrency`
// concurrent invocations. Results are returned in input order.
async function runWorkers(items, fn, concurrency) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const i = next;
            next += 1;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    }
    const pool = Array.from(
        { length: Math.min(concurrency, items.length) },
        () => worker(),
    );
    await Promise.all(pool);
    return results;
}

// classifyPushResult: one place to turn the dashboard client's Result
// into one of our four outcome buckets.
function classifyPushResult(job, result) {
    if (!result) {
        return { bucket: 'errors', code: 'UNKNOWN', reason: 'no result' };
    }
    if (result.ok === true) {
        const outcome = result.value?.outcome;
        if (outcome === 'created') {
            return {
                bucket: 'pushed',
                code: 'CREATED',
                reason: 'ok',
                createdJobId: result.value?.createdJobId || '',
            };
        }
        if (outcome === 'duplicate') {
            return { bucket: 'duplicates', code: 'DUPLICATE', reason: 'server dedupe hit' };
        }
        if (outcome === 'dry-run') {
            // In DRY_RUN we count the attempt as "pushed" so the UI shows it
            // as successful, but tag with a dry-run code so nobody is surprised.
            return {
                bucket: 'pushed',
                code: 'DRY_RUN',
                reason: 'DRY_RUN=1 — payload logged, not sent',
            };
        }
        return {
            bucket: 'errors',
            code: 'UNKNOWN_OUTCOME',
            reason: `unexpected outcome "${outcome}"`,
        };
    }
    // Err path.
    const code = result.error?.code || 'UNKNOWN';
    if (code === 'BLOCKED_COMPANY' || code === 'BLOCKED_LOCATION' || code === 'CLIENT_LOCKED') {
        return { bucket: 'blocked', code, reason: result.error.message || code };
    }
    if (code === 'DUPLICATE') {
        return { bucket: 'duplicates', code, reason: result.error.message || '' };
    }
    return {
        bucket: 'errors',
        code,
        reason: result.error?.message || code,
    };
}

// runPush: the public orchestrator.
//
// input  :
//   dashboard          the dashboard client namespace (container.dashboard)
//                       — must expose .pushJob({ job, clientEmail, clientName })
//   clientEmail        string, lowercased before the dashboard call
//   clientName         optional display name
//   jobs               canonical Job[] (already preflight-filtered)
//   concurrency        default 2, max 5
//   logger             pino-like, optional
//
// output :
//   Result<{
//     pushed:    [{ job, createdJobId, code }],
//     duplicates:[{ job, code, reason }],
//     blocked:   [{ job, code, reason }],
//     errors:    [{ job, code, reason }],
//     stats:     { total, pushed, duplicates, blocked, errors, durationMs }
//   }>
export async function runPush({
    dashboard,
    clientEmail,
    clientName = '',
    jobs,
    concurrency = 2,
    logger = null,
} = {}) {
    if (!dashboard || typeof dashboard.pushJob !== 'function') {
        return err('BAD_INPUT', 'dashboard.pushJob is required');
    }
    if (typeof clientEmail !== 'string' || !clientEmail.includes('@')) {
        return err('BAD_INPUT', 'clientEmail is required');
    }
    if (!Array.isArray(jobs)) {
        return err('BAD_INPUT', 'jobs must be an array');
    }
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
        return err('BAD_INPUT', 'concurrency must be an integer in [1,5]');
    }

    const startedAt = Date.now();
    const buckets = { pushed: [], duplicates: [], blocked: [], errors: [] };

    await runWorkers(
        jobs,
        async (job) => {
            try {
                const r = await dashboard.pushJob({
                    job: toDashboardJob(job),
                    clientEmail,
                    clientName,
                });
                const cls = classifyPushResult(job, r);
                logger?.debug?.(
                    { jobId: job.id, bucket: cls.bucket, code: cls.code },
                    'push classified',
                );
                if (cls.bucket === 'pushed') {
                    buckets.pushed.push({
                        job,
                        createdJobId: cls.createdJobId || '',
                        code: cls.code,
                    });
                } else {
                    buckets[cls.bucket].push({
                        job,
                        code: cls.code,
                        reason: cls.reason,
                    });
                }
            } catch (e) {
                logger?.error?.({ err: e.message, jobId: job.id }, 'push threw');
                buckets.errors.push({ job, code: 'THREW', reason: e.message });
            }
        },
        concurrency,
    );

    return ok({
        ...buckets,
        stats: {
            total: jobs.length,
            pushed: buckets.pushed.length,
            duplicates: buckets.duplicates.length,
            blocked: buckets.blocked.length,
            errors: buckets.errors.length,
            durationMs: Date.now() - startedAt,
        },
    });
}
