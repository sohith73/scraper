// SearchIntent → JobRight filter payload.
//
// JR's filter shape was fully enumerated in Phase 0 + Phase-17 add-on (see
// docs/filter-enums.md). Every intent field maps to one JR key; unknown or
// absent intent fields leave the JR field alone (either keeping the
// caller-supplied `existing` value or falling back to a conservative
// default).
//
// Seniority / job-type / work-model enum values were verified by direct
// probes against real JR — see docs/filter-enums.md.

// SENIORITY_ENUM_MAP: our closed enum → JR integer codes (UI chip order).
export const SENIORITY_ENUM_MAP = Object.freeze({
    intern: 1,
    entry: 2,
    mid: 3,
    senior: 4,
    lead: 5,
    exec: 6,
});

// Work-model codes: 1=Onsite, 2=Remote, 3=Hybrid. Probed live 2026-04-23.
export const WORK_MODEL = Object.freeze({
    ONSITE: 1,
    REMOTE: 2,
    HYBRID: 3,
});

// Named helpers for work-model enum array values.
export const WORK_MODEL_BY_ALIAS = Object.freeze({
    onsite: WORK_MODEL.ONSITE,
    remote: WORK_MODEL.REMOTE,
    hybrid: WORK_MODEL.HYBRID,
});

// Job-type codes: probed 2026-04-23. 1/2 confirmed live; 3/4 follow the UI
// chip order (Part-time / Internship). Any value JR doesn't recognise is
// silently stored but returns no jobs — stick to these four.
export const JOB_TYPES = Object.freeze({
    FULL_TIME: 1,
    CONTRACT: 2,
    PART_TIME: 3,
    INTERNSHIP: 4,
});

export const JOB_TYPE_BY_ALIAS = Object.freeze({
    'full-time': JOB_TYPES.FULL_TIME,
    contract: JOB_TYPES.CONTRACT,
    'part-time': JOB_TYPES.PART_TIME,
    internship: JOB_TYPES.INTERNSHIP,
});

// Company-stage string codes — JR stores as string array; UI chip order.
// Mapping from our enum aliases to JR's "1".."7" strings.
export const COMPANY_STAGE_BY_ALIAS = Object.freeze({
    seed: '1',
    'early-stage': '2',
    'growth-stage': '3',
    'late-stage': '4',
    public: '5',
});

// roleType string codes — JR accepts "IC" / "Manager" as-is.
export const ROLE_TYPE_BY_ALIAS = Object.freeze({
    ic: 'IC',
    manager: 'Manager',
});

export const DEFAULT_RADIUS_MILES = 25;

// isRemoteLocation: detects the "Remote" / "remote" / "100% remote" token
// that can appear in either intent.locations or profile.preferredLocations.
function isRemoteLocation(loc) {
    return typeof loc === 'string' && /remote/i.test(loc);
}

// US state names — JR rejects a bare state as a `city` value. Treat these
// as "any US city in this state" by falling back to the country-wide
// radius filter. Operators can still set a specific city in the UI.
const BARE_STATE_NAMES = new Set([
    'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
    'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
    'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
    'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
    'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
    'new hampshire', 'new jersey', 'new mexico', 'new york',
    'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
    'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
    'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
    'west virginia', 'wisconsin', 'wyoming',
    'usa', 'us', 'united states', 'united states of america',
]);

function isBareState(loc) {
    return BARE_STATE_NAMES.has(String(loc || '').trim().toLowerCase());
}

// mapCountry: normalise operator override to the short ISO code JR expects.
// JR's `country` field is live-verified for US + CA. Any other value (from a
// stale saved record or a typo) falls back to 'US' — never sent raw to JR.
const COUNTRY_ALIASES = {
    us: 'US', usa: 'US', 'united states': 'US', 'united states of america': 'US',
    ca: 'CA', can: 'CA', canada: 'CA',
};
function mapCountry(intent) {
    const raw = String(intent?.country || '').trim().toLowerCase();
    if (!raw) return 'US';
    return COUNTRY_ALIASES[raw] || 'US';
}

