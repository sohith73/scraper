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
        return (opts) =>
            chromium.launchPersistentContext(dir, {
                headless: opts.headless,
                viewport: { width: 1440, height: 900 },
                args: ['--disable-blink-features=AutomationControlled'],
            });
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
