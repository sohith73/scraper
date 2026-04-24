// Admin routes — operator-facing controls for the shared JobRight session.
//
//   GET  /api/admin/session-status   probe without side effects
//   POST /api/admin/first-login      open a headed Chromium window and wait
//                                    (up to 5 min) for manual login
//   POST /api/admin/login            programmatic login using JR creds in env

import { Router } from 'express';
import { resultCodeToStatus } from './clients.js';

function respondOk(res, req, value, status = 200) {
    res.status(status).json({ success: true, requestId: req.id, ...value });
}
function respondErr(res, req, error) {
    const status = resultCodeToStatus(error.code);
    res.status(status).json({
        success: false,
        error: error.code,
        message: error.message,
        requestId: req.id,
    });
}

export function adminRouter({ container }) {
    if (!container?.session) {
        throw new Error('adminRouter: container.session is required');
    }
    const router = Router();

    // GET /api/admin/session-status
    router.get('/admin/session-status', async (req, res, next) => {
        try {
            const r = await container.session.probeSession();
            if (!r.ok) return respondErr(res, req, r.error);
            respondOk(res, req, r.value);
        } catch (e) {
            next(e);
        }
    });

    // POST /api/admin/login — programmatic login using env credentials.
    // Returns LOGIN_FAILED / NEEDS_REAUTH if env creds are missing or JR
    // rejects the attempt.
    router.post('/admin/login', async (req, res, next) => {
        try {
            const force = req.body?.force === true;
            const r = await container.session.ensureLoggedIn({ headed: false, force });
            if (!r.ok) return respondErr(res, req, r.error);
            respondOk(res, req, r.value);
        } catch (e) {
            next(e);
        }
    });

    // POST /api/admin/first-login — opens a HEADED browser. This blocks the
    // request up to 5 minutes while the operator completes login. Use once
    // per machine (or whenever JR kills the session).
    router.post('/admin/first-login', async (req, res, next) => {
        try {
            const r = await container.session.ensureLoggedIn({
                headed: true,
                force: true,
            });
            if (!r.ok) return respondErr(res, req, r.error);
            respondOk(res, req, r.value);
        } catch (e) {
            next(e);
        }
    });

    return router;
}
