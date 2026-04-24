// Routes for the three operator-facing read endpoints + the summary trigger.
//
//   GET  /api/clients                    -> list all clients
//   GET  /api/clients/:email/profile     -> profile + exclusions for one client
//   POST /api/clients/:email/summary     -> build an AI SearchIntent
//
// Every handler converts a `Result<T,E>` into an HTTP response via a single
// mapper (`resultToResponse`). This keeps status codes consistent across
// the API surface and centralises the error-code → HTTP-status policy.

import { Router } from 'express';

// resultCodeToStatus: the single source of truth for mapping our internal
// domain codes onto HTTP status. When adding a new error code anywhere in
// the codebase, add it here too.
const CODE_TO_STATUS = {
    BAD_INPUT: 400,
    NOT_FOUND: 404,
    DUPLICATE: 409,
    BLOCKED_COMPANY: 403,
    BLOCKED_LOCATION: 403,
    CLIENT_LOCKED: 403,
    AUTH: 401,
    RATE_LIMITED: 429,
    RESUME_MISSING: 422,
    TIMEOUT: 504,
    NETWORK: 502,
    SERVER_ERROR: 502,
    BAD_SHAPE: 502,
    BAD_JSON: 502,
    BAD_STATUS: 502,
    NO_OPENAI_KEY: 503,
};

export function resultCodeToStatus(code) {
    return CODE_TO_STATUS[code] ?? 500;
}

// respond: write a JSON response for a successful Result value.
function respondOk(res, req, value, status = 200) {
    res.status(status).json({ success: true, requestId: req.id, ...value });
}

// respondErr: write a JSON response for a failed Result.
function respondErr(res, req, error) {
    const status = resultCodeToStatus(error.code);
    res.status(status).json({
        success: false,
        error: error.code,
        message: error.message,
        requestId: req.id,
    });
}

// decodeEmailParam: Express decodes %XX for path params automatically, but
// we still normalise (lowercase + trim) and run a minimal sanity check.
function decodeEmailParam(raw) {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase();
    if (!v || !v.includes('@') || v.length > 254) return null;
    return v;
}

