// getResumeByEmail: fetch the optimized/base resume for a client.
//
// Why : the Phase 5 profile summariser optionally feeds the resume JSON into
//       the gpt-4o-mini prompt to improve the search-intent quality. If no
//       resume is assigned to this email, we must NOT fail — profile alone
//       is sufficient. So "not found" is a first-class success shape.
//
// Endpoint (verified 2026-04-23):
//   POST {RESUME_BASE}/api/resume-by-email
//   body: { email }
//   200 : flat resume JSON (personalInfo, summary, workExperience, skills,
//         education, projects, leadership, publications — plus checkboxStates,
//         sectionOrder, V, resumeId, firstName, lastName)
//   400 : { error: "Email is required" }
//   404 : { error: "No resume assigned to this user" } OR
//         { error: "Resume file missing" }
//   500 : { error: "Failed to get resume" }
//
// Input  : { http, email }
// Output : Result<{ found:true, resume:object, resumeId:string, V:number }
//                | { found:false, reason:'no-resume'|'file-missing' }>
//          error codes: 'BAD_INPUT' | 'BAD_STATUS' | 'BAD_SHAPE' | transport

import { ok, err } from '../common/result.js';
import { HttpError } from '../common/httpClient.js';

const PATH = '/api/resume-by-email';

export async function getResumeByEmail({ http, email }) {
    if (typeof email !== 'string' || !email.includes('@')) {
        return err('BAD_INPUT', 'email is required');
    }
    let res;
    try {
        res = await http.postJson(PATH, { email: email.toLowerCase() });
    } catch (e) {
        if (e instanceof HttpError) {
            return err(e.kind.toUpperCase(), e.message, { cause: e.cause });
        }
        throw e;
    }

    if (res.status === 404) {
        const reason = /file missing/i.test(res.bodyJson?.error || '')
            ? 'file-missing'
            : 'no-resume';
        return ok({ found: false, reason });
    }

    if (res.status !== 200) {
        return err('BAD_STATUS', `unexpected status ${res.status}`, {
            status: res.status,
            bodyJson: res.bodyJson,
        });
    }

    const body = res.bodyJson;
    if (!body || typeof body !== 'object') {
        return err('BAD_SHAPE', 'response was not an object', { bodyJson: body });
    }

    // Resume content lives at the top level — split out metadata from the
    // opaque resume object so callers don't re-derive it.
    const { resumeId, V, checkboxStates, sectionOrder, firstName, lastName, ...resume } = body;

    return ok({
        found: true,
        resume,
        meta: {
            resumeId: typeof resumeId === 'string' ? resumeId : '',
            version: typeof V === 'number' ? V : 0,
            firstName: typeof firstName === 'string' ? firstName : '',
            lastName: typeof lastName === 'string' ? lastName : '',
            checkboxStates: checkboxStates || null,
            sectionOrder: Array.isArray(sectionOrder) ? sectionOrder : [],
        },
    });
}
