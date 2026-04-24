// Preflight — local filtering before we hit the dashboard backend.
//
// The backend is the authority on exclusions + duplicates (see
// CheckForDuplicateJobs middleware + exclusionGuard). Preflight is a
// latency optimisation: we snapshot the exclusion lists once at run-start
// and throw away obviously-blocked jobs locally so the operator sees them
// as "skipped (blocked)" without the UI spinning on N round-trips.
//
// Canonical exclusion source: `getExclusions({email})` already lowercases
// + dedupes the lists we compare against.

import { ok, err } from '../../clients/common/result.js';

// normalise: lowercase + trim — matches the convention used by
// getExclusions and CheckForDuplicateJobs (which regex-matches
// case-insensitively server-side).
const normalise = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

// isExcludedCompany: a partial-match rule mirrors exclusionGuard's server
// behaviour — "Acme Corp" is blocked if the list contains "acme".
function isExcludedCompany(companyName, excludedCompanies) {
    const c = normalise(companyName);
    if (!c) return false;
    return excludedCompanies.some((ex) => ex && c.includes(ex));
}

// isExcludedLocation: same partial-match semantics.
function isExcludedLocation(location, excludedLocations) {
    const l = normalise(location);
    if (!l) return false;
    return excludedLocations.some((ex) => ex && l.includes(ex));
}

// dupKey: how we identify "same job" locally. The backend middleware uses
// (userID + jobTitle + companyName) so we match that.
function dupKey(title, company) {
    return `${normalise(title)}\x1f${normalise(company)}`;
}

// runPreflight: partition jobs into `pushable` vs `blocked` for reasons
// the scraper can decide without a round-trip.
//
// input  : { jobs, exclusions, existingJobs?, logger? }
//   jobs          canonical Job[]
//   exclusions    { companies:[], locations:[] } — lowercase, from getExclusions
//   existingJobs  optional [{jobTitle, companyName}] — client's currently-
//                 tracked jobs; lets us pre-dedupe against them
// output : Result<{
//            pushable: Job[],
//            filtered: [{ job, code, reason }],
//            stats: { total, pushable, blockedCompany, blockedLocation, localDuplicate }
//          }>
//
// Codes on each filtered entry:
//   BLOCKED_COMPANY | BLOCKED_LOCATION | LOCAL_DUPLICATE
export function runPreflight({
    jobs,
    exclusions = { companies: [], locations: [] },
    existingJobs = [],
    logger = null,
} = {}) {
    if (!Array.isArray(jobs)) {
        return err('BAD_INPUT', 'jobs must be an array');
    }

    const excludedCompanies = Array.isArray(exclusions.companies)
        ? exclusions.companies.map(normalise).filter(Boolean)
        : [];
    const excludedLocations = Array.isArray(exclusions.locations)
        ? exclusions.locations.map(normalise).filter(Boolean)
        : [];

    const knownKeys = new Set(
        (Array.isArray(existingJobs) ? existingJobs : [])
            .map((j) => dupKey(j?.jobTitle, j?.companyName))
            .filter((k) => k !== '\x1f'),
    );

    const pushable = [];
    const filtered = [];
    const runKeys = new Set();

    for (const job of jobs) {
        // Defensive: a null or malformed job should be a skip, not a throw.
        if (!job || typeof job !== 'object' || !job.id) {
            filtered.push({
                job,
                code: 'LOCAL_DUPLICATE',
                reason: 'invalid job object',
            });
            continue;
        }

        if (isExcludedCompany(job.companyName, excludedCompanies)) {
            filtered.push({
                job,
                code: 'BLOCKED_COMPANY',
                reason: `company "${job.companyName}" matches exclusion list`,
            });
            continue;
        }
        if (isExcludedLocation(job.jobLocation, excludedLocations)) {
            filtered.push({
                job,
                code: 'BLOCKED_LOCATION',
                reason: `location "${job.jobLocation}" matches exclusion list`,
            });
            continue;
        }

        const key = dupKey(job.title, job.companyName);
        if (knownKeys.has(key)) {
            filtered.push({
                job,
                code: 'LOCAL_DUPLICATE',
                reason: 'already present in client tracker',
            });
            continue;
        }
        // Within-run dedupe — JR occasionally repeats jobs across pagination.
        if (runKeys.has(key)) {
            filtered.push({
                job,
                code: 'LOCAL_DUPLICATE',
                reason: 'duplicate within this run',
            });
            continue;
        }
        runKeys.add(key);
        pushable.push(job);
    }

    logger?.debug?.(
        {
            total: jobs.length,
            pushable: pushable.length,
            blocked: filtered.length,
        },
        'runPreflight: partition complete',
    );

    const statsByCode = {
        BLOCKED_COMPANY: 0,
        BLOCKED_LOCATION: 0,
        LOCAL_DUPLICATE: 0,
    };
    for (const f of filtered) statsByCode[f.code] = (statsByCode[f.code] || 0) + 1;

    return ok({
        pushable,
        filtered,
        stats: {
            total: jobs.length,
            pushable: pushable.length,
            blockedCompany: statsByCode.BLOCKED_COMPANY,
            blockedLocation: statsByCode.BLOCKED_LOCATION,
            localDuplicate: statsByCode.LOCAL_DUPLICATE,
        },
    });
}
