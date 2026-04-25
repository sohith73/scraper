// Pipeline composer — glues Phases 2/3/5/9/10/11/12 into a linear sequence
// for one run. Every transition goes through `store.update(runId, patch)`
// so subscribers see a live state stream.
//
// Abort semantics: cooperative. We check `abortRequested` at phase
// boundaries — never mid-Playwright. Operators can ask for abort; the
// run stops on the next checkpoint.
//
// Error handling: the first Result that comes back with ok:false terminates
// the run as `failed` and copies the error code/message into state.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PHASES } from './state.js';
import { runSearch } from '../search/index.js';
import { filterJobsByRelevance } from '../relevance/index.js';
import { enrichJobs } from '../detail/index.js';
import { runPreflight, runPush } from '../push/index.js';
import {
    createRunLogger,
    writeErrorArtifact,
    writeSummaryArtifact,
} from './runLogger.js';
import { setCooldown } from './cooldown.js';
import { buildCalibrationBlock } from '../feedback/prompt.js';
import {
    computeRelaxationPlan,
    applyRelaxation,
    serialisePlan,
} from './relaxation.js';
import {
    notifyRunDone,
    notifyRunFailed,
    notifyNoJobs,
    notifyCooldown,
    computeCulprits,
} from '../notify/index.js';
import { createCostLedger } from '../../ai/costs.js';
import { isLinkedInApplyUrl } from '../../adapters/jobright.js';

// Error codes that signal JR is throttling / blocking us — on these we
// write a cooldown so the next run refuses up-front.
const COOLDOWN_TRIGGER_CODES = new Set([
    'RATE_LIMITED',
    'BLOCKED_BY_JOBRIGHT',
    'NEEDS_REAUTH',
]);

// checkAbort: if the operator has requested abort, mark the run and signal
// the pipeline to exit. Returns true when aborted.
function checkAbort(store, runId, logger) {
    const r = store.get(runId);
    if (!r) return true; // run gone: treat as aborted
    if (r.abortRequested) {
        logger?.warn?.({ phase: r.phase }, 'abort requested — stopping');
        store.update(runId, { phase: PHASES.ABORTED });
        return true;
    }
    return false;
}

// failRun: centralise the "this phase failed" transition so the caller
// can early-return cleanly.
// `notifier` is optional — passed when the caller has access to the
// container; absent during the `.catch` synthesised in the outer try/catch.
function failRun(store, runId, error, logger, notifier = null) {
    logger?.error?.(
        { code: error?.code, message: error?.message },
        'run failing',
    );
    store.update(runId, {
        phase: PHASES.FAILED,
        error: {
            code: error?.code || 'UNEXPECTED',
            message: error?.message || String(error),
        },
    });
    if (notifier?.enabled) {
        notifyRunFailed({ notifier, run: store.get(runId), logger }).catch(() => {});
    }
}

// waitForRelaxationDecision: poll the run state until operator answers
// (via POST /api/runs/:id/expand), or aborts, or we time out. Polling at
// 500ms is cheap — single run, single operator — and avoids adding an
// EventEmitter primitive to the store just for this one flow.
// Returns one of:
//   { action: 'accept', planIndex, plans }
//   { action: 'decline' }
//   { action: 'abort' }       (operator clicked Abort)
//   { action: 'timeout' }     (>30min no response)
async function waitForRelaxationDecision(store, runId, { timeoutMs = 30 * 60_000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const r = store.get(runId);
        if (!r) return { action: 'abort' };
        if (r.abortRequested) return { action: 'abort' };
        const decision = r.pendingRelaxation?.decision;
        if (decision) return decision;
        await new Promise((res) => setTimeout(res, 500));
    }
    return { action: 'timeout' };
}

// writeArtifact: best-effort per-run side file. Never throws.
async function writeArtifact(dir, name, value) {
    try {
        await writeFile(join(dir, name), JSON.stringify(value, null, 2), 'utf8');
    } catch {
        /* ignore */
    }
}

