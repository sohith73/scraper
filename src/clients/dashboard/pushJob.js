// pushJob: ingest one scraped job into the dashboard on behalf of a client.
//
// Why : final step of the scraper pipeline. The dashboard's POST /addjob
//       runs CheckForDuplicateJobs -> AddJob -> exclusionGuard, so we get
//       dedupe + exclusion enforcement server-side for free. We just need
//       to classify the outcome into stable codes the UI can render.
//
// Input  : { http, job, clientEmail, clientName?, dryRun? }
//          where `job` is our canonical shape:
//             { jobTitle, companyName, jobLocation, jobDescription, joblink }
// Output : Result<{ createdJobId:string } |
//                 { outcome:'duplicate' } |
//                 { outcome:'dry-run', payload }>
//          error codes:
//             'BLOCKED_COMPANY' | 'BLOCKED_LOCATION' | 'CLIENT_LOCKED' |
//             'DUPLICATE' (also surfaces as success with outcome:'duplicate'
//             so the pipeline can count it) | 'BAD_INPUT' | transport errors
//
// Payload shape the dashboard's AddJob.js expects (verified 2026-04-23):
//   { jobDetails: { userID, jobTitle, companyName, jobLocation,
//                   jobDescription, joblink },
//     userDetails: { email, name },
//     role: 'operations',
//     operationsEmail: 'scraper@flashfirehq',
//     operationsName: 'JobRightScraper' }

import { ok, err } from '../common/result.js';
import { HttpError } from '../common/httpClient.js';

const PATH = '/addjob';

const OPERATOR_EMAIL = 'scraper@flashfirehq';
const OPERATOR_NAME = 'JobRightScraper';

function validateJob(job) {
    if (!job || typeof job !== 'object') return 'job must be an object';
    if (!job.jobTitle || typeof job.jobTitle !== 'string') return 'job.jobTitle is required';
    if (!job.companyName || typeof job.companyName !== 'string') return 'job.companyName is required';
    if (!job.joblink || typeof job.joblink !== 'string') return 'job.joblink is required';
    return null;
}

// buildPayload: exported so tests + DRY_RUN mode can inspect the exact
// bytes we would POST without executing.
export function buildPushJobPayload({ job, clientEmail, clientName = '' }) {
    const email = String(clientEmail).toLowerCase();
    return {
        jobDetails: {
            userID: email,
            jobTitle: String(job.jobTitle).slice(0, 50),
            companyName: String(job.companyName).trim(),
            jobLocation: job.jobLocation ? String(job.jobLocation).trim() : '',
            jobDescription: job.jobDescription ? String(job.jobDescription) : '',
            joblink: String(job.joblink),
        },
        userDetails: {
            email,
            name: clientName || email,
        },
        role: 'operations',
        operationsEmail: OPERATOR_EMAIL,
        operationsName: OPERATOR_NAME,
    };
}

export async function pushJob({ http, job, clientEmail, clientName, dryRun = false }) {
    if (!clientEmail || typeof clientEmail !== 'string' || !clientEmail.includes('@')) {
        return err('BAD_INPUT', 'clientEmail is required');
    }
    const invalidReason = validateJob(job);
    if (invalidReason) return err('BAD_INPUT', invalidReason);

    const payload = buildPushJobPayload({ job, clientEmail, clientName });

    if (dryRun) {
        return ok({ outcome: 'dry-run', payload });
    }

    let res;
    try {
        res = await http.postJson(PATH, payload);
    } catch (e) {
        if (e instanceof HttpError) {
            return err(e.kind.toUpperCase(), e.message, { cause: e.cause });
        }
        throw e;
    }

    const body = res.bodyJson || {};

    // Success path.
    if (res.status === 200) {
        const createdJobId =
            typeof body.createdJobId === 'string' ? body.createdJobId : null;
        if (!createdJobId) {
            return err('BAD_SHAPE', '200 without createdJobId', { bodyJson: body });
        }
        return ok({ outcome: 'created', createdJobId });
    }

    // Known 403 variants — interpret via `error` code or `message` text.
    if (res.status === 403) {
        const code = body.error;
        if (code === 'BLOCKED_COMPANY' || code === 'BLOCKED_LOCATION') {
            return err(code, body.message || code, { status: 403, bodyJson: body });
        }
        // CheckForDuplicateJobs middleware uses `message: 'Job Already Exist  !'`
        // WITHOUT a stable `error` code, so text-match.
        if (typeof body.message === 'string' && /already exist/i.test(body.message)) {
            return ok({ outcome: 'duplicate' });
        }
        // ClientLocked path uses 403 with no standard error code — pattern-match.
        if (typeof body.message === 'string' && /lock/i.test(body.message)) {
            return err('CLIENT_LOCKED', body.message, { status: 403, bodyJson: body });
        }
        return err('BAD_STATUS', body.message || 'forbidden', {
            status: 403,
            bodyJson: body,
        });
    }

    if (res.status === 400) {
        return err('BAD_INPUT', body.message || 'bad request', {
            status: 400,
            bodyJson: body,
        });
    }

    return err('BAD_STATUS', `unexpected status ${res.status}`, {
        status: res.status,
        bodyJson: body,
    });
}
