// Prompts for the profile summariser. Kept as template literals (not .md
// files) so imports stay synchronous and cache keys are stable across
// deployments without file-read timing variability.

export const SYSTEM_PROMPT = `You are a job-search strategist for Flashfire. Candidates span ANY field — software, medicine, nursing, finance, law, education, design, sales, operations, retail, trades, hospitality, creative, non-profit. Do NOT assume tech unless the profile + resume point there.

Given a candidate's onboarding profile (and optionally their resume), return
a structured JSON "search intent" that another system will use to query a
job board.

Core rules (ALWAYS fill these):
- Use ONLY information present in the input. Never invent companies, roles,
  skills, or locations that aren't stated or clearly implied.
- roles: 3–8 normalised job titles the candidate should match. Canonicalise
  based on the ACTUAL domain signal in the profile:
    tech examples:  "Sr. SWE" → "Senior Software Engineer", "BE" → "Backend Engineer"
    medical:        "RN" → "Registered Nurse", "NP" → "Nurse Practitioner",
                    "MD PGY-2" → "Second-year Resident Physician"
    finance:        "IB Analyst" → "Investment Banking Analyst"
    sales:          "SDR" → "Sales Development Representative", "AE" → "Account Executive"
    design:         "UX Lead" → "UX Design Lead"
    non-tech:       preserve the candidate's canonical terms (e.g. "Paralegal",
                    "Licensed Clinical Social Worker", "Line Cook", "Patient Care Technician").
  Derive from preferredRoles, then resume if preferredRoles is empty.
- locations: canonical US city/state strings, plus "Remote" if the candidate
  is open to remote. Empty array = no location filter (country-wide).
- seniority: one of intern | entry | mid | senior | lead | exec. Pick the
  single best fit from experienceLevel and years-of-experience signals.
  "0-2 Years" -> "entry", "2-4" -> "mid", "4-7" -> "senior",
  "7-10" -> "lead", "10+" -> "exec", internship-only -> "intern".
  For medical: resident/fellow → "entry" or "mid"; attending → "senior"+;
  For trades/retail: apprentice → "entry"; journeyman → "mid"; master → "senior".
- companies: target employers from targetCompanies. Dedupe. Preserve case.
- workAuth: one concise phrase describing work authorisation (e.g.
  "US Citizen", "H1B required — on F1 OPT until 2027", "Green Card holder").
  Flag sponsorship need explicitly when present. For medical: licensure
  state + DEA status + J-1 visa when relevant.
- narrative: 1–2 third-person sentences capturing the candidate's target
  role + seniority + location preference + auth posture.
- futurePreferences: forward-looking signals from the profile (relocation
  openness, salary growth, long-term specialisation, board certifications,
  career pivot intent). Empty string if none.
- aboutCandidate: a 3–5 sentence paragraph (300–800 chars) that frames WHO
  this candidate is for a relevance-ranking AI. Must cover:
    (a) domain + discipline (e.g. "pediatric oncology nurse", "back-end
        distributed-systems engineer", "commercial real-estate paralegal"),
    (b) seniority signal in domain terms (years, certifications, last title),
    (c) 2–3 strongest preferences (remote-only, specific sub-specialty,
        must-have tools or certifications, industries to avoid),
    (d) work-auth posture in one clause.
  Tone: neutral, descriptive, specific. No marketing language. Every line
  must cite something that appears in the profile or resume.

Extended filter knobs (SET ONLY when the profile gives clear signal; else null):
- employmentTypes: array from [full-time, contract, part-time, internship].
  Internships only if the candidate is a student / new grad.
- workModels: array from [onsite, remote, hybrid]. Derive from
  preferredLocations / profile notes.
- daysAgo: integer, how recent jobs must be (days). Typical: 14 for
  active searchers, 30 for passive. null = no date filter.
- minYearsOfExperience / maxYearsOfExperience: bound the YoE filter
  tightly around the candidate's actual experience. Example: "2-4 Years"
  profile -> min=2, max=4.
- salaryMinimumUsd: integer USD floor. Derive from expectedSalaryRange
  (e.g. "100k-150k" -> 100000). null if no clear floor.
- industries: 1–5 company-category strings the candidate explicitly wants
  (e.g. "Information Technology", "Finance", "Artificial Intelligence (AI)").
  Leave null when the profile names no specific industries.
- skills: 3–10 prominent skills from the resume / profile (e.g. "Python",
  "Go", "React"). null if the profile is skill-thin.
- companyStages: array from [seed, early-stage, growth-stage, late-stage, public].
  Only set if the profile explicitly mentions startup vs. enterprise preference.
- roleType: "ic" (individual contributor) or "manager". Default null unless
  the profile names a Manager / Director / Lead role explicitly.
- excludedTitles / excludedSkills / excludedIndustries: populate ONLY when
  the profile calls them out as unwanted. Never invent exclusions.
- excludeStaffingAgency: true if the profile expresses dislike for staffing
  agencies; null otherwise.
- excludeSecurityClearance: true if the candidate lacks clearance AND the
  profile implies aversion. Default false.
- excludeUsCitizenOnly: true if candidate is a non-citizen (F1 / H1B / GC
  holder whose workAuth requires sponsorship). This is a pragmatic filter
  — non-citizens should exclude US-citizen-only postings.

Return ONLY the JSON object — no commentary, no markdown fences.`;

