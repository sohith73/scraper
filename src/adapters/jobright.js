// JobRight schema adapter.
//
// Why : the rest of the scraper (relevance filter, dashboard push pipeline,
//       UI) consumes a single canonical `Job` shape. Every time JR adjusts
//       their payload, this file — and ONLY this file — breaks. That's the
//       entire point of the adapter pattern.
//
// The canonical `Job` is documented below next to normalizeJobRightJob.
// A copy of the raw JR payload stays at `.raw` for debugging / forensic
// work when the normalisation produces something unexpected.

// str: defensive string coercion. Null/undefined → ''.
function str(v) {
    if (v == null) return '';
    return typeof v === 'string' ? v : String(v);
}

// num: coerce to finite number or fall back.
function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

// arr: defensive array access. Returns [] for non-arrays.
function arr(v) {
    return Array.isArray(v) ? v : [];
}

// bool: coerce to boolean without surprising .toString() semantics.
function bool(v) {
    return v === true || v === 'true' || v === 1;
}

// bullet: returns ASCII-friendly bulleted list, or '' if empty.
function bullet(items) {
    if (!items.length) return '';
    return items.map((i) => `• ${i}`).join('\n');
}

// composeDescription: JR splits the JD into summary + responsibilities +
// must-have + preferred + skills. We concatenate into the single string the
// dashboard's `jobDescription` field expects.
// input  : jobResult object
// output : string (may be empty if JR returned an empty record)
export function composeDescription(jobResult) {
    const jr = jobResult || {};
    const parts = [];
    const summary = str(jr.jobSummary).trim();
    if (summary) parts.push(summary);

    const resp = arr(jr.coreResponsibilities);
    if (resp.length) parts.push(`Responsibilities:\n${bullet(resp)}`);

    const must = arr(jr.qualifications?.mustHave);
    if (must.length) parts.push(`Must have:\n${bullet(must)}`);

    const pref = arr(jr.qualifications?.preferredHave);
    if (pref.length) parts.push(`Nice to have:\n${bullet(pref)}`);

    const skills = arr(jr.skillSummaries);
    if (skills.length) parts.push(`Key skills:\n${bullet(skills)}`);

    const benefits = arr(jr.benefitsSummaries);
    if (benefits.length) parts.push(`Benefits:\n${bullet(benefits)}`);

    const why = str(jr.whyJoinUs).trim();
    if (why) parts.push(`Why join us:\n${why}`);

    return parts.join('\n\n').trim();
}

// isLinkedInApplyUrl: returns true when the apply URL routes through
// LinkedIn. We skip these entirely because:
//  - they require a LinkedIn account to actually apply
//  - LinkedIn's apply flow is less reliable than direct career-site URLs
//  - the dashboard tracker prefers direct links
// Defensive parse so a malformed URL just returns false (filter stays fast).
export function isLinkedInApplyUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    try {
        const u = new URL(url);
        return /(^|\.)linkedin\.com$/i.test(u.hostname);
    } catch {
        return /linkedin\.com/i.test(url);
    }
}

// normalizeJobRightJob: JR's recommend/list/jobs entry → our canonical Job.
//
// Canonical shape:
//   {
//     id,                // JR jobId — stable dedup key across runs
//     impId,             // JR impression ID (per-ranking snapshot)
//     title,
//     companyName,
//     jobLocation,       // free text, as JR provides
//     workModel,         // "Remote" | "Onsite" | "Hybrid" | ""
//     isRemote,
//     employmentType,    // "Full-time" | ...
//     seniority,         // JR's human label (our own enum lives in intent/schema.js)
//     minYearsOfExperience,
//     publishedAt,       // JR's absolute timestamp
//     publishedAtRelative,
//     applicantsCount,
//     applyUrl,          // → dashboard.joblink
//     description,       // composed — → dashboard.jobDescription
//     requirements: { must:[], preferred:[] },
//     tags: [...],       // "H1B Sponsor Likely", "Early Applicant", etc.
//     flags: { h1bSponsor, citizenOnly, clearanceRequired, workAuthRequired },
//     score: { raw, label },   // raw displayScore + "Fair Match" label
//     company: { name, size, description, categories[], linkedinUrl, ... },
//     raw,               // original JR payload — don't rely on it for logic
//   }
//
// Returns null for inputs that don't look like a JR job record (so caller
// can .filter(Boolean)).
export function normalizeJobRightJob(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const jr = raw.jobResult || {};
    const cr = raw.companyResult || {};
    if (!jr.jobId) return null; // not a job; skip silently

    return {
        id: str(jr.jobId),
        impId: str(raw.impId),
        title: str(jr.jobTitle),
        companyName: str(cr.companyName),
        jobLocation: str(jr.jobLocation),
        workModel: str(jr.workModel),
        isRemote: bool(jr.isRemote),
        employmentType: str(jr.employmentType),
        seniority: str(jr.jobSeniority),
        minYearsOfExperience: num(jr.minYearsOfExperience, 0),
        publishedAt: str(jr.publishTime),
        publishedAtRelative: str(jr.publishTimeDesc),
        applicantsCount: num(jr.applicantsCount, 0),
        applyUrl: str(jr.applyLink || jr.originalUrl),
        description: composeDescription(jr),
        requirements: {
            must: arr(jr.qualifications?.mustHave).map(str).filter(Boolean),
            preferred: arr(jr.qualifications?.preferredHave).map(str).filter(Boolean),
        },
        tags: [...arr(jr.recommendationTags), ...arr(jr.jobTags)]
            .map(str)
            .filter(Boolean),
        flags: {
            h1bSponsor: bool(jr.isH1bSponsor),
            citizenOnly: bool(jr.isCitizenOnly),
            clearanceRequired: bool(jr.isClearanceRequired),
            workAuthRequired: bool(jr.isWorkAuthRequired),
        },
        score: {
            raw: num(raw.displayScore, 0),
            label: str(raw.rankDesc),
        },
        company: {
            name: str(cr.companyName),
            size: str(cr.companySize),
            description: str(cr.companyDesc),
            categories: str(cr.companyCategories)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            linkedinUrl: str(cr.companyLinkedinURL),
            website: str(cr.companyURL),
            location: str(cr.companyLocation),
            foundYear: str(cr.companyFoundYear),
            fundingStage: str(cr.fundraisingCurrentStage),
            totalFunding: str(cr.fundraisingTotalFunding),
        },
        raw,
    };
}

// toDashboardJob: canonical Job → the shape `dashboard.pushJob` wants.
// Keeps the translation in one place so Phase 12 doesn't re-interpret the
// canonical type.
// input  : canonical Job
// output : { jobTitle, companyName, jobLocation, jobDescription, joblink }
export function toDashboardJob(job) {
    return {
        jobTitle: job.title,
        companyName: job.companyName,
        jobLocation: job.jobLocation,
        jobDescription: job.description,
        joblink: job.applyUrl,
    };
}