// runPipeline: drives one run from `queued` to a terminal phase.
//
// input  : { store, runId, container, overrideIntent? }
// output : Promise<void> — all observable state flows through `store`
export async function runPipeline({
    store,
    runId,
    container,
    overrideIntent = null,
    overrideFields = null,
    resumeFrom = null,
} = {}) {
    const run = store.get(runId);
    if (!run) return;
    const { clientEmail, requestedCount, clientName } = run;
    const { dashboard, resume, summariser, browser, mutex, ai, env, clientFilters, feedback, notifier, logger: rootLogger } =
        container;
    const runArtDir = store.runDir(runId);

    // Per-run logger: tees every line to runs/<id>/run.log AND stdout.
    // Created once at entry; closed on the single exit below.
    let runLogger = rootLogger;
    let closeRunLogger = async () => {};
    try {
        const made = await createRunLogger({
            runDir: runArtDir,
            runId,
            rootLogger,
        });
        runLogger = made.logger;
        closeRunLogger = made.closeStream;
    } catch (e) {
        rootLogger?.warn?.(
            { err: e.message },
            'runLogger init failed — falling back to root logger',
        );
    }
    const logger = runLogger;

    // phaseTimer: wraps a phase so we log enter/exit + durationMs
    async function phaseTimer(name, fn) {
        const t0 = Date.now();
        logger?.info?.({ phase: name }, 'phase: start');
        try {
            const out = await fn();
            logger?.info?.({ phase: name, durationMs: Date.now() - t0 }, 'phase: ok');
            return out;
        } catch (e) {
            logger?.error?.(
                { phase: name, err: e.message, durationMs: Date.now() - t0 },
                'phase: threw',
            );
            throw e;
        }
    }

    // Per-run cost ledger — accumulates OpenAI token usage from the
    // summariser + every relevance batch. Surfaced in state.progress.cost
    // and the Discord success message.
    const costLedger = createCostLedger({ model: env?.OPENAI_MODEL || 'gpt-4o-mini' });

    try {
        logger?.info?.(
            { clientEmail, requestedCount, clientName },
            'run: starting',
        );

        // ---- 1. load profile ----------------------------------------
        store.update(runId, { phase: PHASES.LOADING_PROFILE });
        const profileRes = await phaseTimer('loading-profile', () =>
            dashboard.getProfile(clientEmail),
        );
        if (!profileRes.ok) return failRun(store, runId, profileRes.error, logger, notifier);
        if (checkAbort(store, runId, logger)) return;

        // ---- 2. load exclusions (best-effort) -----------------------
        store.update(runId, { phase: PHASES.LOADING_EXCLUSIONS });
        const exclRes = await phaseTimer('loading-exclusions', () =>
            dashboard.getExclusions(clientEmail),
        );
        const exclusions = exclRes.ok
            ? {
                  companies: exclRes.value.excludedCompanies,
                  locations: exclRes.value.excludedLocations,
              }
            : { companies: [], locations: [] };
        if (checkAbort(store, runId, logger)) return;

        // ---- 3. load resume (optional) ------------------------------
        store.update(runId, { phase: PHASES.LOADING_RESUME });
        const resumeRes = await phaseTimer('loading-resume', () =>
            resume.getByEmail(clientEmail),
        );
        const resumeDoc =
            resumeRes.ok && resumeRes.value.found ? resumeRes.value.resume : null;
        if (checkAbort(store, runId, logger)) return;

        // ---- 4. summarise → SearchIntent ----------------------------
        // Resume is MANDATORY unless the operator provided a prebuilt
        // overrideIntent (typically pre-saved from a prior run where the
        // resume was present). Without it, gpt-4o-mini has to guess roles
        // and skills from the onboarding profile alone → relevance filter
        // downstream starts picking random jobs.
        store.update(runId, { phase: PHASES.SUMMARISING });
        let intent = overrideIntent;
        if (!intent && !resumeDoc) {
            return failRun(
                store,
                runId,
                {
                    code: 'RESUME_MISSING',
                    message:
                        'No resume attached for this client. Attach one in gemini-resume before running a scrape, or save an override intent first.',
                },
                logger,
                notifier,
            );
        }
        if (!intent) {
            const sumRes = await phaseTimer('summarising', () =>
                summariser({
                    profile: profileRes.value.profile,
                    resume: resumeDoc,
                    exclusions,
                    clientEmail,
                }),
            );
            if (!sumRes.ok) return failRun(store, runId, sumRes.error, logger, notifier);
            costLedger.add({ ...sumRes.value.usage, cacheHit: sumRes.value.cacheHit });
            intent = sumRes.value.intent;
            // Apply per-run operator overrides on top of the AI output.
            // Operator Advanced Filters always win over AI inference.
            if (overrideFields && typeof overrideFields === 'object') {
                const kept = Object.fromEntries(
                    Object.entries(overrideFields).filter(
                        ([, v]) => v !== null && v !== undefined,
                    ),
                );
                if (Object.keys(kept).length) {
                    intent = { ...intent, ...kept };
                    logger?.info?.(
                        { overrideKeys: Object.keys(kept) },
                        'summarising: merged operator override fields',
                    );
                }
            }
        } else {
            logger?.info?.('summarising skipped — overrideIntent provided');
        }
        store.update(runId, { progress: { intent } });
        if (checkAbort(store, runId, logger)) return;

        // ---- Load per-client feedback calibration (feedback loop) ----
        // Replays the last N thumbs-up/down events as few-shot examples so
        // AI learns the operator's taste per client. Same block is used
        // for every batch/page → cache key stays stable within a run.
        let calibrationBlock = '';
        if (feedback && typeof feedback.selectCalibration === 'function') {
            try {
                const groups = await feedback.selectCalibration(clientEmail);
                calibrationBlock = buildCalibrationBlock(groups);
                const totalExamples =
                    groups.rejected.length + groups.rescued.length
                    + groups.confirmedPick.length + groups.confirmedSkip.length;
                if (totalExamples > 0) {
                    logger?.info?.(
                        {
                            rejected: groups.rejected.length,
                            rescued: groups.rescued.length,
                            confirmedPick: groups.confirmedPick.length,
                            confirmedSkip: groups.confirmedSkip.length,
                            promptBytes: calibrationBlock.length,
                        },
                        'feedback: calibration block injected into relevance prompt',
                    );
                }
            } catch (e) {
                logger?.warn?.({ err: e.message }, 'feedback: selectCalibration failed — proceeding without calibration');
            }
        }

        // ---- 5-9. PAGINATED JR search + filter + push loop ----------
        //
        // Operator asks for N jobs in the client's dashboard. JR may
        // return dupes the client already has, companies the dashboard
        // blocks, or jobs the AI rightly skips. To hit the requested N
        // we page through JR until:
        //   - we've pushed N fresh jobs, OR
        //   - we've exhausted JR (empty page), OR
        //   - we've scanned MAX_PAGES × PAGE_SIZE candidates, OR
        //   - abort was requested.
        //
        // Stats + picks accumulate across iterations; SSE keeps the UI
        // live throughout.

        const PAGE_SIZE = Math.max(requestedCount, 15);
        const MAX_PAGES = 8;                // up to 8 × PAGE_SIZE candidates scanned
        const MAX_AI_BATCHES = 6;           // cap AI spend: ~6 × 20-job batches

        const traceDir = env?.DEBUG_CAPTURE ? runArtDir : null;
        // resumeFrom may preload previously-seen JR ids so a retried run
        // doesn't re-fetch them from JR or re-spend AI cycles on them.
        const seenJrIds = new Set(resumeFrom?.seenJrIds || []);
        const allPicks = [];                // pushed jobs (operator UI)
        const allBlocked = [];              // duplicates + blocked + errored
        const allErrored = [];
        // Every AI decision this run made — { jobId, title, company, applyUrl,
        // pick, score, reason }. Used by the UI "Decisions" panel and by
        // the feedback-loop's few-shot bank later. Capped to last 200 entries
        // so state.json doesn't grow unbounded on long paginations.
        const allDecisions = [];
        const DECISIONS_CAP = 200;
        const agg = {
            searched: { totalReturned: 0, totalNormalized: 0, durationMs: 0, pages: 0, linkedInSkipped: 0 },
            filtered: { totalJobs: 0, picked: 0, skipped: 0, borderline: 0, batches: 0, cacheHits: 0, durationMs: 0 },
            enriched: { total: 0, ready: 0, sparse: 0, durationMs: 0 },
            preflight: { total: 0, pushable: 0, blockedCompany: 0, blockedLocation: 0, localDuplicate: 0 },
            pushed: { total: 0, pushed: 0, duplicates: 0, blocked: 0, errors: 0, durationMs: 0 },
        };

        // Outer "relaxation rounds" loop. Every inner pass is a full
        // pagination over JR with the current intent. If we exhaust below
        // target, we pause and ask the operator which filter to widen.
        const MAX_RELAXATION_ROUNDS = 5;
        const appliedRelaxations = Array.isArray(resumeFrom?.appliedRelaxations)
            ? [...resumeFrom.appliedRelaxations]
            : [];
        let relaxationRound = 0;
        let page = 0;
        let aiBatches = 0;
        let exhausted = false;
        let declinedOrTimedOut = false;

        // eslint-disable-next-line no-constant-condition — inner breaks gate the loop
        while (true) {
        while (
            allPicks.length < requestedCount
            && page < MAX_PAGES
            && aiBatches < MAX_AI_BATCHES
            && !exhausted
        ) {
            if (checkAbort(store, runId, logger)) return;

            // 5. JR page fetch
            store.update(runId, { phase: PHASES.SEARCHING });
            const searchRes = await phaseTimer(`searching.page${page}`, () =>
                runSearch({
                    browser, mutex, env, logger,
                    intent,
                    count: PAGE_SIZE,
                    position: page * PAGE_SIZE,
                    traceDir,
                }),
            );
            if (!searchRes.ok) {
                if (COOLDOWN_TRIGGER_CODES.has(searchRes.error.code)) {
                    const ms = Number(env?.JOBRIGHT_COOLDOWN_MS) || 900_000;
                    const expiresAt = new Date(Date.now() + ms).toISOString();
                    await setCooldown(env?.RUNS_DIR || './runs', {
                        ms,
                        reason: `${searchRes.error.code}: ${searchRes.error.message}`,
                        code: searchRes.error.code,
                    });
                    logger?.warn?.({ code: searchRes.error.code, cooldownMs: ms }, 'cooldown set');
                    // Fire-and-forget ops alert.
                    notifyCooldown({
                        notifier,
                        run: store.get(runId),
                        cooldown: {
                            code: searchRes.error.code,
                            reason: `${searchRes.error.code}: ${searchRes.error.message}`,
                            expiresAt,
                        },
                        logger,
                    }).catch(() => {});
                }
                // First-page failure kills the run; mid-pagination failure
                // stops the loop but keeps whatever we've pushed so far.
                if (page === 0) return failRun(store, runId, searchRes.error, logger, notifier);
                logger?.warn?.({ code: searchRes.error.code, page }, 'search page failed mid-loop; stopping');
                break;
            }

            // De-dupe vs previous pages (JR sometimes repeats).
            const dedupedJobs = searchRes.value.jobs.filter((j) => {
                if (!j?.id || seenJrIds.has(j.id)) return false;
                seenJrIds.add(j.id);
                return true;
            });

            // Skip LinkedIn-hosted apply URLs BEFORE they hit AI. The
            // dashboard tracker prefers direct career-site links and the
            // LinkedIn apply flow is unreliable — saves tokens + operator
            // noise to drop them at the boundary.
            const linkedInSkipped = [];
            const freshJobs = dedupedJobs.filter((j) => {
                if (isLinkedInApplyUrl(j?.applyUrl)) {
                    linkedInSkipped.push({
                        jobId: j?.id,
                        title: j?.title,
                        company: j?.companyName,
                    });
                    return false;
                }
                return true;
            });
            if (linkedInSkipped.length) {
                logger?.info?.(
                    { page, skipped: linkedInSkipped.length, remaining: freshJobs.length },
                    'linkedin jobs skipped before AI',
                );
            }
            agg.searched.totalReturned += searchRes.value.totalReturned;
            agg.searched.totalNormalized += freshJobs.length;
            agg.searched.durationMs += searchRes.value.durationMs;
            agg.searched.pages = page + 1;
            agg.searched.linkedInSkipped += linkedInSkipped.length;
            store.update(runId, { progress: { searched: agg.searched } });
            logger?.info?.(
                { page, jrReturned: searchRes.value.totalReturned, fresh: freshJobs.length, seenTotal: seenJrIds.size },
                'search page',
            );

            if (freshJobs.length === 0) {
                logger?.info?.({ page }, 'JR returned no new jobs — exhausted');
                exhausted = true;
                break;
            }

            if (checkAbort(store, runId, logger)) return;

            // 6. AI relevance filter
            store.update(runId, { phase: PHASES.FILTERING });
            const filterRes = await phaseTimer(`filtering.page${page}`, () =>
                filterJobsByRelevance({
                    ai,
                    intent,
                    jobs: freshJobs,
                    calibration: calibrationBlock,
                }),
            );
            if (!filterRes.ok) return failRun(store, runId, filterRes.error, logger, notifier);
            // Track AI spend per batch. One ledger entry per batch preserves
            // the cacheHits counter accuracy (cache-hit batches have zero
            // tokens but still count as one call).
            {
                const totalBatches = filterRes.value.stats.batches || 1;
                const cachedInBatch = filterRes.value.stats.cacheHits || 0;
                const liveBatches = Math.max(0, totalBatches - cachedInBatch);
                const u = filterRes.value.stats.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
                // Split the aggregated usage across the live batches so each
                // accounted call carries its proportional share. Cache-hit
                // batches get a zero-token entry with cacheHit=true.
                const perLive = liveBatches > 0
                    ? {
                          promptTokens: Math.round(u.promptTokens / liveBatches),
                          completionTokens: Math.round(u.completionTokens / liveBatches),
                      }
                    : { promptTokens: 0, completionTokens: 0 };
                for (let i = 0; i < liveBatches; i += 1) costLedger.add(perLive);
                for (let i = 0; i < cachedInBatch; i += 1) costLedger.add({ cacheHit: true });
            }
            aiBatches += filterRes.value.stats.batches;
            agg.filtered.totalJobs += filterRes.value.stats.totalJobs;
            agg.filtered.picked += filterRes.value.stats.picked;
            agg.filtered.skipped += filterRes.value.stats.skipped;
            agg.filtered.borderline += filterRes.value.stats.borderline;
            agg.filtered.batches += filterRes.value.stats.batches;
            agg.filtered.cacheHits += filterRes.value.stats.cacheHits;
            agg.filtered.durationMs += filterRes.value.stats.durationMs;

            // Capture every decision so the UI can render a "why picked /
            // why skipped" table. Latest entries win when capped.
            for (const s of filterRes.value.scored) {
                allDecisions.push({
                    jobId: s.job.id,
                    title: s.job.title,
                    company: s.job.companyName,
                    applyUrl: s.job.applyUrl,
                    pick: !!s.decision.pick,
                    score: Number.isInteger(s.decision.score) ? s.decision.score : 0,
                    reason: typeof s.decision.reason === 'string' ? s.decision.reason : '',
                });
            }
            if (allDecisions.length > DECISIONS_CAP) {
                allDecisions.splice(0, allDecisions.length - DECISIONS_CAP);
            }
            store.update(runId, {
                progress: {
                    filtered: agg.filtered,
                    decisions: allDecisions,
                    seenJrIds: [...seenJrIds],
                },
            });
            if (checkAbort(store, runId, logger)) return;

            // 7. completeness gate — forward picks + borderline
            store.update(runId, { phase: PHASES.ENRICHING });
            const pushCandidates = [...filterRes.value.picks, ...filterRes.value.borderline];
            const enrichRes = await phaseTimer(`enriching.page${page}`, () =>
                enrichJobs({ jobs: pushCandidates, logger }),
            );
            if (!enrichRes.ok) return failRun(store, runId, enrichRes.error, logger, notifier);
            agg.enriched.total += enrichRes.value.stats.total;
            agg.enriched.ready += enrichRes.value.stats.ready;
            agg.enriched.sparse += enrichRes.value.stats.sparse;
            agg.enriched.durationMs += enrichRes.value.stats.durationMs;
            store.update(runId, { progress: { enriched: agg.enriched } });
            if (checkAbort(store, runId, logger)) return;

            // 8. local preflight (exclusions + dup within run)
            store.update(runId, { phase: PHASES.PREFLIGHT });
            const preRes = await phaseTimer(`preflight.page${page}`, async () =>
                runPreflight({ jobs: enrichRes.value.ready, exclusions, logger }),
            );
            if (!preRes.ok) return failRun(store, runId, preRes.error, logger, notifier);
            agg.preflight.total += preRes.value.stats.total;
            agg.preflight.pushable += preRes.value.stats.pushable;
            agg.preflight.blockedCompany += preRes.value.stats.blockedCompany;
            agg.preflight.blockedLocation += preRes.value.stats.blockedLocation;
            agg.preflight.localDuplicate += preRes.value.stats.localDuplicate;
            store.update(runId, { progress: { preflight: agg.preflight } });
            if (checkAbort(store, runId, logger)) return;

            // 9. push (cap at the remaining quota so we don't over-shoot)
            const remaining = requestedCount - allPicks.length;
            const toPush = preRes.value.pushable.slice(0, Math.max(remaining, 0));
            if (toPush.length === 0) {
                logger?.info?.({ page }, 'no pushable jobs on this page; continuing');
                page += 1;
                continue;
            }

            store.update(runId, { phase: PHASES.PUSHING });
            const pushRes = await phaseTimer(`pushing.page${page}`, () =>
                runPush({ dashboard, clientEmail, clientName, jobs: toPush, logger }),
            );
            if (!pushRes.ok) return failRun(store, runId, pushRes.error, logger, notifier);
            agg.pushed.total += pushRes.value.stats.total;
            agg.pushed.pushed += pushRes.value.stats.pushed;
            agg.pushed.duplicates += pushRes.value.stats.duplicates;
            agg.pushed.blocked += pushRes.value.stats.blocked;
            agg.pushed.errors += pushRes.value.stats.errors;
            agg.pushed.durationMs += pushRes.value.stats.durationMs;
            store.update(runId, { progress: { pushed: agg.pushed } });

            for (const p of pushRes.value.pushed) {
                allPicks.push({
                    jobId: p.job.id,
                    title: p.job.title,
                    company: p.job.companyName,
                    applyUrl: p.job.applyUrl,
                    createdJobId: p.createdJobId,
                    outcome: 'pushed',
                });
            }
            for (const d of pushRes.value.duplicates) {
                allBlocked.push({
                    jobId: d.job.id, title: d.job.title, company: d.job.companyName,
                    outcome: 'duplicate', reason: d.reason,
                });
            }
            for (const b of pushRes.value.blocked) {
                allBlocked.push({
                    jobId: b.job.id, title: b.job.title, company: b.job.companyName,
                    outcome: 'blocked', code: b.code, reason: b.reason,
                });
            }
            for (const e of pushRes.value.errors) {
                allErrored.push({
                    jobId: e.job.id, title: e.job.title,
                    outcome: 'error', code: e.code, reason: e.reason,
                });
            }

            logger?.info?.(
                {
                    page,
                    pushedThisPage: pushRes.value.stats.pushed,
                    totalPushed: allPicks.length,
                    target: requestedCount,
                },
                'page complete',
            );
            page += 1;
        }

        // ---- Relaxation gate -----------------------------------------
        // Inner pagination pass just ended. Decide what to do next:
        //  A. hit target → break outer loop and finalise
        //  B. abort requested → break (checkAbort inside handles phase)
        //  C. hit pagination caps / exhausted with picks < target →
        //     compute relaxation plan, ask operator
        if (allPicks.length >= requestedCount) break;
        if (checkAbort(store, runId, logger)) return;
        if (relaxationRound >= MAX_RELAXATION_ROUNDS) {
            logger?.info?.(
                { appliedRelaxations: appliedRelaxations.length },
                'relaxation round cap reached — stopping',
            );
            break;
        }

        const plans = computeRelaxationPlan({ intent });
        if (plans.length === 0) {
            logger?.info?.('no further filters can be relaxed — stopping');
            break;
        }

        store.update(runId, {
            phase: PHASES.AWAITING_RELAXATION,
            pendingRelaxation: {
                round: relaxationRound + 1,
                achieved: allPicks.length,
                target: requestedCount,
                plans: serialisePlan(plans),
                appliedRelaxations,
                createdAt: new Date().toISOString(),
                decision: null,
            },
        });
        logger?.info?.(
            { achieved: allPicks.length, target: requestedCount, options: plans.length },
            'awaiting-relaxation: operator input required',
        );

        const decision = await waitForRelaxationDecision(store, runId);
        if (decision.action === 'abort') {
            logger?.info?.('relaxation aborted — stopping');
            return; // checkAbort flow flips phase to aborted next loop tick
        }
        if (decision.action !== 'accept') {
            logger?.info?.({ action: decision.action }, 'relaxation declined/timeout — stopping');
            declinedOrTimedOut = true;
            break;
        }

        // Accept — apply the chosen plan entry and start another inner pass.
        const chosenIdx = Number.isInteger(decision.planIndex) ? decision.planIndex : 0;
        const chosenPlan = plans[chosenIdx] || plans[0];
        const nextIntent = applyRelaxation(intent, chosenPlan);
        appliedRelaxations.push({
            round: relaxationRound + 1,
            field: chosenPlan.field,
            label: chosenPlan.label,
            from: chosenPlan.from,
            to: chosenPlan.to,
            acceptedAt: new Date().toISOString(),
        });
        intent = nextIntent;
        relaxationRound += 1;
        // Reset pagination counters for the new pass with the widened filter.
        page = 0;
        aiBatches = 0;
        exhausted = false;
        store.update(runId, {
            progress: { intent, appliedRelaxations },
            pendingRelaxation: null,
        });
        logger?.info?.(
            { round: relaxationRound, field: chosenPlan.field, from: chosenPlan.from, to: chosenPlan.to },
            'relaxation accepted — starting new pagination pass',
        );
        // Continue outer loop → inner pagination runs again with new intent.
        }
        // ---- end of outer relaxation loop ---------------------------

        // ---- finalise -----------------------------------------------
        const picks = allPicks;
        const blocked = allBlocked;
        const errored = allErrored;

        const costSnapshot = costLedger.totals();

        await writeArtifact(runArtDir, 'picks.json', {
            picks,
            blocked,
            errored,
            decisions: allDecisions,
            seenJrIds: [...seenJrIds],
            resumedFrom: resumeFrom?.prevRunId || null,
            intent,
            appliedRelaxations,
            declinedOrTimedOut,
            cost: costSnapshot,
            pagination: {
                pagesScanned: page,
                jrJobsSeen: seenJrIds.size,
                target: requestedCount,
                achieved: picks.length,
                exhausted,
                hitPageCap: page >= MAX_PAGES,
                hitAiBatchCap: aiBatches >= MAX_AI_BATCHES,
                relaxationRounds: relaxationRound,
            },
        });

        store.update(runId, {
            phase: PHASES.DONE,
            picks,
            progress: { pushed: agg.pushed, cost: costSnapshot },
        });

        // --- Ops alert: DONE (or no-jobs variant) ---------------------
        // Fire-and-forget. Uses the latest run state so picks/progress
        // reflect the final phase transition.
        {
            const finalRun = store.get(runId);
            const pushedCount = finalRun?.progress?.pushed?.pushed ?? 0;
            const scanned = finalRun?.progress?.searched?.totalNormalized ?? 0;
            if (pushedCount === 0 && scanned === 0) {
                // JR returned nothing for this filter — dedicated alert.
                notifyNoJobs({
                    notifier,
                    run: finalRun,
                    culprits: computeCulprits(finalRun?.progress?.intent),
                    logger,
                }).catch(() => {});
            } else {
                notifyRunDone({ notifier, run: finalRun, logger }).catch(() => {});
            }
        }

        logger?.info?.(
            {
                picks: picks.length,
                target: requestedCount,
                blocked: blocked.length,
                errors: errored.length,
                pages: page,
                exhausted,
            },
            'run: done',
        );

        // Persist the last-used intent + overrides for this client so the
        // next operator-initiated run can skip summariser + pre-populate
        // the Advanced Filters UI. Best-effort — silent if it fails.
        if (clientFilters && typeof clientFilters.put === 'function') {
            await clientFilters.put(clientEmail, {
                intent,
                overrides: overrideFields || null,
                meta: { lastRunId: runId, source: overrideIntent ? 'override-intent' : 'ai' },
            });
        }
        await writeSummaryArtifact(runArtDir, {
            id: runId,
            phase: 'done',
            clientEmail,
            clientName,
            requestedCount,
            picksCount: picks.length,
            stats: agg.pushed,
            cost: costSnapshot,
            intent,
            completedAt: new Date().toISOString(),
        });
    } catch (e) {
        rootLogger?.error?.({ runId, err: e.message }, 'pipeline crashed');
        logger?.fatal?.({ err: e.message, stack: e.stack }, 'pipeline crashed');
        failRun(store, runId, { code: 'UNEXPECTED', message: e.message }, logger, notifier);
    } finally {
        // Persist the final state snapshot for failed runs before we close
        // the logger, so the file stream flushes whatever we logged.
        const finalState = store.get(runId);
        if (finalState && finalState.phase === PHASES.FAILED) {
            await writeErrorArtifact(runArtDir, finalState);
        }
        await closeRunLogger();
    }
}
