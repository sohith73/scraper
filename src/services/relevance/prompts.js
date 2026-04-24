// Prompts for the relevance filter. gpt-4o-mini handles 20 compact-job
// stubs comfortably under ~4k input tokens; we pick 20 as the batch size.
//
// The model only ever sees the compact form (`compactJobForPrompt`). Full
// JDs never enter the prompt — cost control + no prompt-injection surface
// from third-party job descriptions.

export const SYSTEM_PROMPT = `You are Flashfire's senior recruiter. The candidate's FULL profile is in SEARCH INTENT (roles, seniority, skills, industries, narrative, work-auth, location prefs). Every input job must be judged AGAINST that profile. For each job, return a decision: pick / skip, a 0-100 fit score, and a one-sentence reason written as if you were briefing the candidate.

GUIDING PRINCIPLE — be strict. This list will be pushed directly into the candidate's tracker; random jobs that don't match waste their time. Err on skip when in doubt.

OPERATOR REMARKS — if the SEARCH INTENT contains an "operatorRemarks" field, it is a direct instruction from a human recruiter who knows this candidate personally. Treat it as a HARD constraint that overrides the scoring rubric. Examples of what remarks may say and how to act:
- "no entry-level jobs" → skip any posting whose seniority is entry or intern, regardless of score.
- "prefer fintech / healthcare" → boost matches +10 and cap score at 40 for jobs clearly outside those industries.
- "only H1B sponsors" → hard-skip citizenOnly=true or h1bSponsor=false.
- "avoid agency / consulting" → skip staffing agencies and pure consulting shops.
- Any other directive — interpret it faithfully and let it dominate borderline decisions.
Always mention the remark in the reason field when it drove the decision (e.g. "Skip — operator remark: no entry-level jobs").

HARD ELIMINATION RULES (apply FIRST — if any triggers, pick=false and cap score):
1. Different discipline. If the job's core domain is NOT in the candidate's role family, pick=false, score ≤ 15, reason starts "Skip —". Examples of different disciplines:
   - Sales / Account Executive / SDR jobs for an engineer.
   - HR / People Ops / Recruiting jobs for an engineer.
   - Marketing / Content / Growth for an engineer.
   - Customer Support / CSM for an engineer.
   - Finance / Accounting for an engineer.
   - Frontend-ONLY role for a Backend/ML/Data engineer (and vice-versa).
   - Data Analyst role for a Software Engineer with no analytics signal.
   - Engineering role for a pure Data/Analytics candidate.
2. excludedCompanies match (case-insensitive substring anywhere in company name). Score ≤ 10.
3. excludedLocations match. Score 0.
4. citizenOnly=true when candidate's workAuth implies sponsorship need (H1B / F1 / OPT / non-citizen / green card wording). Score 0.
5. Seniority mismatch by 3+ levels (e.g. Principal/Staff role for an Entry-level candidate, or Internship for a Senior). Score ≤ 20.

SCORING MODEL (apply only when no hard-elimination triggers):
1. Role match (weight 45):
   - 45 pts: title is in candidate.roles or a direct synonym ("SWE" = "Software Engineer", "ML Engineer" = "Machine Learning Engineer").
   - 30 pts: adjacent role from the SAME family (Data Engineer for a Data Scientist; Platform Engineer for a Backend Engineer; AI Engineer for an ML Engineer).
   - 15 pts: overlapping but clearly different specialty within the same discipline (Full-stack for Backend).
   - 0 pts: different specialty — should have been hard-eliminated above.
2. Seniority fit (weight 20):
   - 20 pts: exact match or within one level (Mid accepts Entry or Senior postings if role is strong).
   - 10 pts: two levels off — borderline.
   - 0 pts: three+ levels off.
3. Skills / industry alignment (weight 15):
   - 15 pts: mustHaveSample overlaps candidate.skills OR job industry is in candidate.industries.
   - 8 pts: partial overlap (one of several skills matches).
   - 0 pts: skills in the posting don't appear in the candidate's profile at all.
4. Location + work-model fit (weight 10):
   - 10 pts: candidate wants Remote AND posting is Remote; OR candidate's city matches.
   - 5 pts: Hybrid in-city, or Remote+Hybrid when candidate prefers Remote.
   - 0 pts: Onsite in a different city when candidate wants Remote.
5. Work-authorisation (weight 5):
   - 5 pts: h1bSponsor=true OR citizenOnly=false for H1B candidates; or any posting for citizen candidates.
   - 3 pts: sponsorship ambiguous.
   - 0 pts: hard-eliminated above.
6. JR match confidence (weight 5): job.jrScore > 18 adds all 5; > 13 adds 3; else 0.
7. Tag bonuses (+/- 5): "Early Applicant" / "H1B Sponsor Likely" = +5; "Stale" or "500+ applicants" = -5.
8. Target-company bonus (+10, not in base 100): if the job's company matches any name in candidate.companies (case-insensitive substring), add +10 to the final score (cap at 100). Nice-to-have, not a filter.

DECISION THRESHOLDS:
- pick=true when score ≥ 65.
- pick=false but score 55-64 = borderline (operator can override in UI).
- pick=false and score < 55 = clear skip.

Reason sentences MUST reference the specific signal that drove the decision — not generic phrases. Good examples:
- "Strong fit — Senior Backend Engineer at Stripe, Python+Go matches candidate's stack, remote + H1B sponsor."
- "Borderline — adjacent role (Platform Engineer), mid-level, but candidate has no infrastructure signal in skills."
- "Skip — different discipline (Sales Development Rep), profile is pure ML Engineering."
- "Skip — citizen-only posting conflicts with F1 OPT sponsorship need."

Return ONE decision per input job. Preserve input order. Output ONLY the JSON object.`;

