// fetchJobDetail — open an apply URL in a fresh Playwright page, run the
// ported FlashFire DOM extractors against the rendered DOM, return
// { ok, description, location, method, confidence, durationMs }.
//
// Reuses the singleton persistent context from `playwright/browser.js`. A
// new page per call (closed in `finally`) keeps state isolated. Per-host
// settle delays cover SPA hydration (Workday, Greenhouse iframe redirect).
//
// Failure modes — all return { ok:false, error } so the caller can fall
// back to the JR/hiring.cafe description without raising:
//   BAD_INPUT       — url missing or not http(s)
//   NAV_TIMEOUT     — page.goto exceeded navTimeoutMs
//   EVAL_FAILED     — extractor threw inside page context
//   THIN_CONTENT    — description shorter than minDescriptionChars
//   NO_DATA         — extractor returned null
//   BROWSER_FAILURE — context.newPage / unexpected throw

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTRACTORS_DIR = join(HERE, '..', '..', 'playwright', 'extractors');

// Order matters: namespace first (creates window.FFExtract), then
// confidence (consumed by pipeline merge), then layers, then sites, then
// pipeline (which reads all of the above).
const EXTRACTOR_FILES = [
    'namespace.js',
    'confidence.js',
    'json-ld.js',
    'meta-tags.js',
    'generic.js',
    'site-greenhouse.js',
    'site-lever.js',
    'site-ashby.js',
    'site-workday.js',
    'site-smartrecruiters.js',
    'site-bamboohr.js',
    'site-icims.js',
    'site-indeed.js',
    'site-linkedin.js',
    'site-jobright.js',
    'pipeline.js',
];

let _bundle = null;
async function loadBundle() {
    if (_bundle) return _bundle;
    const parts = [];
    for (const f of EXTRACTOR_FILES) {
        parts.push(`/* ${f} */\n` + (await readFile(join(EXTRACTORS_DIR, f), 'utf8')));
    }
    _bundle = parts.join('\n;\n');
    return _bundle;
}

// Per-host settle in ms. SPA frameworks need extra time after `load` for
// React/Vue hydration to mount the JD body. Empirically tuned.
const HOST_SETTLE_MS = [
    [/workday/i, 5000],
    [/greenhouse/i, 2500],
    [/lever\.co/i, 1500],
    [/ashbyhq/i, 2000],
    [/icims/i, 3000],
    [/smartrecruiters/i, 2500],
    [/bamboohr/i, 2000],
    [/linkedin/i, 3000],
    [/indeed/i, 3000],
];
function settleFor(url) {
    try {
        const host = new URL(url).hostname;
        for (const [rx, ms] of HOST_SETTLE_MS) if (rx.test(host)) return ms;
    } catch {}
    return 1500;
}

function isHttpUrl(u) {
    if (!u || typeof u !== 'string') return false;
    try {
        const p = new URL(u);
        return p.protocol === 'http:' || p.protocol === 'https:';
    } catch {
        return false;
    }
}

// createJdFetcher — factory. Caller wires in { browser, logger?,
// navTimeoutMs?, minDescriptionChars?, maxConcurrent? } once at boot.
//
// maxConcurrent caps in-flight Playwright pages on the shared context. A
// chromium context handles many pages but each one is real RAM + CPU and
// the host is the operator's machine. 2 is conservative.
export function createJdFetcher({
    browser,
    logger = null,
    navTimeoutMs = 25000,
    minDescriptionChars = 300,
    maxConcurrent = 2,
} = {}) {
    if (!browser?.withContext) {
        throw new Error('createJdFetcher: browser handle required');
    }

    // Tiny semaphore. Resolve a slot, do the work, release.
    let inFlight = 0;
    const waitQueue = [];
    function acquire() {
        if (inFlight < maxConcurrent) {
            inFlight += 1;
            return Promise.resolve();
        }
        return new Promise((res) => waitQueue.push(res));
    }
    function release() {
        inFlight -= 1;
        const next = waitQueue.shift();
        if (next) {
            inFlight += 1;
            next();
        }
    }

    async function runOnce(url) {
        const t0 = Date.now();
        if (!isHttpUrl(url)) {
            return { ok: false, error: 'BAD_INPUT', message: 'http(s) url required', durationMs: 0 };
        }
        const bundle = await loadBundle();
        let page = null;
        try {
            const result = await browser.withContext({ headless: true }, async (ctx) => {
                page = await ctx.newPage();
                // Block heavy assets — JD only needs HTML/JS for hydration.
                await page.route('**/*', (route) => {
                    const t = route.request().resourceType();
                    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
                    return route.continue();
                });
                try {
                    await page.goto(url, {
                        waitUntil: 'domcontentloaded',
                        timeout: navTimeoutMs,
                    });
                } catch (err) {
                    return { ok: false, error: 'NAV_TIMEOUT', message: err.message };
                }
                // Settle for SPA hydration. networkidle is unreliable on
                // analytics-heavy job sites — explicit timer is safer.
                await page.waitForTimeout(settleFor(url));
                let extracted;
                try {
                    extracted = await page.evaluate(
                        // eslint-disable-next-line no-new-func
                        (src) => {
                            // eslint-disable-next-line no-eval
                            (0, eval)(src);
                            // pipeline.extract returns full result; we only
                            // need a JSON-serialisable subset back over IPC.
                            const r = window.FFExtract && window.FFExtract.pipeline
                                && window.FFExtract.pipeline.extract();
                            if (!r || !r.data) return null;
                            return {
                                data: r.data,
                                confidence: r.confidence,
                                method: r.method,
                                fieldSources: r.fieldSources,
                                extractionTimeMs: r.extractionTimeMs,
                                finalUrl: window.location.href,
                            };
                        },
                        bundle,
                    );
                } catch (err) {
                    return { ok: false, error: 'EVAL_FAILED', message: err.message };
                }
                if (!extracted) return { ok: false, error: 'NO_DATA', message: 'pipeline returned null' };
                const desc = String(extracted.data.description || '').trim();
                const loc = String(extracted.data.location || '').trim();
                if (desc.length < minDescriptionChars) {
                    return {
                        ok: false,
                        error: 'THIN_CONTENT',
                        message: `description ${desc.length} < ${minDescriptionChars}`,
                        partial: {
                            description: desc,
                            location: loc,
                            method: extracted.method,
                            confidence: extracted.confidence,
                        },
                    };
                }
                return {
                    ok: true,
                    description: desc,
                    location: loc,
                    method: extracted.method,
                    confidence: extracted.confidence,
                    fieldSources: extracted.fieldSources,
                    finalUrl: extracted.finalUrl,
                };
            });
            return { ...result, durationMs: Date.now() - t0 };
        } catch (err) {
            logger?.warn?.({ url, err: err.message }, '[jdFetch] unexpected failure');
            return {
                ok: false,
                error: 'BROWSER_FAILURE',
                message: err.message,
                durationMs: Date.now() - t0,
            };
        } finally {
            if (page) {
                try { await page.close(); } catch {}
            }
        }
    }

    async function fetchJobDetail(url) {
        await acquire();
        try {
            return await runOnce(url);
        } finally {
            release();
        }
    }

    return { fetchJobDetail };
}