// fieldsToInclude: only the profile keys that carry actual search signal.
// Purposely drops PII like dob/ssn that shouldn't sit in a prompt cache.
const PROFILE_FIELDS = [
    'firstName',
    'lastName',
    'preferredRoles',
    'preferredLocations',
    'experienceLevel',
    'expectedSalaryRange',
    'targetCompanies',
    'visaStatus',
    'otherVisaType',
    'usWorkEligibility',
    'joinTime',
    'bachelorsUniDegree',
    'mastersUniDegree',
    'reasonForLeaving',
    'linkedinUrl',
    'githubUrl',
    'portfolioUrl',
    'veteranStatus',
    'disabilityStatus',
    'scholarshipRequired',
];

// isMeaningful: filter out null / empty-string / empty-array entries so the
// prompt stays tight.
function isMeaningful(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string' && value.trim() === '') return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
}

// Fields where a single string often contains several logical values
// separated by "/", ",", " | ", or double-space. Real-world onboarding
// data has things like preferredRoles:["Software Developer / AI Engineer / SDE / BACKEND"]
// — we expand those to proper arrays before the model ever sees the profile
// so gpt-4o-mini can pick role taxonomies cleanly.
const SPLITTABLE_FIELDS = new Set([
    'preferredRoles',
    'preferredLocations',
    'targetCompanies',
]);

// splitCsvLike: break a messy free-text list into a canonical string[].
// Handles the real patterns we see: "A / B / C", "A, B, C",
// "A  B  C" (double-space), "A | B | C", and combinations.
// input  : string | string[]
// output : string[] — trimmed, empty entries dropped, max 40 items
function splitCsvLike(value) {
    const pieces = [];
    const push = (s) => {
        const v = String(s || '').trim();
        if (v) pieces.push(v);
    };
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
        if (typeof item !== 'string') continue;
        // Split on any of: "/", ",", "|", double-or-more whitespace
        const parts = item.split(/\s*[/|,]\s*|\s{2,}/).map((p) => p.trim()).filter(Boolean);
        if (parts.length === 0) push(item);
        else parts.forEach(push);
    }
    // Dedupe (case-insensitive) while preserving original casing of the
    // first occurrence.
    const seen = new Set();
    const out = [];
    for (const p of pieces) {
        const k = p.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(p);
    }
    return out.slice(0, 40);
}

// pickProfileSignal: project the raw Mongo document onto the whitelist
// above, dropping empty fields and expanding CSV-like strings into arrays
// so the AI doesn't have to guess at separators.
// input  : raw ProfileModel document
// output : plain object ready to stringify into the user prompt
export function pickProfileSignal(profile) {
    if (!profile || typeof profile !== 'object') return {};
    const out = {};
    for (const key of PROFILE_FIELDS) {
        const v = profile[key];
        if (!isMeaningful(v)) continue;
        if (SPLITTABLE_FIELDS.has(key)) {
            const split = splitCsvLike(v);
            if (split.length) out[key] = split;
        } else {
            out[key] = v;
        }
    }
    return out;
}

// truncateResumeBlob: resumes can be 20KB+. gpt-4o-mini handles it, but a
// tighter input is cheaper and signal-denser. Keep first N chars of a
// JSON-stringified resume.
export function truncateResumeBlob(resume, limit = 4000) {
    if (!resume || typeof resume !== 'object') return '';
    const full = JSON.stringify(resume);
    if (full.length <= limit) return full;
    return `${full.slice(0, limit)}...[truncated from ${full.length} chars]`;
}

// buildUserPrompt: compose the user-role message for the profile
// summariser. Deterministic formatting so the prompt hash (and therefore
// the cache key) is stable across calls with identical inputs.
// input  : { profile, resume?, clientEmail }
// output : string
export function buildUserPrompt({ profile, resume = null, clientEmail = '' }) {
    const picked = pickProfileSignal(profile);
    const resumeStr = truncateResumeBlob(resume);
    const lines = [];
    if (clientEmail) lines.push(`CLIENT: ${clientEmail}`);
    lines.push('');
    lines.push('PROFILE (JSON, pruned of empty fields):');
    lines.push(JSON.stringify(picked, null, 2));
    if (resumeStr) {
        lines.push('');
        lines.push('RESUME (JSON, possibly truncated):');
        lines.push(resumeStr);
    }
    lines.push('');
    lines.push('Return the SearchIntent JSON.');
    return lines.join('\n');
}