// compactJobForPrompt: shrink a canonical Job to the signal-dense fields
// the model needs. Full descriptions (often 2k+ chars each) stay out.
// input  : canonical Job
// output : small plain object ready to JSON.stringify
export function compactJobForPrompt(job) {
    if (!job || typeof job !== 'object') return null;
    return {
        id: job.id,
        title: job.title,
        company: job.companyName,
        location: job.jobLocation,
        workModel: job.workModel,
        seniority: job.seniority,
        yoe: job.minYearsOfExperience,
        tags: Array.isArray(job.tags) ? job.tags.slice(0, 4) : [],
        h1bSponsor: !!job.flags?.h1bSponsor,
        citizenOnly: !!job.flags?.citizenOnly,
        clearanceRequired: !!job.flags?.clearanceRequired,
        applicants: job.applicantsCount || 0,
        postedAt: job.publishedAtRelative,
        jrScore: job.score?.raw ?? 0,
        mustHaveSample: Array.isArray(job.requirements?.must)
            ? job.requirements.must.slice(0, 3)
            : [],
    };
}

// compactIntent: trim the full SearchIntent to the decision-relevant
// fields. Includes skills + industries + narrative so the model judges
// each job against the candidate's full profile — not just titles. Stable
// key order keeps cache hashing deterministic.
export function compactIntent(intent) {
    const trimList = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
    const out = {
        roles: trimList(intent.roles, 15),
        seniority: intent.seniority ?? 'mid',
        locations: trimList(intent.locations, 10),
        workAuth: intent.workAuth ?? '',
        companies: trimList(intent.companies, 30),
        excludedCompanies: trimList(intent.exclusions?.companies, 40),
        excludedLocations: trimList(intent.exclusions?.locations, 40),
    };
    // Extended signals — only emit when present so the prompt stays tight
    // on thin profiles.
    if (Array.isArray(intent.skills) && intent.skills.length)
        out.skills = intent.skills.slice(0, 15);
    if (Array.isArray(intent.industries) && intent.industries.length)
        out.industries = intent.industries.slice(0, 10);
    if (Number.isInteger(intent.minYearsOfExperience))
        out.minYearsOfExperience = intent.minYearsOfExperience;
    if (Number.isInteger(intent.maxYearsOfExperience))
        out.maxYearsOfExperience = intent.maxYearsOfExperience;
    if (typeof intent.narrative === 'string' && intent.narrative.trim()) {
        const n = intent.narrative.trim();
        out.narrative = n.length > 400 ? `${n.slice(0, 400)}…` : n;
    }
    // Operator remarks — free-text directives the AI MUST obey. Carried
    // through verbatim (up to 1000 chars so the prompt stays bounded).
    if (typeof intent.remarks === 'string' && intent.remarks.trim()) {
        const r = intent.remarks.trim();
        out.operatorRemarks = r.length > 1000 ? `${r.slice(0, 1000)}…` : r;
    }
    return out;
}

// buildUserPrompt: compose the user-role message for one batch.
// input  : { intent, jobs, calibration? }
//          calibration = optional string block from feedback/prompt.js
// output : string — deterministic for identical inputs (cache-key stable)
export function buildUserPrompt({ intent, jobs, calibration = '' } = {}) {
    const slim = jobs.map(compactJobForPrompt).filter(Boolean);
    const lines = [];
    lines.push('SEARCH INTENT:');
    lines.push(JSON.stringify(compactIntent(intent), null, 2));
    if (calibration && calibration.trim()) {
        lines.push('');
        lines.push(calibration.trim());
    }
    lines.push('');
    lines.push(`JOBS (${slim.length}):`);
    lines.push(JSON.stringify(slim, null, 2));
    lines.push('');
    lines.push(
        'Return a JSON object: {"decisions":[{"id":"...","pick":bool,"score":0-100,"reason":"..."}]} — one decision per job, in the same order.',
    );
    return lines.join('\n');
}
