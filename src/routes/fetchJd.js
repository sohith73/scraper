// POST /api/fetch-jd
// POST /api/extract/infor
// GET  /extract/infor=<encoded job url>
//   body : { url: string }
//   200  : { ok:true, mainJd, description, country, location, provider, method, confidence, fieldSources, finalUrl, durationMs }
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

    async function handleExtract(req, res, next, rawUrl) {
        const log = container.logger;
        try {
            const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
            if (!url) return respondErr(res, req, 'BAD_INPUT', 'url required');
            log?.info?.(
                {
                    reqId: req.id,
                    url,
                    route: req.originalUrl || req.url,
                    origin: req.get?.('origin') || '',
                    ua: req.get?.('user-agent') || '',
                },
                'extract/infor: request',
            );
            const r = await container.jdFetcher.fetchJobDetail(url);
            if (r.ok) {
                log?.info?.(
                    {
                        reqId: req.id,
                        url,
                        provider: r.provider,
                        method: r.method,
                        country: r.country || '',
                        location: r.location || '',
                        title: r.title || '',
                        company: r.company || '',
                        descLen: r.description.length,
                        durMs: r.durationMs,
                    },
                    'extract/infor: ok',
                );
                return respondOk(res, req, {
                    ok: true,
                    ...r,
                    jobDescription: r.description,
                    mainJd: r.mainJd || r.description,
                });
            }
            log?.warn?.(
                { reqId: req.id, url, error: r.error, message: r.message, durMs: r.durationMs },
                'extract/infor: failed',
            );
            return respondErr(res, req, r.error || 'UNEXPECTED', r.message, {
                durationMs: r.durationMs,
                partial: r.partial,
            });
        } catch (err) {
            next(err);
        }
    }

    router.post('/fetch-jd', async (req, res, next) => {
        const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
        return handleExtract(req, res, next, url);
    });

    // POST /api/fetch-jd/batch  { urls: string[] }
    //   200 : { success:true, results: { <url>: <result>, ... }, counts }
    // Each result mirrors the single-URL shape (ok / description / country /
    // location / provider / tier / error …). Tier-0 (HTTP/JSON-LD) URLs are
    // resolved at high concurrency; only browser-tier misses queue on the
    // Chromium semaphore. One bad URL never sinks the batch.
    router.post('/fetch-jd/batch', async (req, res, next) => {
        const log = container.logger;
        try {
            if (!container.jdFetcher.fetchJobDetailBatch) {
                return respondErr(res, req, 'UNEXPECTED', 'batch not supported');
            }
            const urls = Array.isArray(req.body?.urls) ? req.body.urls : null;
            if (!urls || !urls.length) {
                return respondErr(res, req, 'BAD_INPUT', 'urls[] required');
            }
            const t0 = Date.now();
            const results = await container.jdFetcher.fetchJobDetailBatch(urls);
            const vals = Object.values(results);
            const counts = {
                requested: urls.length,
                returned: vals.length,
                ok: vals.filter((r) => r && r.ok).length,
                http: vals.filter((r) => r && r.tier === 'http').length,
                browser: vals.filter((r) => r && r.tier === 'browser').length,
                cached: vals.filter((r) => r && r.cached).length,
            };
            // Normalise each ok result so the extension reads the same field
            // names as the single endpoint (jobDescription / mainJd).
            for (const [url, r] of Object.entries(results)) {
                if (r && r.ok) {
                    results[url] = { ...r, jobDescription: r.description, mainJd: r.mainJd || r.description };
                }
            }
            log?.info?.({ reqId: req.id, ...counts, durMs: Date.now() - t0 }, 'fetch-jd/batch: done');
            return respondOk(res, req, { ok: true, results, counts, durationMs: Date.now() - t0 });
        } catch (err) {
            next(err);
        }
    });

    router.post('/extract/infor', async (req, res, next) => {
        const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
        return handleExtract(req, res, next, url);
    });

    router.get(/^\/extract\/infor=(.+)$/i, async (req, res, next) => {
        const encoded = req.params?.[0] || '';
        let url = encoded;
        try {
            url = decodeURIComponent(encoded);
        } catch {
            // Keep the raw segment; fetchJobDetail will validate it.
        }
        return handleExtract(req, res, next, url);
    });

    return router;
}