// clientsRouter: factory — takes the already-built service container so we
// can inject fakes in tests.
// input  : { container:{ dashboard, resume, summariser, logger } }
// output : Express.Router
export function clientsRouter({ container }) {
    if (!container?.dashboard) {
        throw new Error('clientsRouter: container.dashboard is required');
    }
    const router = Router();

    // GET /api/clients — returns { clients:[], count }
    router.get('/clients', async (req, res, next) => {
        try {
            const r = await container.dashboard.listClients();
            if (!r.ok) return respondErr(res, req, r.error);
            respondOk(res, req, r.value);
        } catch (e) {
            next(e);
        }
    });

    // GET /api/clients/:email/profile — returns { profile, exclusions, removedJobsCount }
    router.get('/clients/:email/profile', async (req, res, next) => {
        try {
            const email = decodeEmailParam(req.params.email);
            if (!email) {
                return respondErr(res, req, {
                    code: 'BAD_INPUT',
                    message: 'invalid email param',
                });
            }
            const [profileRes, exclusionsRes] = await Promise.all([
                container.dashboard.getProfile(email),
                container.dashboard.getExclusions(email),
            ]);
            if (!profileRes.ok) return respondErr(res, req, profileRes.error);
            // Exclusions are best-effort — a failure here shouldn't hide the profile.
            const exclusions = exclusionsRes.ok
                ? exclusionsRes.value
                : { excludedCompanies: [], excludedLocations: [] };
            respondOk(res, req, {
                profile: profileRes.value.profile,
                removedJobsCount: profileRes.value.removedJobsCount,
                exclusions,
            });
        } catch (e) {
            next(e);
        }
    });

    // PUT /api/clients/:email/exclusions — edit the dashboard-side
    // ClientOperationsModel exclusion lists. Proxies to dashboard's
    // PUT /operations/client-operations — single source of truth, so the
    // change takes effect for every future scrape AND any dashboard-native
    // flow. Operator name hard-coded to 'JobRightScraper' for audit trail.
    router.put('/clients/:email/exclusions', async (req, res, next) => {
        try {
            const email = decodeEmailParam(req.params.email);
            if (!email) {
                return respondErr(res, req, {
                    code: 'BAD_INPUT',
                    message: 'invalid email param',
                });
            }
            const { companies = [], locations = [] } = req.body || {};
            const r = await container.dashboard.updateExclusions({
                email,
                companies,
                locations,
            });
            if (!r.ok) return respondErr(res, req, r.error);
            respondOk(res, req, r.value);
        } catch (e) {
            next(e);
        }
    });

    // GET /api/clients/:email/filters — read last-saved filter record.
    router.get('/clients/:email/filters', async (req, res, next) => {
        try {
            const email = decodeEmailParam(req.params.email);
            if (!email) {
                return respondErr(res, req, {
                    code: 'BAD_INPUT',
                    message: 'invalid email param',
                });
            }
            if (!container.clientFilters) {
                return respondOk(res, req, { record: null });
            }
            const record = await container.clientFilters.get(email);
            respondOk(res, req, { record });
        } catch (e) {
            next(e);
        }
    });

    // PUT /api/clients/:email/filters — operator-saved override record.
    // Lets the UI persist Advanced-Filter tweaks without running a scrape.
    router.put('/clients/:email/filters', async (req, res, next) => {
        try {
            const email = decodeEmailParam(req.params.email);
            if (!email) {
                return respondErr(res, req, {
                    code: 'BAD_INPUT',
                    message: 'invalid email param',
                });
            }
            if (!container.clientFilters) {
                return respondErr(res, req, {
                    code: 'BAD_INPUT',
                    message: 'client filter store unavailable',
                });
            }
            const { intent = null, overrides = null } = req.body || {};
            const record = await container.clientFilters.put(email, {
                intent,
                overrides,
                meta: { source: 'operator' },
            });
            respondOk(res, req, { record });
        } catch (e) {
            next(e);
        }
    });

    // ---- Feedback (Phase-2: per-client few-shot calibration) --------

    // GET /api/clients/:email/feedback — full feedback log.
    router.get('/clients/:email/feedback', async (req, res, next) => {
        try {
            const email = decodeEmailParam(req.params.email);
            if (!email) {
                return respondErr(res, req, {
                    code: 'BAD_INPUT',
                    message: 'invalid email param',
                });
            }
            if (!container.feedback) return respondOk(res, req, { entries: [] });
            const entries = await container.feedback.list(email);
            respondOk(res, req, { entries });
        } catch (e) {
            next(e);
        }
    });

    // POST /api/clients/:email/feedback — record one thumbs-up / down event.
    router.post('/clients/:email/feedback', async (req, res, next) => {
        try {
            const email = decodeEmailParam(req.params.email);
            if (!email) {
                return respondErr(res, req, {
                    code: 'BAD_INPUT',
                    message: 'invalid email param',
                });
            }
            if (!container.feedback) {
                return respondErr(res, req, {
                    code: 'BAD_INPUT',
                    message: 'feedback store unavailable',
                });
            }
            const entry = await container.feedback.append(email, req.body || {});
            respondOk(res, req, { entry }, 201);
        } catch (e) {
            if (/verdict must be/.test(e.message) || /valid email/.test(e.message)) {
                return respondErr(res, req, { code: 'BAD_INPUT', message: e.message });
            }
            next(e);
        }
    });

    // DELETE /api/clients/:email/feedback/:entryId — undo a prior event.
    router.delete('/clients/:email/feedback/:entryId', async (req, res, next) => {
        try {
            const email = decodeEmailParam(req.params.email);
            if (!email) {
                return respondErr(res, req, {
                    code: 'BAD_INPUT',
                    message: 'invalid email param',
                });
            }
            if (!container.feedback) return respondOk(res, req, { removed: false });
            const removed = await container.feedback.remove(email, req.params.entryId);
            respondOk(res, req, { removed });
        } catch (e) {
            next(e);
        }
    });

    // DELETE /api/clients/:email/filters — forget the saved record.
    router.delete('/clients/:email/filters', async (req, res, next) => {
        try {
            const email = decodeEmailParam(req.params.email);
            if (!email) {
                return respondErr(res, req, {
                    code: 'BAD_INPUT',
                    message: 'invalid email param',
                });
            }
            if (!container.clientFilters) {
                return respondOk(res, req, { removed: false });
            }
            const removed = await container.clientFilters.remove(email);
            respondOk(res, req, { removed });
        } catch (e) {
            next(e);
        }
    });

    // POST /api/clients/:email/summary — build + return SearchIntent
    router.post('/clients/:email/summary', async (req, res, next) => {
        try {
            const email = decodeEmailParam(req.params.email);
            if (!email) {
                return respondErr(res, req, {
                    code: 'BAD_INPUT',
                    message: 'invalid email param',
                });
            }
            const profileRes = await container.dashboard.getProfile(email);
            if (!profileRes.ok) return respondErr(res, req, profileRes.error);

            // Fetch exclusions + resume in parallel. Exclusions are critical
            // for correctness; resume is an AI-quality nice-to-have.
            const [exclusionsRes, resumeRes] = await Promise.all([
                container.dashboard.getExclusions(email),
                container.resume.getByEmail(email),
            ]);

            const exclusions = exclusionsRes.ok
                ? {
                      companies: exclusionsRes.value.excludedCompanies,
                      locations: exclusionsRes.value.excludedLocations,
                  }
                : { companies: [], locations: [] };

            const resume =
                resumeRes.ok && resumeRes.value.found ? resumeRes.value.resume : null;

            // Resume is MANDATORY for summarising. A summary built without
            // a resume often drifts — AI has to guess at roles/skills from
            // sparse onboarding data, and relevance filtering downstream
            // picks random jobs. Fail loudly so the operator attaches the
            // resume via gemini-resume before scraping.
            if (!resume) {
                const base = container.env?.RESUME_BASE || 'gemini-resume';
                return respondErr(res, req, {
                    code: 'RESUME_MISSING',
                    message: `No resume attached for this client. Attach one in gemini-resume (${base}) before building the summary.`,
                });
            }

            const summaryRes = await container.summariser({
                profile: profileRes.value.profile,
                resume,
                exclusions,
                clientEmail: email,
            });
            if (!summaryRes.ok) return respondErr(res, req, summaryRes.error);

            respondOk(res, req, {
                intent: summaryRes.value.intent,
                cacheHit: summaryRes.value.cacheHit,
                resumeFound: resumeRes.ok && resumeRes.value.found === true,
            });
        } catch (e) {
            next(e);
        }
    });

    return router;
}
