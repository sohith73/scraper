// runSearch — the big one.
//
// Given a SearchIntent and a count N, returns N (or fewer) canonical `Job`
// records from JobRight that match the intent's filters. Does NOT yet push
// to the dashboard — that's Phase 12.
//
// Flow (all inside the shared mutex so the one JR account is serialised):
//   1. open a page on JR's origin
//   2. probe session — abort as NEEDS_REAUTH if logged out
//   3. POST /swan/filter/update/filter   (mutates server-side filter)
//   4. GET  /swan/recommend/list/jobs?count=N  (triggers re-rank + returns)
//   5. normalise every raw entry via adapters/jobright.js
//
// Notes:
//   - Phase 0 recon established that N=50 works in one call. The caller
//     decides N; we don't split into pages.
//   - Abort policy: 429 / 403 / login-redirect return typed errors so
//     Phase 13 can show a clean banner.

import { ok, err } from '../../clients/common/result.js';
import { pageFetch } from '../../playwright/pageFetch.js';
import { normalizeJobRightJob } from '../../adapters/jobright.js';
import { searchIntentToJRFilter } from './filterMapper.js';
import { validateJRFilter } from './filterSchema.js';
import { fetchCatalog, resolveRoles } from './taxonomyCatalog.js';

const MIN_COUNT = 1;
const MAX_COUNT = 100;       // JR tolerates ≥50 in recon; 100 is a safety cap
const LIST_URL_PATH = '/swan/recommend/list/jobs';
const FILTER_GET_PATH = '/swan/filter/get/filter';
const FILTER_UPDATE_PATH = '/swan/filter/update/filter';
const AUTH_PROBE_PATH = '/swan/auth/newinfo';

// probeLoggedInOnPage: cheap in-page login check. Duplicated on purpose —
// we're already inside the session mutex so we can't call session.probeSession().
async function probeLoggedInOnPage(page, base) {
    const r = await pageFetch(page, { url: `${base}${AUTH_PROBE_PATH}` });
    if (r.status !== 200) return { loggedIn: false, status: r.status };
    const res = r.body?.result;
    const loggedIn =
        r.body?.success === true &&
        res !== null &&
        res !== undefined &&
        (res.logined === true ||
            (typeof res.userId === 'string' && res.userId.length > 0));
    return { loggedIn, status: r.status, userInfo: loggedIn ? res : null };
}

// classifyListError: map JR error envelopes into our stable codes.
function classifyListError(status, body) {
    if (status === 401) return 'NEEDS_REAUTH';
    if (status === 403) return 'BLOCKED_BY_JOBRIGHT';
    if (status === 429) return 'RATE_LIMITED';
    if (status >= 500) return 'UPSTREAM_5XX';
    if (status === 0) return 'NETWORK';
    if (body && body.success === false) return 'UPSTREAM_REJECTED';
    return 'BAD_STATUS';
}

