// JobRight session management.
//
// Two operations the rest of the scraper needs:
//
//   probeSession({ fetchImpl })
//     Hits /swan/auth/newinfo via the browser's cookie jar. Returns
//     { loggedIn: boolean, status, userInfo?: {} }.
//
//   ensureLoggedIn({ headed, force })
//     Serialised under a mutex. Probes first; if logged-in returns early.
//     Otherwise drives the login form using JOBRIGHT_EMAIL / JOBRIGHT_PASSWORD
//     and confirms the post-login redirect.
//
// Everything is expressed in terms of `browser.withContext(opts, fn)` so the
// singleton lifecycle is not this module's concern.

import { ok, err } from '../clients/common/result.js';

const LOGIN_URL = 'https://jobright.ai/';
const POST_LOGIN_REGEX = /\/jobs\/recommend/;
const SESSION_PROBE_PATH = '/swan/auth/newinfo';

// probeViaPage: uses the browser's in-page fetch so session cookies are
// included automatically. Returns a flat { loggedIn, status } shape.
//
// NOTE: fetches from `about:blank` are blocked by the browser's same-origin
// and secure-context gates, so we always navigate to JR first if we're
// still on about:blank. Subsequent calls reuse the loaded page.
async function probeViaPage(page, env) {
    const base = env.JOBRIGHT_BASE.replace(/\/+$/, '');
    if (!page.url() || page.url().startsWith('about:')) {
        await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    const url = `${base}${SESSION_PROBE_PATH}`;
    const result = await page.evaluate(async (u) => {
        try {
            const r = await fetch(u, { credentials: 'include' });
            const text = await r.text();
            let body = null;
            try {
                body = JSON.parse(text);
            } catch {
                /* ignore */
            }
            return { status: r.status, body };
        } catch (e) {
            return { status: 0, body: null, error: String(e) };
        }
    }, url);

    // `/swan/auth/newinfo` ALWAYS returns 200 with a populated `result`
    // object — even when anonymous — distinguishing auth state via the
    // `result.logined` boolean and a populated `userId`. Don't trust just
    // "result !== null"; check the explicit logged-in flag.
    const body = result.body;
    const res = body?.result;
    const loggedIn =
        result.status === 200 &&
        body?.success === true &&
        res !== null &&
        res !== undefined &&
        (res.logined === true ||
            (typeof res.userId === 'string' && res.userId.length > 0));
    return {
        loggedIn,
        status: result.status,
        userInfo: loggedIn ? res : null,
    };
}

// performLoginViaApi: post credentials directly to /swan/auth/login/pwd
// from inside the page context. Cookies land in the persistent profile
// automatically (same-origin fetch with credentials). Bypasses all form
// interaction so it is far less fingerprint-visible than driving clicks.
//
// Input  : page, { email, password, env, logger }
// Throws : Error with a descriptive message on non-200 / success:false
async function performLoginViaApi(page, { email, password, env, logger }) {
    const base = env.JOBRIGHT_BASE.replace(/\/+$/, '');
    if (!page.url() || page.url().startsWith('about:')) {
        await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    logger?.debug?.('login(api): posting /swan/auth/login/pwd');

    const result = await page.evaluate(
        async ({ u, e, p }) => {
            try {
                const r = await fetch(`${u}/swan/auth/login/pwd`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ email: e, password: p }),
                });
                const text = await r.text();
                let body = null;
                try {
                    body = JSON.parse(text);
                } catch {
                    /* ignore */
                }
                return { status: r.status, body, bodyText: text.slice(0, 300) };
            } catch (err) {
                return { status: 0, body: null, error: String(err) };
            }
        },
        { u: base, e: email, p: password },
    );

    if (result.status !== 200) {
        throw new Error(
            `login POST returned ${result.status}: ${result.error || result.bodyText || 'no body'}`,
        );
    }
    if (!result.body?.success) {
        const code = result.body?.errorCode;
        const msg = result.body?.errorMsg || `errorCode=${code}`;
        throw new Error(`login rejected by JobRight: ${msg}`);
    }
    logger?.debug?.({ userId: result.body?.result?.userId }, 'login(api): accepted');
}

