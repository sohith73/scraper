// Admin routes — operator-facing controls for the shared JobRight session.
//
//   GET  /api/admin/session-status   probe without side effects
//   POST /api/admin/first-login      open a headed Chromium window and wait
//                                    (up to 5 min) for manual login
//   POST /api/admin/login            programmatic login using JR creds in env

import { Router } from 'express';
import { resultCodeToStatus } from './clients.js';
import { loginClient, probeClient } from '../playwright/clientSession.js';
import { storageDirFor } from '../playwright/clientBrowserPool.js';

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

    // POST /api/admin/client-login/:email
    //   { force?, headed? } — login the per-client JR account using stored
    //   credentials. Returns the same shape as /admin/login plus the
    //   storageDir so the UI can show "session at storage/clients/<slug>/".
    //   Stamps clientSettings with jrLastLoginAt + jrLastLoginOk for UI.
    router.post('/admin/client-login/:email', async (req, res, next) => {
        try {
            const email = decodeURIComponent(req.params.email || '').trim().toLowerCase();
            if (!email.includes('@')) {
                return respondErr(res, req, { code: 'BAD_INPUT', message: 'invalid email param' });
            }
            const { clientSettings, clientBrowsers, mutex, env, logger } = container;
            if (!clientSettings?.getCredentials) {
                return respondErr(res, req, { code: 'BAD_INPUT', message: 'credentials store unavailable' });
            }
            const creds = await clientSettings.getCredentials(email);
            if (!creds || !creds.jrEmail || !creds.jrPassword) {
                return respondErr(res, req, { code: 'NOT_FOUND', message: `no JR credentials saved for ${email}` });
            }
            const jrPassword = creds.jrPassword;
            const browserHandle = clientBrowsers.get(email);
            const force = req.body?.force === true;
            const headed = req.body?.headed === true;
            const r = await loginClient({
                browserHandle, mutex, env, logger,
                jrEmail: creds.jrEmail,
                jrPassword,
                force,
                headed,
            });
            // Always stamp the outcome — even on failure — so the UI's "last
            // login" indicator stays accurate.
            const storageDir = storageDirFor(env, email);
            await clientSettings.markLogin(email, {
                ok: r.ok && r.value?.action !== 'manual-login' ? true
                    : r.ok && r.value?.action === 'manual-login' ? true
                    : false,
                storageDir,
            }).catch(() => {});
            if (!r.ok) return respondErr(res, req, r.error);
            respondOk(res, req, { ...r.value, storageDir });
        } catch (e) {
            next(e);
        }
    });

    // GET /api/admin/client-login/:email/status — cheap probe in the
    // client's persistent context. Use this to decide if the UI should
    // show "logged in" or "needs login" without driving a fresh login.
    router.get('/admin/client-login/:email/status', async (req, res, next) => {
        try {
            const email = decodeURIComponent(req.params.email || '').trim().toLowerCase();
            if (!email.includes('@')) {
                return respondErr(res, req, { code: 'BAD_INPUT', message: 'invalid email param' });
            }
            const { clientBrowsers, mutex, env, logger } = container;
            const browserHandle = clientBrowsers.get(email);
            const r = await probeClient({ browserHandle, mutex, env, logger });
            if (!r.ok) return respondErr(res, req, r.error);
            respondOk(res, req, r.value);
        } catch (e) {
            next(e);
        }
    });

    return router;
}
