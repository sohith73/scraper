// updateExclusions: sync excluded companies + locations for a client.
//
// Why : operators can edit the exclusion lists in the scraper UI; those
//       edits must land in the dashboard's ClientOperationsModel so every
//       future run (scraper OR dashboard-native) honours them. The
//       dashboard endpoint is PUT /operations/client-operations; we pass
//       the full arrays each time (server replaces, doesn't append).
//
// Input  : { http, email, companies, locations, operatorName? }
// Output : Result<{ excludedCompanies, excludedLocations }>

import { ok, err } from '../common/result.js';
import { HttpError } from '../common/httpClient.js';

const PATH = '/operations/client-operations';

function normaliseList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
        if (typeof item !== 'string') continue;
        const v = item.trim();
        const key = v.toLowerCase();
        if (!v || seen.has(key)) continue;
        seen.add(key);
        out.push(v);
    }
    return out;
}

export async function updateExclusions({
    http,
    email,
    companies = [],
    locations = [],
    operatorName = 'JobRightScraper',
} = {}) {
    if (typeof email !== 'string' || !email.includes('@')) {
        return err('BAD_INPUT', 'email is required');
    }
    const body = {
        clientEmail: email.toLowerCase(),
        excludedCompanies: normaliseList(companies),
        excludedLocations: normaliseList(locations),
        operatorName,
    };
    let res;
    try {
        res = await http.putJson(PATH, body);
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
    return ok({
        excludedCompanies: body.excludedCompanies,
        excludedLocations: body.excludedLocations,
    });
}
