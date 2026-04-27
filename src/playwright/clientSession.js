// Per-client JobRight session.
//
// Why : the shared-account session lives in `session.js`. For the
//       per-client architecture each client has their own JR creds and
//       their own persistent context (via clientBrowserPool). This
//       module wraps the same probe + form-login flow but against a
//       caller-supplied browser handle, so the shared mutex still
//       serialises Playwright operations across all clients.
//
// Public API:
//   probeClient({ browserHandle, mutex, env, logger })
//     → Result<{ loggedIn, status, userInfo }>
//
//   loginClient({ browserHandle, mutex, env, logger, jrEmail, jrPassword,
//                 force?, headed? })
//     → Result<{ action: 'noop'|'logged-in'|'manual-login', userInfo }>

import { ok, err } from '../clients/common/result.js';
import { probeViaPage, performLoginViaForm } from './session.js';

const POST_LOGIN_REGEX = /\/jobs\/recommend/;
const LOGIN_URL = 'https://jobright.ai/';

// probeClient: read-only check using the client's persistent context.
// Goes through the shared mutex so it cannot collide with a scrape.
export async function probeClient({ browserHandle, mutex, env, logger } = {}) {
    if (!browserHandle) return err('BAD_INPUT', 'browserHandle required');
    if (!mutex) return err('BAD_INPUT', 'mutex required');
    if (!env) return err('BAD_INPUT', 'env required');
    return mutex.run(async () => {
        return browserHandle.withContext({ headless: true }, async (ctx) => {
            const page = await ctx.newPage();
            try {
                const r = await probeViaPage(page, env);
                return ok(r);
            } catch (e) {
                return err('PROBE_FAILED', e.message);
            } finally {
                await page.close().catch(() => {});
            }
        });
    });
}

// loginClient: probe; if not logged in, attempt programmatic form login
// using the supplied per-client credentials. `headed:true` opens a
// headful window so an operator can complete a manual login (CAPTCHA /
// MFA cases). `force:true` skips the probe and re-logs in.
export async function loginClient({
    browserHandle,
    mutex,
    env,
    logger,
    jrEmail,
    jrPassword,
    force = false,
    headed = false,
} = {}) {
    if (!browserHandle) return err('BAD_INPUT', 'browserHandle required');
    if (!mutex) return err('BAD_INPUT', 'mutex required');
    if (!env) return err('BAD_INPUT', 'env required');
    if (typeof jrEmail !== 'string' || !jrEmail.includes('@')) {
        return err('BAD_INPUT', 'jrEmail must be an email');
    }
    if (typeof jrPassword !== 'string' || jrPassword.length === 0) {
        return err('BAD_INPUT', 'jrPassword must be non-empty');
    }
    return mutex.run(async () => {
        return browserHandle.withContext({ headless: !headed }, async (ctx) => {
            const page = await ctx.newPage();
            try {
                if (!force) {
                    const probe = await probeViaPage(page, env);
                    if (probe.loggedIn) {
                        logger?.info?.({ jrEmail }, 'clientSession: already logged in');
                        return ok({ action: 'noop', userInfo: probe.userInfo });
                    }
                }
                if (headed) {
                    logger?.info?.({ jrEmail }, 'clientSession: headed first-login');
                    try {
                        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                        await page.getByText('SIGN IN', { exact: true }).click({ timeout: 5_000 });
                    } catch { /* operator can navigate themselves */ }
                    await page.waitForURL(POST_LOGIN_REGEX, { timeout: 5 * 60_000 });
                    const post = await probeViaPage(page, env);
                    if (!post.loggedIn) return err('LOGIN_FAILED', 'operator did not complete login');
                    return ok({ action: 'manual-login', userInfo: post.userInfo });
                }
                await performLoginViaForm(page, { email: jrEmail, password: jrPassword, env, logger });
                const post = await probeViaPage(page, env);
                if (!post.loggedIn) {
                    return err('LOGIN_FAILED', 'login completed but session probe is anonymous');
                }
                logger?.info?.({ jrEmail, userId: post.userInfo?.userId }, 'clientSession: logged in');
                return ok({ action: 'logged-in', userInfo: post.userInfo });
            } catch (e) {
                const code = /Timeout/i.test(e.message) ? 'LOGIN_TIMEOUT'
                    : /20004|invalid/i.test(e.message) ? 'BAD_CREDENTIALS'
                    : 'LOGIN_ERROR';
                return err(code, e.message);
            } finally {
                await page.close().catch(() => {});
            }
        });
    });
}