// runSearch: the orchestrator. Injected dependencies make it test-friendly.
//
// input  :
//   { browser, mutex, env, logger,
//     intent: SearchIntent,
//     count:  positive integer,
//     existingFilter?: optional pre-fetched filter to merge into }
// output :
//   Result<{ jobs: Job[], totalReturned: number, filter: JRFilter,
//            listUrl: string, probe: {...}, durationMs: number }>
//
// Error codes used:
//   BAD_INPUT | NEEDS_REAUTH | BLOCKED_BY_JOBRIGHT | RATE_LIMITED |
//   UPSTREAM_5XX | UPSTREAM_REJECTED | NETWORK | BAD_STATUS |
//   FILTER_UPDATE_FAILED | LIST_EMPTY_SHAPE | CONTEXT_CRASHED
export async function runSearch({
    browser,
    mutex,
    env,
    logger,
    intent,
    count,
    position = 0,
    existingFilter = null,
    traceDir = null,
    // mode='client' means the browser handle is logged in AS the end-client
    // (not the shared Sohith account). In this mode we DO NOT mutate JR's
    // server-side filter — the client has set their own preferences in their
    // JR profile and JR's recommender already personalises against THEIR
    // resume. We just probe + read the saved filter + fetch the list.
    mode = 'shared',
} = {}) {
    // --- input validation (outside the mutex — fail fast) ---------------
    if (!browser || typeof browser.withContext !== 'function') {
        return err('BAD_INPUT', 'browser handle is required');
    }
    if (!mutex || typeof mutex.run !== 'function') {
        return err('BAD_INPUT', 'mutex is required');
    }
    if (!env?.JOBRIGHT_BASE) {
        return err('BAD_INPUT', 'env.JOBRIGHT_BASE is required');
    }
    if (!intent || typeof intent !== 'object') {
        return err('BAD_INPUT', 'intent is required');
    }
    if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
        return err(
            'BAD_INPUT',
            `count must be an integer in [${MIN_COUNT}, ${MAX_COUNT}]`,
        );
    }

    const base = env.JOBRIGHT_BASE.replace(/\/+$/, '');
    const startedAt = Date.now();

    return mutex.run(async () => {
        return browser.withContext({ headless: true }, async (ctx) => {
            let page;
            try {
                page = await ctx.newPage();
            } catch (e) {
                return err('CONTEXT_CRASHED', e.message, { cause: e });
            }

            // Optional trace capture — only engage if the caller asked for
            // it. We discard on success (zero cost) and save on failure
            // below, so operators can open trace.zip in Playwright's viewer
            // to see exactly what happened.
            let tracingStarted = false;
            if (traceDir && ctx.tracing?.start) {
                try {
                    await ctx.tracing.start({
                        screenshots: true,
                        snapshots: true,
                        sources: false,
                    });
                    tracingStarted = true;
                } catch (traceErr) {
                    logger?.warn?.({ err: traceErr.message }, 'tracing.start failed');
                }
            }

            // saveOrDiscardTrace: tiny helper used once per exit path.
            const saveOrDiscardTrace = async (failed) => {
                if (!tracingStarted) return;
                try {
                    if (failed) {
                        const { mkdir } = await import('node:fs/promises');
                        const { join } = await import('node:path');
                        await mkdir(traceDir, { recursive: true });
                        await ctx.tracing.stop({ path: join(traceDir, 'trace.zip') });
                    } else {
                        await ctx.tracing.stop();
                    }
                } catch (stopErr) {
                    logger?.warn?.({ err: stopErr.message }, 'tracing.stop failed');
                }
            };

            // Wrap the whole body so we can capture trace ONCE in a single
            // finally block, distinguishing success vs. error exit via the
            // returned Result shape.
            let outcome;
            try {
                // 1. On-origin so cookies travel
                await page.goto(`${base}/jobs/recommend`, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30_000,
                });

                // 2. Session probe
                const probe = await probeLoggedInOnPage(page, base);
                if (!probe.loggedIn) {
                    return err('NEEDS_REAUTH', 'not logged in; POST /api/admin/login first');
                }

                // ---- CLIENT mode short-circuit ----
                // We are logged in AS the end-client. Skip filter mutation —
                // their saved JR filter is already personalised by the
                // client themselves. Pull current filter for the return
                // shape, then go straight to list fetch.
                if (mode === 'client') {
                    let savedFilter = null;
                    try {
                        const cur = await pageFetch(page, {
                            url: `${base}${FILTER_GET_PATH}`,
                            method: 'POST',
                            body: {},
                        });
                        if (cur.status === 200 && cur.body?.result) {
                            savedFilter = cur.body.result;
                        }
                    } catch (e) {
                        logger?.warn?.({ err: e.message }, 'runSearch.client: filter/get failed — continuing without it');
                    }
                    const listUrl = `${base}${LIST_URL_PATH}?refresh=${position === 0}&sortCondition=0&position=${position}&count=${count}&syncRerank=false`;
                    const list = await pageFetch(page, { url: listUrl });
                    if (list.status !== 200 || list.body?.success !== true) {
                        logger?.error?.(
                            { status: list.status, jrResponseBody: list.body, listUrl, position, count },
                            'runSearch.client: list fetch failed',
                        );
                        return err(classifyListError(list.status, list.body), 'list fetch failed', {
                            status: list.status, bodyJson: list.body,
                        });
                    }
                    const rawList = list.body?.result?.jobList;
                    if (!Array.isArray(rawList)) {
                        return err('LIST_EMPTY_SHAPE', 'list response missing result.jobList', {
                            bodyJson: list.body,
                        });
                    }
                    const jobs = rawList.map(normalizeJobRightJob).filter(Boolean);
                    outcome = ok({
                        jobs,
                        totalReturned: rawList.length,
                        totalNormalized: jobs.length,
                        filter: savedFilter,
                        listUrl,
                        probe,
                        durationMs: Date.now() - startedAt,
                        mode: 'client',
                    });
                    return outcome;
                }

                // 3. Optionally fetch current server-side filter so we only
                //    override the fields our intent controls.
                let merged = existingFilter;
                if (!merged) {
                    const cur = await pageFetch(page, {
                        url: `${base}${FILTER_GET_PATH}`,
                        method: 'POST',
                        body: {},
                    });
                    if (cur.status === 200 && cur.body?.result) {
                        merged = cur.body.result;
                    }
                }

                // 3b. Resolve our intent.roles to JR taxonomy entries.
                // JR rejects empty taxonomyList AND uses it as the primary
                // role signal — so we MUST map our free-text roles to the
                // canonical taxonomy IDs. If resolution fails, fall back to
                // whatever the existing filter had (best-effort).
                const catalog = await fetchCatalog({ page, env });
                // Combine primary + adjacent roles for taxonomy resolution.
                // Past-24-h-only filter (hardcoded) often returns very few
                // hits when the candidate has narrow primary roles. Adding
                // AI-suggested adjacent disciplines (`intent.relatedRoles`)
                // widens JR's candidate pool while the relevance phase
                // still scores against `intent.roles` as the primary fit.
                const primary = Array.isArray(intent?.roles) ? intent.roles : [];
                const related = Array.isArray(intent?.relatedRoles) ? intent.relatedRoles : [];
                const combinedRoles = [...new Set([...primary, ...related].map((s) => String(s).trim()).filter(Boolean))];
                const { resolved, unresolved } = resolveRoles({
                    catalog,
                    roles: combinedRoles,
                });
                if (unresolved.length) {
                    logger?.warn?.(
                        { unresolved },
                        'runSearch: some intent roles did not resolve to JR taxonomy IDs',
                    );
                }
                logger?.info?.(
                    {
                        primaryRoles: primary,
                        relatedRoles: related,
                        resolvedCount: resolved.length,
                    },
                    'runSearch: taxonomy resolution (primary + related)',
                );
                const taxonomyList = resolved.length
                    ? resolved
                    : (Array.isArray(merged?.jobTaxonomyList) && merged.jobTaxonomyList.length
                        ? merged.jobTaxonomyList
                        : []);

                const filterPayload = searchIntentToJRFilter({
                    intent,
                    existing: merged,
                    resolvedTaxonomyList: taxonomyList,
                });

                // Schema gate: catch type mismatches BEFORE JR's Java
                // backend rejects the deserialisation. Failing here gives
                // us a precise field path + expected/received types
                // instead of an opaque 400 with a Jackson stack trace.
                const validation = validateJRFilter(filterPayload);
                if (!validation.ok) {
                    logger?.error?.(
                        { issues: validation.issues, filterPayload },
                        'runSearch: filter payload failed JR_FILTER_SCHEMA',
                    );
                    return err(
                        'FILTER_SCHEMA_INVALID',
                        `filter payload type mismatch: ${validation.issues
                            .map((i) => `${i.path}=${i.expected || i.message}`)
                            .join('; ')}`,
                        { issues: validation.issues },
                    );
                }
                logger?.info?.(
                    {
                        filter: summariseFilter(filterPayload),
                        resolvedRoles: resolved.length,
                        unresolvedRoles: unresolved,
                        inputRoles: intent?.roles || [],
                    },
                    'runSearch: filter computed',
                );

                // 4. Push the filter
                const upd = await pageFetch(page, {
                    url: `${base}${FILTER_UPDATE_PATH}`,
                    method: 'POST',
                    body: filterPayload,
                });
                if (upd.status !== 200 || upd.body?.success !== true) {
                    // Log the full payload + JR's response so prod failures
                    // are diagnosable from /api/runs/:id/log without a
                    // re-run. JR's 400 body has the actual rejection reason
                    // (e.g. "city not recognised", "jobTitle invalid char").
                    logger?.error?.(
                        {
                            status: upd.status,
                            jrResponseBody: upd.body,
                            filterPayload,
                        },
                        'runSearch: JR rejected filter update',
                    );

                    // Auto-fallback: most 400s we've seen in prod are city
                    // names JR's geocoder doesn't recognise (bare "Durham"
                    // etc.). Retry once with the country-wide "Within US"
                    // pseudo-city so the operator gets results instead of
                    // a hard fail. AI-relevance phase still filters the
                    // jobs by intent.locations narrative-side.
                    const hasNonFallbackCity =
                        Array.isArray(filterPayload?.locations) &&
                        filterPayload.locations.some(
                            (l) => l?.city && l.city !== 'Within US',
                        );
                    if (upd.status === 400 && hasNonFallbackCity) {
                        const retryPayload = {
                            ...filterPayload,
                            locations: [{ city: 'Within US', radiusRange: 25 }],
                        };
                        logger?.warn?.(
                            { originalLocations: filterPayload.locations },
                            'runSearch: retrying filter-update with Within-US fallback',
                        );
                        const retry = await pageFetch(page, {
                            url: `${base}${FILTER_UPDATE_PATH}`,
                            method: 'POST',
                            body: retryPayload,
                        });
                        if (retry.status === 200 && retry.body?.success === true) {
                            // Mutate so subsequent list-fetch + return value
                            // reflect the payload that JR actually accepted.
                            filterPayload.locations = retryPayload.locations;
                            logger?.info?.('runSearch: fallback accepted; continuing with Within-US');
                        } else {
                            logger?.error?.(
                                { retryStatus: retry.status, retryBody: retry.body },
                                'runSearch: Within-US fallback also rejected',
                            );
                            return err('FILTER_UPDATE_FAILED', `filter-update status=${upd.status}`, {
                                status: upd.status,
                                bodyJson: upd.body,
                            });
                        }
                    } else {
                        return err('FILTER_UPDATE_FAILED', `filter-update status=${upd.status}`, {
                            status: upd.status,
                            bodyJson: upd.body,
                        });
                    }
                }

                // 5. Fetch jobs list. Pagination: caller passes `position`
                // (default 0); we feed it straight to JR. Subsequent calls
                // should pass position=count*iter to walk forward.
                const listUrl = `${base}${LIST_URL_PATH}?refresh=${position === 0}&sortCondition=0&position=${position}&count=${count}&syncRerank=false`;
                let list = await pageFetch(page, { url: listUrl });
                let activeListUrl = listUrl;
                if (list.status !== 200 || list.body?.success !== true) {
                    logger?.warn?.(
                        {
                            status: list.status,
                            jrResponseBody: list.body,
                            listUrl,
                            position,
                            count,
                        },
                        'runSearch: JR rejected list fetch — trying smaller count',
                    );
                    // Retry once with count=10. JR's recommend/list/jobs
                    // sometimes rejects requests with count>25 + non-zero
                    // position by returning success:false. count=10 is
                    // verified safe across prod runs.
                    if (count > 10) {
                        const retryUrl = `${base}${LIST_URL_PATH}?refresh=${position === 0}&sortCondition=0&position=${position}&count=10&syncRerank=false`;
                        const retry = await pageFetch(page, { url: retryUrl });
                        if (retry.status === 200 && retry.body?.success === true) {
                            logger?.info?.({ position, count: 10 }, 'runSearch: list-fetch retry with count=10 succeeded');
                            list = retry;
                            activeListUrl = retryUrl;
                        }
                    }
                }
                if (list.status !== 200 || list.body?.success !== true) {
                    logger?.error?.(
                        {
                            status: list.status,
                            jrResponseBody: list.body,
                            listUrl: activeListUrl,
                            position,
                            count,
                        },
                        'runSearch: JR rejected list fetch (retry exhausted)',
                    );
                    return err(classifyListError(list.status, list.body), 'list fetch failed', {
                        status: list.status,
                        bodyJson: list.body,
                    });
                }

                const rawList = list.body?.result?.jobList;
                if (!Array.isArray(rawList)) {
                    return err('LIST_EMPTY_SHAPE', 'list response missing result.jobList', {
                        bodyJson: list.body,
                    });
                }

                const jobs = rawList.map(normalizeJobRightJob).filter(Boolean);

                if (rawList.length === 0) {
                    logger?.warn?.(
                        {
                            filter: summariseFilter(filterPayload),
                            resolvedRoles: resolved.length,
                            unresolvedRoles: unresolved,
                            position,
                            count,
                        },
                        'runSearch: JR returned empty jobList — filter may be too narrow or taxonomy did not resolve',
                    );
                }

                outcome = ok({
                    jobs,
                    totalReturned: rawList.length,
                    totalNormalized: jobs.length,
                    filter: filterPayload,
                    listUrl,
                    probe,
                    durationMs: Date.now() - startedAt,
                });
                return outcome;
            } catch (e) {
                outcome = err('CONTEXT_CRASHED', e.message, { cause: e });
                return outcome;
            } finally {
                // Save trace.zip only when the run did not succeed.
                await saveOrDiscardTrace(!outcome || outcome.ok !== true);
                try {
                    await page.close();
                } catch {
                    /* ignore */
                }
            }
        });
    });
}

// summariseFilter: a one-liner of the JR filter for logs. Avoids leaking
// the full payload (which can contain long exclusion lists).
function summariseFilter(f) {
    return {
        jobTitle: f.jobTitle,
        seniority: f.seniority,
        workModel: f.workModel,
        isH1BOnly: f.isH1BOnly,
        companiesCount: f.companies?.length ?? 0,
        excludedCompaniesCount: f.excludedCompanies?.length ?? 0,
        locations: f.locations,
    };
}
