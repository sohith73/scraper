// explainJobForClient
//
// Self-learning loop. Operator pastes a JR job URL → we fetch the job,
// build the client's SearchIntent the same way the run pipeline does,
// and ask gpt-4o-mini "given this candidate, would this job be picked,
// and if not why — what changed in profile or filters would flip it?"
//
// Two angles, both surfaced to the operator:
//   (a) AI-side reasoning — score + pick/skip + 2-3 sentence reason.
//   (b) Pipeline-side reasoning — was this job in the past-24h window?
//       Did its title resolve to a JR taxonomy entry that matches the
//       client's roles? Was the company / location on the exclusion list?
//       Operators get a checklist they can act on without reading code.

import { z } from 'zod';
import { ok, err } from '../../clients/common/result.js';
import { fetchJrJobByUrl } from './fetchJob.js';
import { isLinkedInApplyUrl } from '../../adapters/jobright.js';

// Pipeline-side facts we can derive without an AI call. Cheap + reliable.
function buildPipelineFindings({ job, intent, exclusions }) {
    const findings = [];
    const candidates = []; // ordered list of "would block this from being scraped"

    // 1. Past-24-h gate (hardcoded daysAgo=1)
    const now = Date.now();
    if (job.publishedAt) {
        const ageMs = now - Date.parse(job.publishedAt);
        const ageHours = ageMs / (1000 * 60 * 60);
        if (ageHours > 24) {
            candidates.push(`Posted ${Math.round(ageHours)}h ago — outside the hardcoded past-24-h window.`);
        } else {
            findings.push(`Posted ${Math.round(ageHours)}h ago — inside the 24-h window. ✓`);
        }
    }

    // 2. LinkedIn skip
    if (isLinkedInApplyUrl(job.applyUrl)) {
        candidates.push(`Apply URL is LinkedIn (${job.applyUrl}) — pipeline skips LinkedIn URLs entirely.`);
    }

    // 3. Exclusion company / location
    const excludedCompanies = (exclusions?.companies || []).map((s) => s.toLowerCase());
    const excludedLocations = (exclusions?.locations || []).map((s) => s.toLowerCase());
    if (excludedCompanies.some((c) => c && job.companyName?.toLowerCase?.().includes(c))) {
        candidates.push(`Company "${job.companyName}" matches client exclusion list.`);
    }
    if (excludedLocations.some((l) => l && job.jobLocation?.toLowerCase?.().includes(l))) {
        candidates.push(`Location "${job.jobLocation}" matches client exclusion list.`);
    }

    // 4. Role / taxonomy alignment (heuristic, AI handles the deep version)
    const intentRoles = [
        ...(intent?.roles || []),
        ...(intent?.relatedRoles || []),
    ].map((s) => s.toLowerCase());
    const titleLow = job.title?.toLowerCase?.() || '';
    const anyRoleHit = intentRoles.some((r) => titleLow.includes(r) || r.split(' ').every((w) => titleLow.includes(w)));
    if (intentRoles.length > 0 && !anyRoleHit) {
        candidates.push(
            `Job title "${job.title}" doesn't surface any of the client's roles/relatedRoles ` +
            `(${intentRoles.slice(0, 6).join(', ')}). Likely scored low by the AI relevance filter.`,
        );
    } else if (anyRoleHit) {
        findings.push(`Title overlaps a configured role. ✓`);
    }

    return { findings, candidates };
}

// AI verdict schema — strict so the route can render it without runtime
// surprises. Mirrors the relevance schema's decision shape but with a
// longer `reason` so the explanation fits in the UI panel.
const ExplainerOutput = z.object({
    pick: z.boolean(),
    score: z.number().int().min(0).max(100),
    primaryReason: z.string().min(1).max(400),
    fix: z.string().max(400).optional().default(''),
    rolesAlignment: z.string().max(200).optional().default(''),
    seniorityAlignment: z.string().max(200).optional().default(''),
    locationAlignment: z.string().max(200).optional().default(''),
});

const EXPLAINER_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['pick', 'score', 'primaryReason', 'fix', 'rolesAlignment', 'seniorityAlignment', 'locationAlignment'],
    properties: {
        pick: { type: 'boolean' },
        score: { type: 'integer', minimum: 0, maximum: 100 },
        primaryReason: { type: 'string' },
        fix: { type: 'string' },
        rolesAlignment: { type: 'string' },
        seniorityAlignment: { type: 'string' },
        locationAlignment: { type: 'string' },
    },
};

const SYSTEM_PROMPT = `You are reviewing one job for one candidate to explain whether a recruiter-grade scraper would have picked it.

Output strict JSON:
- pick: boolean — would this job be a real-world fit for the candidate?
- score: integer 0-100 — your confidence the candidate is a strong match.
- primaryReason: 1-2 sentences why pick/skip — name the dominant factor.
- fix: if pick=false, ONE concrete change to the candidate's profile or filters that would flip the verdict (e.g. "add 'Data Engineer' to preferredRoles", "raise YoE max to 7", "lift Onsite-only restriction"). Empty string when pick=true.
- rolesAlignment: 1 sentence comparing job title vs the candidate's roles/relatedRoles.
- seniorityAlignment: 1 sentence comparing required seniority/YoE vs candidate.
- locationAlignment: 1 sentence comparing job location vs candidate locations.

Be honest — most "skip" verdicts boil down to discipline mismatch, seniority gap, or location/work-model conflict. Surface that one factor in primaryReason.`;

