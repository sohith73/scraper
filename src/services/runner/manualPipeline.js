// Manual-capture pipeline.
//
// Why : the browser extension lets an operator scroll JR /jobs/recommend in
//       their own logged-in tab and capture every /swan/recommend/list/jobs
//       response. The captured raw payloads land here as a single batch.
//       We skip the AI summariser + the JR-search phase entirely, normalise
//       the captured payloads, and feed the rest of the existing pipeline
//       (relevance → completeness → preflight → push).
//
// State machine reuses PHASES.* so the scraper UI's run console renders
// manual runs identically to scheduled ones — just with empty searched/
// summarising slices.
//
// input  : { store, runId, container, capturedJobs }
// output : Promise<void>; observable state flows through `store`

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PHASES } from './state.js';
import { normalizeJobRightJob, isLinkedInApplyUrl } from '../../adapters/jobright.js';
import { filterJobsByRelevance } from '../relevance/index.js';
import { enrichJobs } from '../detail/index.js';
import { runPreflight, runPush } from '../push/index.js';
import {
    createRunLogger,
    writeErrorArtifact,
    writeSummaryArtifact,
} from './runLogger.js';

// fail: terminal failure transition.
function fail(store, runId, error, logger) {
    logger?.error?.(
        { code: error?.code, message: error?.message },
        'manual run failing',
    );
    store.update(runId, {
        phase: PHASES.FAILED,
        error: {
            code: error?.code || 'UNEXPECTED',
            message: error?.message || String(error),
        },
    });
}

// writeArtifact: best-effort side file.
async function writeArtifact(dir, name, value) {
    try {
        await writeFile(join(dir, name), JSON.stringify(value, null, 2), 'utf8');
    } catch {
        /* ignore */
    }
}

