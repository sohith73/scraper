// Persistent Chromium singleton.
//
// Why : JobRight's session is cookie + localStorage + IndexedDB. A
//       persistent context (not storageState JSON) captures all three
//       cleanly. Only one context can be open against a userDataDir at a
//       time, so this module enforces a process-wide singleton.
//
// Two operating modes:
//   headless (default) : Phase 9 scraping runs here
//   headed             : operator kicks off via POST /api/admin/first-login
//                        the first time, to complete a fresh login
//
// Switching modes closes and reopens the context, because Chromium cannot
// toggle headless at runtime.

import { mkdir } from 'node:fs/promises';

// Default fingerprint — a current stable desktop Chrome. Overridable via
// env.JR_USER_AGENT so ops can bump the Chrome version without a redeploy.
const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// createBrowserHandle: factory. Takes { env, logger, launcher? } where
// `launcher` is the Playwright launch function (injected so tests can
// substitute a fake). In production we default to playwright.chromium.
// input  : { env, logger, launcher?, storageDir? }
// output : { withContext(opts, fn), close(), status() }
export function createBrowserHandle({
    env,
    logger,
    launcher = null,
    storageDir = null,
} = {}) {
    const dir = storageDir || env?.STORAGE_DIR || './storage';

    let context = null;
    let currentOpts = null;

    async function ensureLauncher() {
        if (launcher) return launcher;
        // Lazy-import Playwright so tests that inject a launcher never load it.
        const { chromium } = await import('playwright');
        return (opts) => {
            const locale = env?.JR_LOCALE || 'en-US';
            // Normalise the automation fingerprint: realistic UA + locale +
            // headers, drop the --enable-automation banner, and quiet the
            // background services that leak "this is a bot" signals.
            const ctxOpts = {
                headless: opts.headless,
                viewport: { width: 1440, height: 900 },
                userAgent: env?.JR_USER_AGENT || DEFAULT_UA,
                locale,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--disable-background-networking',
                    '--disable-client-side-phishing-detection',
                    '--disable-sync',
                    '--metrics-recording-only',
                ],
                ignoreDefaultArgs: ['--enable-automation'],
                extraHTTPHeaders: {
                    'Accept-Language': `${locale},en;q=0.9`,
                },
            };
            // Only pin a timezone when explicitly configured — an empty
            // string is an invalid timezoneId and would throw.
            if (env?.JR_TIMEZONE) ctxOpts.timezoneId = env.JR_TIMEZONE;
            return chromium.launchPersistentContext(dir, ctxOpts);
        };
    }

    // ensureContext: brings a context up if one isn't open, or recycles if
    // the caller needs a different headless mode.
    async function ensureContext(opts) {
        if (context && currentOpts && currentOpts.headless === opts.headless) {
            return context;
        }
        if (context) {
            logger?.info?.(
                { from: currentOpts, to: opts },
                'recycling Chromium context for mode change',
            );
            try {
                await context.close();
            } catch (err) {
                logger?.warn?.({ err: err.message }, 'close() threw — continuing');
            }
            context = null;
            currentOpts = null;
        }
        await mkdir(dir, { recursive: true });
        const launch = await ensureLauncher();
        context = await launch(opts);
        currentOpts = { ...opts };
        logger?.info?.({ dir, headless: opts.headless }, 'chromium context opened');
        return context;
    }

    async function withContext(opts, fn) {
        const c = await ensureContext(opts);
        return fn(c);
    }

    async function close() {
        if (!context) return;
        try {
            await context.close();
        } catch (err) {
            logger?.warn?.({ err: err.message }, 'browser close() failed');
        }
        context = null;
        currentOpts = null;
    }

    function status() {
        return {
            open: Boolean(context),
            headless: currentOpts?.headless ?? null,
            dir,
        };
    }

    return { withContext, close, status };
}
