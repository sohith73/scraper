// getProfile: fetch a single client's onboarding profile by email.
//
// Why : the profile drives the AI-built search intent (Phase 5). Dashboard
//       exposes GET /get-profile?email=X → { message, userProfile:{...} } or
//       404 { message:"Profile not found" } when the client hasn't onboarded.
// Input  : { http, email }
// Output : Result<{ profile:object, removedJobsCount:number }>
//          error codes: 'NOT_FOUND' | 'BAD_STATUS' | 'BAD_SHAPE' | transport

import { ok, err } from '../common/result.js';
import { HttpError } from '../common/httpClient.js';

const GET_PROFILE_PATH = '/get-profile';

export async function getProfile({ http, email }) {
    if (typeof email !== 'string' || !email.includes('@')) {
        return err('BAD_INPUT', 'email is required and must be an address');
    }
    const qs = `?email=${encodeURIComponent(email.toLowerCase())}`;
    let res;
    try {
        res = await http.get(`${GET_PROFILE_PATH}${qs}`);
    } catch (e) {
        if (e instanceof HttpError) {
            return err(e.kind.toUpperCase(), e.message, { cause: e.cause });
        }
        throw e;
    }
    if (res.status === 404) {
        return err('NOT_FOUND', 'profile not onboarded for this email', { status: 404 });
    }
    // The HTTP client already retried 429s with backoff. Reaching this
    // branch means the dashboard kept rate-limiting us — surface that
    // distinctly so the run console shows "RATE_LIMITED" not "BAD_STATUS".
    if (res.status === 429) {
        return err('RATE_LIMITED', 'dashboard rate-limited (429); try again in a moment', {
            status: 429, bodyJson: res.bodyJson,
        });
    }
    if (res.status !== 200) {
        return err('BAD_STATUS', `unexpected status ${res.status}`, {
            status: res.status,
            bodyJson: res.bodyJson,
        });
    }
    const body = res.bodyJson;
    if (!body || !body.userProfile || typeof body.userProfile !== 'object') {
        return err('BAD_SHAPE', 'response missing userProfile object', { bodyJson: body });
    }
    const { removedJobsCount, ...profile } = body.userProfile;
    return ok({
        profile,
        removedJobsCount: typeof removedJobsCount === 'number' ? removedJobsCount : 0,
    });
}