// buildStubIntent: mirror of pipeline.js buildClientModeStubIntent.
// Kept inline so this module has zero pipeline.js coupling.
function buildStubIntent({ profile = {}, exclusions = null, clientName = '' } = {}) {
    const splitCsv = (v) => {
        if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
        if (typeof v !== 'string') return [];
        return v.split(/\s*[/|,]\s*|\s{2,}/).map((s) => s.trim()).filter(Boolean);
    };
    const dedupe = (xs) => [...new Set(xs.map((s) => s.trim()).filter(Boolean))];
    const roles = dedupe(splitCsv(profile.preferredRoles)).slice(0, 8);
    const locations = dedupe(splitCsv(profile.preferredLocations)).slice(0, 10);
    const companies = dedupe(splitCsv(profile.targetCompanies)).slice(0, 30);
    const exp = String(profile.experienceLevel || '').toLowerCase();
    const seniority = exp.includes('intern') ? 'intern'
        : exp.includes('0-2') || exp.includes('0–2') || exp.includes('entry') ? 'entry'
        : exp.includes('2-4') || exp.includes('2–4') || exp.includes('mid') ? 'mid'
        : exp.includes('5-7') || exp.includes('5–7') || exp.includes('senior') ? 'senior'
        : exp.includes('7-10') || exp.includes('lead') ? 'lead'
        : exp.includes('10+') || exp.includes('exec') || exp.includes('director') ? 'exec'
        : 'mid';
    const workAuth = String(profile.usWorkEligibility || profile.visaStatus || '').trim() || 'unspecified';
    const name = clientName || [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() || 'candidate';
    const aboutCandidate = [
        `${name} is a ${seniority}-level candidate looking at ${roles.slice(0, 3).join(' / ') || 'roles in their saved JR profile'}.`,
        locations.length ? `Open to ${locations.slice(0, 5).join(', ')}.` : '',
        workAuth !== 'unspecified' ? `Work authorisation: ${workAuth}.` : '',
    ].filter(Boolean).join(' ').slice(0, 1500);
    return {
        roles: roles.length ? roles : ['Software Engineer'],
        relatedRoles: null,
        locations,
        seniority,
        companies,
        workAuth,
        narrative: '',
        futurePreferences: '',
        aboutCandidate,
        exclusions: exclusions || { companies: [], locations: [] },
        country: 'US',
    };
}

// runManualPipeline: drives a manual-capture run from queued → terminal.
export async function runManualPipeline({
    store,
    runId,
    container,
    capturedJobs = [],
} = {}) {
    const run = store.get(runId);
    if (!run) return;
    const { clientEmail, clientName } = run;
    const { dashboard, resume, ai, logger: rootLogger } = container || {};
    const runArtDir = store.runDir(runId);

    let runLogger = rootLogger;
    let closeRunLogger = async () => {};
    try {
        const made = await createRunLogger({ runDir: runArtDir, runId, rootLogger });
        runLogger = made.logger;
        closeRunLogger = made.closeStream;
    } catch (e) {
        rootLogger?.warn?.({ err: e.message }, 'manualPipeline: runLogger init failed');
    }
    const logger = runLogger;

    try {
        logger?.info?.(
            { clientEmail, captured: Array.isArray(capturedJobs) ? capturedJobs.length : 0 },
            'manual run: starting',
        );

        if (!Array.isArray(capturedJobs) || capturedJobs.length === 0) {
            return fail(
                store, runId,
                { code: 'BAD_INPUT', message: 'capturedJobs (non-empty array) required' },
                logger,
            );
        }

        // ---- 1. profile -------------------------------------------------
        store.update(runId, { phase: PHASES.LOADING_PROFILE });
        const profileRes = await dashboard.getProfile(clientEmail);
        if (!profileRes.ok) return fail(store, runId, profileRes.error, logger);

        // ---- 2. exclusions (best-effort) --------------------------------
        store.update(runId, { phase: PHASES.LOADING_EXCLUSIONS });
        const exclRes = await dashboard.getExclusions(clientEmail);
        const exclusions = exclRes.ok
            ? {
                  companies: exclRes.value.excludedCompanies,
                  locations: exclRes.value.excludedLocations,
              }
            : { companies: [], locations: [] };

        // ---- 3. resume (optional, for prompt context only) --------------
        store.update(runId, { phase: PHASES.LOADING_RESUME });
        try { await resume.getByEmail(clientEmail); } catch { /* ignore */ }

        // ---- 4. stub intent (no AI summariser) -------------------------
        const intent = buildStubIntent({
            profile: profileRes.value.profile,
            exclusions,
            clientName,
        });
        store.update(runId, {
            progress: { intent, mode: 'manual' },
            phase: PHASES.SUMMARISING,
        });
        logger?.info?.({ roles: intent.roles, seniority: intent.seniority }, 'manual: stub intent built');

        // ---- 5. normalise captured raw JR payloads ---------------------
        store.update(runId, { phase: PHASES.SEARCHING });
        const t0 = Date.now();
        const normalised = capturedJobs
            .map((c) => {
                try { return normalizeJobRightJob(c); }
                catch { return null; }
            })
            .filter(Boolean);

        // dedupe by JR jobId
        const seen = new Set();
        const deduped = [];
        for (const j of normalised) {
            if (!j.id || seen.has(j.id)) continue;
            seen.add(j.id);
            deduped.push(j);
        }
        // strip LinkedIn-hosted apply URLs (operator pushes prefer direct links)
        const linkedInSkipped = [];
        const jobs = deduped.filter((j) => {
            if (isLinkedInApplyUrl(j.applyUrl)) {
                linkedInSkipped.push({ jobId: j.id, title: j.title });
                return false;
            }
            return true;
        });
        store.update(runId, {
            progress: {
                searched: {
                    totalReturned: capturedJobs.length,
                    totalNormalized: jobs.length,
                    durationMs: Date.now() - t0,
                    pages: 1,
                    linkedInSkipped: linkedInSkipped.length,
                },
            },
        });
        logger?.info?.(
            {
                raw: capturedJobs.length,
                normalised: normalised.length,
                deduped: deduped.length,
                kept: jobs.length,
                linkedInSkipped: linkedInSkipped.length,
            },
            'manual: captured jobs normalised',
        );

        if (jobs.length === 0) {
            store.update(runId, {
                phase: PHASES.DONE,
                picks: [],
            });
            await writeSummaryArtifact(runArtDir, {
                id: runId, phase: 'done', clientEmail, clientName,
                requestedCount: capturedJobs.length, picksCount: 0,
                stats: { pushed: 0, duplicates: 0, blocked: 0, errors: 0 },
                mode: 'manual', completedAt: new Date().toISOString(),
            });
            return;
        }

        // ---- 6. AI relevance filter ------------------------------------
        store.update(runId, { phase: PHASES.FILTERING });
        const filterRes = await filterJobsByRelevance({
            ai, intent, jobs, batchSize: 7,
        });
        if (!filterRes.ok) return fail(store, runId, filterRes.error, logger);

        const decisions = filterRes.value.scored.map((s) => ({
            jobId: s.job.id,
            title: s.job.title,
            company: s.job.companyName,
            applyUrl: s.job.applyUrl,
            pick: !!s.decision.pick,
            score: Number.isInteger(s.decision.score) ? s.decision.score : 0,
            reason: typeof s.decision.reason === 'string' ? s.decision.reason : '',
        }));
        store.update(runId, {
            progress: { filtered: filterRes.value.stats, decisions },
        });

        // ---- 7. enrich (completeness gate) -----------------------------
        store.update(runId, { phase: PHASES.ENRICHING });
        const candidates = [...filterRes.value.picks, ...filterRes.value.borderline];
        const enrichRes = await enrichJobs({ jobs: candidates, logger });
        if (!enrichRes.ok) return fail(store, runId, enrichRes.error, logger);
        store.update(runId, { progress: { enriched: enrichRes.value.stats } });

        // ---- 8. preflight (exclusions + within-run dedup) --------------
        store.update(runId, { phase: PHASES.PREFLIGHT });
        const preRes = await runPreflight({
            jobs: enrichRes.value.ready, exclusions, logger,
        });
        if (!preRes.ok) return fail(store, runId, preRes.error, logger);
        store.update(runId, { progress: { preflight: preRes.value.stats } });

        // ---- 9. push ---------------------------------------------------
        store.update(runId, { phase: PHASES.PUSHING });
        const pushRes = await runPush({
            dashboard, clientEmail, clientName,
            jobs: preRes.value.pushable, logger,
        });
        if (!pushRes.ok) return fail(store, runId, pushRes.error, logger);

        const picks = pushRes.value.pushed.map((p) => ({
            jobId: p.job.id,
            title: p.job.title,
            company: p.job.companyName,
            applyUrl: p.job.applyUrl,
            createdJobId: p.createdJobId,
            outcome: 'pushed',
        }));
        const blocked = [];
        for (const d of pushRes.value.duplicates) {
            blocked.push({
                jobId: d.job.id, title: d.job.title, company: d.job.companyName,
                outcome: 'duplicate', reason: d.reason,
            });
        }
        for (const b of pushRes.value.blocked) {
            blocked.push({
                jobId: b.job.id, title: b.job.title, company: b.job.companyName,
                outcome: 'blocked', code: b.code, reason: b.reason,
            });
        }

        await writeArtifact(runArtDir, 'picks.json', {
            picks,
            blocked,
            decisions,
            intent,
            mode: 'manual',
            captureStats: {
                rawCaptured: capturedJobs.length,
                normalised: normalised.length,
                deduped: deduped.length,
                linkedInSkipped: linkedInSkipped.length,
            },
        });

        store.update(runId, {
            phase: PHASES.DONE,
            picks,
            progress: { pushed: pushRes.value.stats },
        });

        await writeSummaryArtifact(runArtDir, {
            id: runId,
            phase: 'done',
            clientEmail,
            clientName,
            requestedCount: capturedJobs.length,
            picksCount: picks.length,
            stats: pushRes.value.stats,
            mode: 'manual',
            completedAt: new Date().toISOString(),
        });

        logger?.info?.(
            {
                pushed: picks.length,
                duplicates: pushRes.value.stats.duplicates,
                blocked: pushRes.value.stats.blocked,
                errors: pushRes.value.stats.errors,
            },
            'manual run: done',
        );
    } catch (e) {
        rootLogger?.error?.({ runId, err: e.message }, 'manual pipeline crashed');
        logger?.fatal?.({ err: e.message, stack: e.stack }, 'manual pipeline crashed');
        fail(store, runId, { code: 'UNEXPECTED', message: e.message }, logger);
    } finally {
        const finalState = store.get(runId);
        if (finalState && finalState.phase === PHASES.FAILED) {
            await writeErrorArtifact(runArtDir, finalState);
        }
        await closeRunLogger();
    }
}