// cleanCity: strip trailing country suffix that some profiles carry
// ("Cambridge, MA, USA" → "Cambridge, MA"). JR rejects the 3-part form
// with a 400 and no hint, which is how we learned about this in prod.
function cleanCity(raw) {
    return String(raw || '')
        .replace(/\s*,\s*(USA|US|United States|United States of America)\s*$/i, '')
        .trim();
}

function mapLocations(intent) {
    const locations = Array.isArray(intent?.locations) ? intent.locations : [];
    const cityLocations = locations
        .filter(
            (l) =>
                typeof l === 'string' &&
                l.trim() &&
                !isRemoteLocation(l) &&
                !isBareState(l),
        )
        .map((city) => ({ city: cleanCity(city), radiusRange: DEFAULT_RADIUS_MILES }))
        .filter((x) => x.city);
    if (cityLocations.length === 0) {
        return [{ city: 'Within US', radiusRange: DEFAULT_RADIUS_MILES }];
    }
    // JR caps location list. Keep the first 5 — more than enough for any
    // realistic operator search.
    return cityLocations.slice(0, 5);
}

function mapWorkModel(intent) {
    // Explicit `workModels` wins over the implicit "Remote in locations" signal.
    if (Array.isArray(intent?.workModels) && intent.workModels.length > 0) {
        const codes = intent.workModels
            .map((w) => WORK_MODEL_BY_ALIAS[String(w).toLowerCase()])
            .filter(Number.isFinite);
        if (codes.length) return [...new Set(codes)];
    }
    const locs = Array.isArray(intent?.locations) ? intent.locations : [];
    const remoteWanted = locs.some(isRemoteLocation);
    if (remoteWanted) return [WORK_MODEL.REMOTE, WORK_MODEL.HYBRID];
    return [WORK_MODEL.ONSITE, WORK_MODEL.REMOTE, WORK_MODEL.HYBRID];
}

function mapSeniority(intent) {
    const key = typeof intent?.seniority === 'string' ? intent.seniority : 'mid';
    const code = SENIORITY_ENUM_MAP[key] ?? SENIORITY_ENUM_MAP.mid;
    return [code];
}

// mapEmploymentTypes: intent.employmentTypes (string[]) → JR int[].
// When intent leaves it null, keep whatever `existing` had; only when intent
// explicitly provides a list do we override.
function mapJobTypes(intent, baseJobTypes) {
    const aliases = Array.isArray(intent?.employmentTypes) ? intent.employmentTypes : null;
    if (aliases && aliases.length > 0) {
        const codes = aliases
            .map((a) => JOB_TYPE_BY_ALIAS[String(a).toLowerCase()])
            .filter(Number.isFinite);
        if (codes.length) return [...new Set(codes)];
    }
    if (Array.isArray(baseJobTypes) && baseJobTypes.length) return baseJobTypes;
    return [JOB_TYPES.FULL_TIME];
}

function mapH1BOnly(intent) {
    const auth = typeof intent?.workAuth === 'string' ? intent.workAuth : '';
    return /h1b|h\-1b|sponsor/i.test(auth);
}

// mapYoeRange: returns a JR-compatible `[min,max]` int array, or null when
// intent supplies neither bound. JR also accepts string aliases like
// "Entry" but we stick to explicit ranges for deterministic round-trip.
function mapYoeRange(intent) {
    const min = Number.isInteger(intent?.minYearsOfExperience)
        ? intent.minYearsOfExperience
        : null;
    const max = Number.isInteger(intent?.maxYearsOfExperience)
        ? intent.maxYearsOfExperience
        : null;
    if (min === null && max === null) return null;
    return [min ?? 0, max ?? 40];
}

function mapCompanyStages(intent) {
    const src = Array.isArray(intent?.companyStages) ? intent.companyStages : null;
    if (!src || src.length === 0) return null;
    const codes = src
        .map((s) => COMPANY_STAGE_BY_ALIAS[String(s).toLowerCase()])
        .filter(Boolean);
    return codes.length ? [...new Set(codes)] : null;
}

function mapRoleType(intent) {
    if (intent?.roleType == null) return null;
    return ROLE_TYPE_BY_ALIAS[String(intent.roleType).toLowerCase()] || null;
}

