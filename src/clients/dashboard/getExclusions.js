// getExclusions: fetch the per-client exclusion lists (companies + locations).
//
// Why : the scraper does a pre-flight filter BEFORE pushing to /addjob so
//       the UI can show operators "X skipped as blocked" without hitting
//       the dashboard. The dashboard still enforces exclusions server-side;
//       this is a UX accelerator, not a security boundary.
// Input  : { http, email }
// Output : Result<{ excludedCompanies:string[], excludedLocations:string[] }>
//
// Controller: POST /operations/client-operations  body { clientEmail }
//             returns { success, clientOperations:{excludedCompanies, excludedLocations, ...} }
//             (exact envelope may vary — we read defensively.)

import { ok, err } from '../common/result.js';
import { HttpError } from '../common/httpClient.js';

const PATH = '/operations/client-operations';

// normaliseList: dashboard stores exclusions as strings in various cases.
// Lowercase + trim + dedupe so client code doesn't have to.
function normaliseList(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        const v = item.trim().toLowerCase();
        if (v) seen.add(v);
    }
    return [...seen];
}

export async function getExclusions({ http, email }) {
    if (typeof email !== 'string' || !email.includes('@')) {
        return err('BAD_INPUT', 'email is required');
    }
    let res;
    try {
        res = await http.postJson(PATH, { clientEmail: email.toLowerCase() });
    } catch (e) {
        if (e instanceof HttpError) {
            return err(e.kind.toUpperCase(), e.message, { cause: e.cause });
        }
        throw e;
    }
    if (res.status !== 200) {
        return err('BAD_STATUS', `unexpected status ${res.status}`, {
            status: res.status,
            bodyJson: res.bodyJson,
        });
    }
    const body = res.bodyJson || {};
    // The controller's envelope isn't stable across the codebase. Accept
    // both `body.clientOperations.*` and `body.result.*` and top-level.
    const source = body.clientOperations || body.result || body;
    return ok({
        excludedCompanies: normaliseList(source.excludedCompanies),
        excludedLocations: normaliseList(source.excludedLocations),
    });
}
