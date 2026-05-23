// POST /api/fetch-jd
//   body : { url: string }
//   200  : { ok:true, description, location, method, confidence, fieldSources, finalUrl, durationMs }
//   400  : BAD_INPUT
//   502  : NAV_TIMEOUT | EVAL_FAILED | NO_DATA | BROWSER_FAILURE | THIN_CONTENT
//
// Used by jr-direct-extension to enrich a JR/hiring.cafe pick with the JD
// + location pulled from the real job site (Greenhouse / Lever / Ashby /
// Workday / company-direct …). On any failure the extension falls back to
// the source-platform description.

import { Router } from 'express';
import { resultCodeToStatus } from './clients.js';

function respondOk(res, req, value, status = 200) {
    res.status(status).json({ success: true, requestId: req.id, ...value });
}
function respondErr(res, req, code, message, extras = {}) {
    res.status(resultCodeToStatus(code)).json({
        success: false,
        error: code,
        message,
        requestId: req.id,
        ...extras,
    });
}

export function fetchJdRouter({ container }) {
    if (!container?.jdFetcher?.fetchJobDetail) {
        throw new Error('fetchJdRouter: container.jdFetcher required');
    }
    const router = Router();

    router.post('/fetch-jd', async (req, res, next) => {
        const log = container.logger;
        try {
            const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
            if (!url) return respondErr(res, req, 'BAD_INPUT', 'url required');
            log?.info?.({ reqId: req.id, url }, 'fetch-jd: request');
            const r = await container.jdFetcher.fetchJobDetail(url);
            if (r.ok) {
                log?.info?.(
                    { reqId: req.id, url, method: r.method, descLen: r.description.length, durMs: r.durationMs },
                    'fetch-jd: ok',
                );
                return respondOk(res, req, r);
            }
            log?.warn?.(
                { reqId: req.id, url, error: r.error, message: r.message, durMs: r.durationMs },
                'fetch-jd: failed',
            );
            return respondErr(res, req, r.error || 'UNEXPECTED', r.message, {
                durationMs: r.durationMs,
                partial: r.partial,
            });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