// searchIntentToJRFilter: the primary export.
//
// input  : { intent: SearchIntent, existing?: JRFilter }
// output : JR filter payload ready to POST
export function searchIntentToJRFilter({ intent, existing = null, resolvedTaxonomyList = null } = {}) {
    if (!intent || typeof intent !== 'object') {
        throw new TypeError('searchIntentToJRFilter: intent is required');
    }

    const base = existing && typeof existing === 'object' ? existing : {};

    const roles = Array.isArray(intent.roles) ? intent.roles : [];
    // NOTE: we deliberately do NOT forward `intent.companies` to JR's
    // `companies` filter. JR treats that field as an EXCLUSIVE whitelist
    // — only jobs at those companies are returned. Real client profiles
    // carry 20+ "wishlist" companies; combined with entry-level + H1B +
    // role filters the result set is almost always zero.
    //
    // Target-companies are used as a scoring hint inside the Phase-10
    // relevance filter (the AI sees them as "candidate's target list"
    // and boosts score when a returned job matches). That preserves the
    // operator intent without over-narrowing JR's universe.
    const companies = [];

    // Merge excluded company list: start with whatever the dashboard marked
    // and also honour anything the filter already had from prior runs.
    // JR expects `{companyName}` objects here (same CompanyBO shape as
    // `companies`). Handle both shapes on input to tolerate legacy data.
    const intentExcluded = Array.isArray(intent.exclusions?.companies)
        ? intent.exclusions.companies
        : [];
    const baseExcluded = Array.isArray(base.excludedCompanies)
        ? base.excludedCompanies
        : [];
    const excludedSeen = new Set();
    const excludedCompanies = [];
    for (const raw of [...baseExcluded, ...intentExcluded]) {
        let name;
        if (typeof raw === 'string') name = raw.trim();
        else if (raw && typeof raw === 'object') name = (raw.companyName || raw.name || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (excludedSeen.has(key)) continue;
        excludedSeen.add(key);
        excludedCompanies.push({ companyName: name });
    }

    // Industries (companyCategory) — free-text list. Merge intent + base.
    const industries = Array.isArray(intent.industries) ? intent.industries : null;
    const companyCategory = industries && industries.length
        ? [...new Set(industries.map((s) => String(s).trim()).filter(Boolean))]
        : (Array.isArray(base.companyCategory) ? base.companyCategory : []);

    // Excluded industries.
    const excludedIndustries = Array.isArray(intent.excludedIndustries)
        ? intent.excludedIndustries
        : null;
    const excludeCompanyCategory = excludedIndustries && excludedIndustries.length
        ? [...new Set(excludedIndustries.map((s) => String(s).trim()).filter(Boolean))]
        : (base.excludeCompanyCategory ?? null);

    // Skills.
    const intentSkills = Array.isArray(intent.skills) ? intent.skills : null;
    const skills = intentSkills && intentSkills.length
        ? [...new Set(intentSkills.map((s) => String(s).trim()).filter(Boolean))]
        : (Array.isArray(base.skills) ? base.skills : []);

    const intentExcludedSkills = Array.isArray(intent.excludedSkills)
        ? intent.excludedSkills
        : null;
    const excludedSkills = intentExcludedSkills && intentExcludedSkills.length
        ? [...new Set(intentExcludedSkills.map((s) => String(s).trim()).filter(Boolean))]
        : (base.excludedSkills ?? null);

    // Excluded titles. JR's deserializer expects an ARRAY of strings;
    // sending a single joined string triggers a 400 with
    //   "JSON parse error: Cannot construct instance of `java.util.ArrayList`...
    //    no String-argument constructor/factory method to deserialize from
    //    String value ('Technician')"
    // Pass through as array; preserve whatever shape `existing` had only
    // when intent didn't supply its own list.
    const intentExcludedTitles = Array.isArray(intent.excludedTitles)
        ? intent.excludedTitles
        : null;
    const excludedTitle = (() => {
        if (intentExcludedTitles && intentExcludedTitles.length) {
            return [...new Set(intentExcludedTitles.map((s) => String(s).trim()).filter(Boolean))];
        }
        const baseVal = base.excludedTitle;
        if (Array.isArray(baseVal)) return baseVal;
        if (typeof baseVal === 'string' && baseVal.trim()) {
            // Stale string from a previous bad save — split + rehydrate.
            return baseVal.split(',').map((s) => s.trim()).filter(Boolean);
        }
        return [];
    })();

    // Scalar overrides — intent wins; fall back to base; fall back to null.
    const daysAgo = Number.isInteger(intent.daysAgo) && intent.daysAgo > 0
        ? intent.daysAgo
        : (base.daysAgo ?? null);

    const annualSalaryMinimum = Number.isInteger(intent.salaryMinimumUsd)
        ? intent.salaryMinimumUsd
        : (base.annualSalaryMinimum ?? null);

    const minYearsOfExperienceRange = mapYoeRange(intent)
        ?? (Array.isArray(base.minYearsOfExperienceRange) ? base.minYearsOfExperienceRange : null);

    const companyStages = mapCompanyStages(intent) ?? (base.companyStages ?? null);

    const roleType = mapRoleType(intent) ?? (base.roleType ?? null);

    const excludeStaffingAgency = typeof intent.excludeStaffingAgency === 'boolean'
        ? intent.excludeStaffingAgency
        : (base.excludeStaffingAgency ?? null);

    const excludeSecurityClearance = typeof intent.excludeSecurityClearance === 'boolean'
        ? intent.excludeSecurityClearance
        : (base.excludeSecurityClearance ?? false);

    const excludeUsCitizen = typeof intent.excludeUsCitizenOnly === 'boolean'
        ? intent.excludeUsCitizenOnly
        : (base.excludeUsCitizen ?? false);

    // jobTaxonomyList is THE primary role signal for JR's recommender.
    // Caller (runSearch) resolves intent.roles → taxonomy entries via the
    // /swan/filter/support/titles catalog and passes the result in
    // `resolvedTaxonomyList`. When provided we ALWAYS use it (replacing any
    // stale entries in `existing`). When it's not (e.g. unit tests calling
    // the mapper directly), we fall back to whatever existing.jobTaxonomyList
    // had — callers that want the "clear stale IDs" behaviour must pass
    // `resolvedTaxonomyList: []` explicitly.
    const jobTaxonomyList = Array.isArray(resolvedTaxonomyList)
        ? resolvedTaxonomyList
        : (Array.isArray(base.jobTaxonomyList) ? base.jobTaxonomyList : []);

    return {
        ...base,
        // jobTitle is advisory free-text in JR — the actual role match
        // happens via jobTaxonomyList. JR rejects the whole filter (400)
        // when this string contains characters outside its accepted set
        // (we got bit by `R&D Engineer` — the `&` triggered the validator).
        // Two-pass cleanup:
        //   1. Prefer the resolved taxonomy titles when we have them —
        //      those are guaranteed to be in JR's vocabulary.
        //   2. Sanitise: replace `&` with `and`, strip everything outside
        //      [A-Za-z0-9 ,/.\-], collapse whitespace, cap to 80 chars.
        jobTitle: (() => {
            const sourceTitles =
                Array.isArray(jobTaxonomyList) && jobTaxonomyList.length
                    ? jobTaxonomyList.map((t) => t.title || '').filter(Boolean)
                    : roles;
            const joined = sourceTitles
                .slice(0, 4)
                .map((s) =>
                    String(s)
                        .replace(/&/g, ' and ')
                        .replace(/[^A-Za-z0-9 ,/.\-]/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim(),
                )
                .filter(Boolean)
                .join(', ');
            return joined.length > 80 ? `${joined.slice(0, 77)}...` : joined;
        })(),
        jobTaxonomyList,
        jobTypes: mapJobTypes(intent, base.jobTypes),
        country: mapCountry(intent),
        city: null,
        seniority: mapSeniority(intent),
        companyCategory,
        annualSalaryMinimum,
        isH1BOnly: mapH1BOnly(intent),
        roleType,
        skills,
        companyStages,
        excludedTitle,
        excludedCompanies,
        excludedSkills,
        excludeStaffingAgency,
        minYearsOfExperienceRange,
        daysAgo,
        companies,
        excludeCompanyCategory,
        excludeSecurityClearance,
        excludeUsCitizen,
        hiddenJobsOnly: base.hiddenJobsOnly ?? null,
        recommendationPreference: base.recommendationPreference ?? null,
        workModel: mapWorkModel(intent),
        locations: mapLocations(intent),
        radiusRange: DEFAULT_RADIUS_MILES,
    };
}
