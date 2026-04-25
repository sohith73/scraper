// fetchJrJobByUrl
//
// Given a JobRight job URL like `https://jobright.ai/jobs/info/<jobId>`,
// open the page under our authenticated Playwright context + intercept
// the swan API responses the page fires while loading. Pluck the one
// whose body contains the jobId, normalise it through our existing
// adapter, and return the canonical Job.
//
// Why this approach:
//   - JR has no documented single-job endpoint; the page itself fetches
//     details via swan when the operator visits it.
//   - Intercepting the network response gives us the same JSON shape the
//     list endpoint returns, so we reuse `normalizeJobRightJob` instead
//     of writing a parallel DOM scraper.
//   - Falls back to a minimal DOM-scrape Job if the API response can't
//     be located within the timeout (defensive — JR could change the
//     page wiring at any time).

import { normalizeJobRightJob } from '../../adapters/jobright.js';
import { ok, err } from '../../clients/common/result.js';

const JOB_ID_RE = /\/jobs\/info\/([a-f0-9]{8,32})/i;
const SWAN_INTERCEPT_TIMEOUT_MS = 10_000;

// extractJobId: pulls the Mongo ObjectId out of a JR detail URL. Returns
// null when the input doesn't look like a JR URL — caller maps to BAD_INPUT.
export function extractJobId(url) {
    if (typeof url !== 'string' || !url.trim()) return null;
    const m = url.match(JOB_ID_RE);
    return m ? m[1].toLowerCase() : null;
}

// Walk an arbitrary JR response shape looking for an object that LOOKS
// like a job entry (has jobId === target). JR's page fetches return the
// job inside `result.jobResult` OR `result.jobList[]` OR similar — keep
// the search generic.
function findJobInBody(body, jobId) {
    if (!body || typeof body !== 'object') return null;
    const seen = new Set();
    const stack = [body];
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        // The shape we care about wraps the job JSON either directly OR
        // via a `jobResult` field. Both `normalizeJobRightJob` knows.
        const candidate = node.jobResult ? node : null;
        if (candidate?.jobResult?.jobId?.toLowerCase?.() === jobId) {
            return candidate;
        }
        // Some payloads embed the bare `jobResult` directly:
        if (node.jobId?.toLowerCase?.() === jobId && (node.jobTitle || node.jobNlpTitle)) {
            return { jobResult: node, companyResult: node.companyResult || null };
        }
        for (const v of Object.values(node)) {
            if (v && typeof v === 'object') stack.push(v);
        }
    }
    return null;
}

// fetchJrJobByUrl: fetch + normalise the JR job behind `url`.
//
// input  : { browser, session, env, url, logger? }
// output : Result<Job>  — error codes BAD_INPUT | NEEDS_REAUTH | NOT_FOUND
//                       | NETWORK | TIMEOUT
export async function fetchJrJobByUrl({ browser, session, env, url, logger = null }) {
    const jobId = extractJobId(url);
    if (!jobId) {
        return err('BAD_INPUT', `not a JR job URL — expected /jobs/info/<jobId>: ${url}`);
    }
    const probe = await session.probeSession();
    // probeSession returns Result<{ loggedIn, status, userInfo }>. Read
    // the inner value — earlier `probe.loggedIn` was always undefined and
    // every explain call returned NEEDS_REAUTH even with a live session.
    if (!probe?.ok || !probe.value?.loggedIn) {
        return err('NEEDS_REAUTH', 'JR session expired — re-login via /api/admin/login');
    }

    let captured = null;
    const targetUrl = `${env.JOBRIGHT_BASE.replace(/\/+$/, '')}/jobs/info/${jobId}`;
    try {
        await browser.withContext({}, async (context) => {
            const page = context.pages()[0] || (await context.newPage());
            const onResponse = async (resp) => {
                try {
                    if (!resp.url().includes('/swan/')) return;
                    const ct = resp.headers()['content-type'] || '';
                    if (!ct.includes('json')) return;
                    const body = await resp.json().catch(() => null);
                    const found = findJobInBody(body, jobId);
                    if (found) captured = found;
                } catch { /* swallow per-response errors */ }
            };
            page.on('response', onResponse);
            try {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
            } catch (e) {
                logger?.warn?.({ err: e.message }, 'fetchJrJobByUrl: page.goto failed');
            }
            // Wait for a relevant response. We don't care about the page
            // fully rendering — only that some swan call carrying the job
            // payload comes back.
            const start = Date.now();
            while (!captured && Date.now() - start < SWAN_INTERCEPT_TIMEOUT_MS) {
                await new Promise((r) => setTimeout(r, 250));
            }
            page.off('response', onResponse);
        });
    } catch (e) {
        return err('NETWORK', `failed to load job page: ${e.message}`);
    }

    if (!captured) {
        return err('NOT_FOUND', `JR did not surface job ${jobId} within ${SWAN_INTERCEPT_TIMEOUT_MS}ms`);
    }

    const job = normalizeJobRightJob(captured);
    if (!job) {
        return err('BAD_SHAPE', 'captured JR payload could not be normalised', { jobId });
    }
    return ok({ job, jobId });
}