// performLoginViaForm: drives the JR sign-in modal with real field fills
// + click, so JR's client-side password hashing runs. We then observe the
// POST /swan/auth/login/pwd response for the authoritative verdict — no
// fragile DOM-error-text matching.
async function performLoginViaForm(page, { email, password, env, logger }) {
    const base = env.JOBRIGHT_BASE.replace(/\/+$/, '');
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    logger?.debug?.('login(form): page loaded');

    const signInLink = page.getByText('SIGN IN', { exact: true }).first();
    await signInLink.waitFor({ timeout: 15_000 });
    await signInLink.click();

    const emailBox = page.getByRole('textbox', { name: 'Email' });
    const passBox = page.getByRole('textbox', { name: 'Password' });
    await emailBox.waitFor({ timeout: 10_000 });
    await emailBox.fill(email);
    await passBox.fill(password);

    // Start listening BEFORE clicking submit so we never miss the response.
    const loginRespPromise = page.waitForResponse(
        (r) =>
            r.url().includes('/swan/auth/login/pwd') &&
            r.request().method() === 'POST',
        { timeout: 60_000 },
    );

    await page.getByRole('button', { name: 'SIGN IN' }).click();
    logger?.debug?.('login(form): submit clicked');

    const resp = await loginRespPromise;
    let respJson = null;
    try {
        respJson = await resp.json();
    } catch {
        /* ignore */
    }
    if (resp.status() !== 200 || respJson?.success !== true) {
        const code = respJson?.errorCode;
        const msg = respJson?.errorMsg || `errorCode=${code}`;
        throw new Error(`login rejected by JobRight: ${msg}`);
    }
    logger?.debug?.({ userId: respJson?.result?.userId }, 'login(form): accepted');

    // Form flow usually redirects to /jobs/recommend post-login; wait briefly.
    await page.waitForURL(POST_LOGIN_REGEX, { timeout: 20_000 }).catch(() => {
        // Non-fatal: the cookie jar is already set and the probe will confirm.
    });
}

// createSessionService: factory.
// input  : { env, browser, mutex, logger }
// output : { probeSession, ensureLoggedIn, logout }
export function createSessionService({ env, browser, mutex, logger } = {}) {
    if (!env) throw new Error('createSessionService: env is required');
    if (!browser) throw new Error('createSessionService: browser is required');
    if (!mutex) throw new Error('createSessionService: mutex is required');

    // probeSession is a read-only check that still goes through the mutex so
    // it doesn't collide with an in-flight login or scrape.
    async function probeSession() {
        return mutex.run(async () => {
            return browser.withContext({ headless: true }, async (ctx) => {
                const page = await ctx.newPage();
                try {
                    const r = await probeViaPage(page, env);
                    return ok(r);
                } finally {
                    await page.close().catch(() => {});
                }
            });
        });
    }

    // ensureLoggedIn: probe; if not logged in, attempt programmatic login.
    //   headed : open Chromium in headful mode (for first-time manual login)
    //   force  : skip the probe and log in unconditionally
    async function ensureLoggedIn({ headed = false, force = false } = {}) {
        return mutex.run(async () => {
            return browser.withContext({ headless: !headed }, async (ctx) => {
                const page = await ctx.newPage();
                try {
                    if (!force) {
                        const probe = await probeViaPage(page, env);
                        if (probe.loggedIn) {
                            logger?.info?.('session probe: already logged in');
                            return ok({ action: 'noop', userInfo: probe.userInfo });
                        }
                    }

                    if (headed) {
                        // Headful first-login: let the operator complete it
                        // manually in the open window. We still navigate to
                        // the sign-in modal so they land on the right page.
                        logger?.info?.('first-login: navigating to sign-in and handing off to operator');
                        try {
                            await page.goto(LOGIN_URL, {
                                waitUntil: 'domcontentloaded',
                                timeout: 30_000,
                            });
                            await page
                                .getByText('SIGN IN', { exact: true })
                                .click({ timeout: 5_000 });
                        } catch {
                            /* operator will navigate themselves if the click fails */
                        }
                        // Wait up to 5 minutes for operator to log in.
                        await page.waitForURL(POST_LOGIN_REGEX, { timeout: 5 * 60_000 });
                        const post = await probeViaPage(page, env);
                        if (!post.loggedIn) {
                            return err('LOGIN_FAILED', 'operator did not complete login');
                        }
                        return ok({ action: 'manual-login', userInfo: post.userInfo });
                    }

                    // Headless programmatic login.
                    if (!env.JOBRIGHT_EMAIL || !env.JOBRIGHT_PASSWORD) {
                        return err(
                            'NEEDS_REAUTH',
                            'no JR credentials in env — trigger POST /api/admin/first-login to log in manually',
                        );
                    }
                    await performLoginViaForm(page, {
                        email: env.JOBRIGHT_EMAIL,
                        password: env.JOBRIGHT_PASSWORD,
                        env,
                        logger,
                    });
                    const post = await probeViaPage(page, env);
                    if (!post.loggedIn) {
                        return err(
                            'LOGIN_FAILED',
                            'login completed navigation but session probe still anonymous',
                        );
                    }
                    logger?.info?.(
                        { userId: post.userInfo?.userId },
                        'programmatic login succeeded',
                    );
                    return ok({ action: 'logged-in', userInfo: post.userInfo });
                } catch (e) {
                    // Surface timeouts + bot-walls as a distinct code so the
                    // UI can tell operators to switch to manual first-login.
                    const code = /Timeout/i.test(e.message) ? 'LOGIN_TIMEOUT' : 'LOGIN_ERROR';
                    return err(code, e.message, { cause: e });
                } finally {
                    await page.close().catch(() => {});
                }
            });
        });
    }

    return { probeSession, ensureLoggedIn };
}