function compactJob(job) {
    return {
        id: job.id,
        title: job.title,
        company: job.companyName,
        location: job.jobLocation,
        workModel: job.workModel,
        isRemote: job.isRemote,
        seniority: job.seniority,
        minYoE: job.minYearsOfExperience,
        publishedAt: job.publishedAt,
        applicantsCount: job.applicantsCount,
        flags: job.flags,
        // Truncate description so prompt stays bounded.
        description: (job.description || '').slice(0, 4000),
        mustHave: job.requirements?.must || [],
        preferredHave: job.requirements?.preferred || [],
    };
}

function compactIntent(intent) {
    return {
        roles: intent?.roles || [],
        relatedRoles: intent?.relatedRoles || [],
        seniority: intent?.seniority,
        minYoE: intent?.minYearsOfExperience,
        maxYoE: intent?.maxYearsOfExperience,
        locations: intent?.locations || [],
        workModels: intent?.workModels,
        salaryMinimumUsd: intent?.salaryMinimumUsd,
        workAuth: intent?.workAuth,
        narrative: intent?.narrative,
        aboutCandidate: (intent?.aboutCandidate || '').slice(0, 1000),
    };
}

// explainJobForClient: top-level entry point.
//
// input  : { container, clientEmail, jobUrl }
// output : Result<{
//            jobId, job, verdict: ExplainerOutput,
//            pipelineFindings, blockingCandidates,
//          }>
export async function explainJobForClient({ container, clientEmail, jobUrl }) {
    if (!clientEmail || !clientEmail.includes('@')) {
        return err('BAD_INPUT', 'clientEmail required');
    }
    if (typeof jobUrl !== 'string' || !jobUrl.trim()) {
        return err('BAD_INPUT', 'jobUrl required');
    }
    const { dashboard, resume, summariser, browser, session, env, ai, logger } = container;

    // 1. Fetch the JR job behind the URL.
    const jobRes = await fetchJrJobByUrl({ browser, session, env, url: jobUrl, logger });
    if (!jobRes.ok) return jobRes;
    const { job, jobId } = jobRes.value;

    // 2. Pull profile + exclusions + resume just like the run pipeline.
    //    Resume is best-effort; missing resume only hurts AI quality, not
    //    the pipeline-findings half of the response.
    const [profileRes, exclusionsRes, resumeRes] = await Promise.all([
        dashboard.getProfile(clientEmail),
        dashboard.getExclusions(clientEmail),
        resume.getByEmail(clientEmail),
    ]);
    if (!profileRes.ok) return profileRes;
    const exclusions = exclusionsRes.ok
        ? {
              companies: exclusionsRes.value.excludedCompanies,
              locations: exclusionsRes.value.excludedLocations,
          }
        : { companies: [], locations: [] };
    const resumeDoc = resumeRes.ok && resumeRes.value.found ? resumeRes.value.resume : null;

    // 3. Build SearchIntent. Reuse the cached summary when available.
    const summaryRes = await summariser({
        profile: profileRes.value.profile,
        resume: resumeDoc,
        exclusions,
        clientEmail,
    });
    if (!summaryRes.ok) return summaryRes;
    const intent = summaryRes.value.intent;

    // 4. Cheap pipeline-side findings — these don't need an AI call.
    const { findings, candidates } = buildPipelineFindings({ job, intent, exclusions });

    // 5. Ask gpt-4o-mini for the deep verdict.
    const aiRes = await ai.completeJson({
        system: SYSTEM_PROMPT,
        user: JSON.stringify({
            candidate: compactIntent(intent),
            job: compactJob(job),
        }),
        schemaName: 'ExplainerOutput',
        schema: EXPLAINER_JSON_SCHEMA,
        zodSchema: ExplainerOutput,
    });
    if (!aiRes.ok) return aiRes;
    const parsed = ExplainerOutput.safeParse(aiRes.value.value);
    if (!parsed.success) {
        return err('BAD_SHAPE', 'AI explainer output failed schema validation', {
            issues: parsed.error.issues,
        });
    }

    return ok({
        jobId,
        job: {
            id: job.id,
            title: job.title,
            company: job.companyName,
            location: job.jobLocation,
            applyUrl: job.applyUrl,
            publishedAt: job.publishedAt,
            seniority: job.seniority,
            workModel: job.workModel,
        },
        verdict: parsed.data,
        pipelineFindings: findings,
        blockingCandidates: candidates,
        cacheHit: summaryRes.value.cacheHit || false,
        usage: aiRes.value.usage || null,
    });
}
