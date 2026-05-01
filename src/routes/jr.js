// Direct JR access endpoints for the browser extension.
//
// Single endpoint today: POST /api/jr/job-detail
//   body  : { jobId: string }                     // OR { jobUrl: string }
//   200   : { ok:true, applyLink, description, raw }
//   429   : COOLDOWN
//   401   : NEEDS_REAUTH
//   502   : NETWORK / HTTP_<status> / SCRAPER_ERROR
//   400   : BAD_INPUT / NO_APPLYLINK / NO_DESCRIPTION
//
// The extension picks a job, asks for the full JD via this endpoint, then
// pushes the returned blob directly to the dashboard. Centralising the
// fetch on the scraper means the extension never has to deal with cookie
// + hydration variance — the persistent Chromium context is reliably
// authenticated and identical across runs.

import { Router } from 'express';
import { scrapeJobDetail } from '../services/detail/index.js';
import { resultCodeToStatus } from './clients.js';

const JR_INFO_RX = /jobright\.ai\/jobs\/info\/([0-9a-f]{16,})/i;

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

export function jrRouter({ container }) {
    if (!container?.browser || !container?.mutex) {
        throw new Error('jrRouter: container.browser + container.mutex required');
    }
    const router = Router();

    router.post('/jr/job-detail', async (req, res, next) => {
        const t0 = Date.now();
        const log = container.logger;
        try {
            const { jobId: rawId, jobUrl } = req.body || {};
            let jobId = typeof rawId === 'string' ? rawId.trim() : '';
            const fromUrl = !jobId && typeof jobUrl === 'string' && jobUrl.match(JR_INFO_RX);
            if (fromUrl) jobId = fromUrl[1];
            log?.info?.(
                { reqId: req.id, jobId, fromUrl: !!fromUrl, ua: req.get?.('user-agent') || '', origin: req.get?.('origin') || '' },
                'jr/job-detail: request received',
            );
            if (!jobId) {
                log?.warn?.({ reqId: req.id, body: req.body }, 'jr/job-detail: BAD_INPUT (no jobId/jobUrl)');
                return respondErr(res, req, 'BAD_INPUT', 'jobId or jobUrl required');
            }
            const result = await scrapeJobDetail({
                browser: container.browser,
                mutex: container.mutex,
                env: container.env,
                logger: log,
                jobId,
                reqId: req.id,
            });
            const ms = Date.now() - t0;
            if (!result.ok) {
                log?.warn?.(
                    { reqId: req.id, jobId, code: result.error.code, message: result.error.message, ms },
                    'jr/job-detail: extraction failed',
                );
                return respondErr(res, req, result.error.code, result.error.message);
            }
            log?.info?.(
                {
                    reqId: req.id, jobId, ms,
                    descLen: result.value.description?.length || 0,
                    applyLink: result.value.applyLink,
                    title: result.value.raw?.title || '',
                    company: result.value.raw?.company || '',
                },
                'jr/job-detail: extraction OK',
            );
            respondOk(res, req, {
                jobId,
                applyLink: result.value.applyLink,
                description: result.value.description,
                raw: result.value.raw,
            });
        } catch (e) {
            const ms = Date.now() - t0;
            log?.error?.({ reqId: req.id, err: e.message, stack: e.stack, ms }, 'jr/job-detail: handler threw');
            next(e);
        }
    });

    return router;
}
