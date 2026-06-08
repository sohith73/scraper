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
import { httpExtractJobDetail } from './htmlExtract.js';

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

const COUNTRY_HINTS = [
    [/united states|usa|u\.s\.a\.|u\.s\.|us\b|remote\s*-\s*us|\bny\b|\bca\b|\btx\b|\bfl\b|\bwa\b/i, 'United States'],
    [/canada|\bca\b|toronto|vancouver|ontario|british columbia/i, 'Canada'],
    [/united kingdom|\buk\b|england|london/i, 'United Kingdom'],
    [/india|bengaluru|bangalore|mumbai|delhi|hyderabad|pune/i, 'India'],
    [/germany|berlin|munich/i, 'Germany'],
    [/france|paris/i, 'France'],
    [/australia|sydney|melbourne/i, 'Australia'],
    [/singapore/i, 'Singapore'],
];

function providerFor(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (host.includes('greenhouse.io')) return 'greenhouse';
        if (host.includes('ashbyhq.com')) return 'ashby';
        if (host.includes('myworkdayjobs.com') || host.includes('workday')) return 'workday';
        if (host.includes('lever.co')) return 'lever';
        if (host.includes('smartrecruiters.com')) return 'smartrecruiters';
        if (host.includes('bamboohr.com')) return 'bamboohr';
        if (host.includes('icims.com')) return 'icims';
        if (host.includes('indeed.')) return 'indeed';
        if (host.includes('linkedin.com')) return 'linkedin';
        return host.replace(/^www\./, '');
    } catch {
        return 'unknown';
    }
}

function countryFromLocation(location) {
    const loc = String(location || '').trim();
    if (!loc) return '';
    for (const [rx, country] of COUNTRY_HINTS) {
        if (rx.test(loc)) return country;
    }
    const parts = loc.split(/[,|/]/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
}

function textFromHtml(value) {
    return String(value || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function locationFromDescription(description) {
    const text = textFromHtml(description);
    const patterns = [
        /\b(Vancouver(?:,\s*British Columbia)?(?:,\s*Canada)?)\b/i,
        /\b(Toronto(?:,\s*Ontario)?(?:,\s*Canada)?)\b/i,
        /\b(San Francisco(?:,\s*CA)?(?:,\s*United States)?)\b/i,
        /\b(New York(?:,\s*NY)?(?:,\s*United States)?)\b/i,
        /\b(London(?:,\s*United Kingdom)?)\b/i,
        /\b(Bengaluru|Bangalore|Hyderabad|Pune|Mumbai|Delhi)(?:,\s*India)?\b/i,
    ];
    for (const rx of patterns) {
        const m = text.match(rx);
        if (m) return m[0];
    }
    return '';
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
    // Tier 0 (HTTP-first). When true, every request first tries a plain HTTP
    // GET + JSON-LD parse (no browser). Only thin/empty results fall through
    // to the Chromium tier below. This is where the throughput win comes from.
    httpFirst = true,
    httpTimeoutMs = 8000,
    httpConcurrency = 40,
    // URL-level result cache (createUrlCache). null disables caching.
    cache = null,
    // Hard cap on URLs accepted per batch call.
    batchMax = 50,
    userAgent = '',
} = {}) {
    if (!browser?.withContext) {
        throw new Error('createJdFetcher: browser handle required');
    }

    // Hosts where a plain HTTP GET is pointless or actively bot-walled (returns
    // a login/challenge page, never JSON-LD) — skip Tier 0, go straight to the
    // browser tier. Most of these are excluded upstream anyway, but guard here
    // too so a stray URL doesn't waste a round-trip.
    const BROWSER_ONLY_HOST = /(^|\.)(linkedin\.com|indeed\.|glassdoor\.|ziprecruiter\.)/i;
    function isBrowserOnlyHost(url) {
        try {
            return BROWSER_ONLY_HOST.test(new URL(url).hostname);
        } catch {
            return false;
        }
    }

    // Tier 0: HTTP GET + JSON-LD. Returns a full, route-shaped result on
    // success, or null to signal "fall through to the browser tier". Never
    // touches the Chromium semaphore.
    async function tryHttp(url) {
        const t0 = Date.now();
        const r = await httpExtractJobDetail(url, { timeoutMs: httpTimeoutMs, userAgent: userAgent || undefined });
        if (!r.ok) return null;
        const desc = String(r.description || '').trim();
        // Accept only when JSON-LD carried a real description. A bare location
        // with no/thin JD still warrants a browser render attempt.
        if (desc.length < minDescriptionChars) return null;
        const loc = String(r.location || '').trim();
        return {
            ok: true,
            description: desc,
            mainJd: desc,
            location: loc,
            country: r.country || '',
            title: r.position || '',
            company: r.company || '',
            employmentType: r.type || '',
            provider: providerFor(r.finalUrl || url),
            method: 'json-ld-http',
            tier: 'http',
            confidence: 95,
            finalUrl: r.finalUrl || url,
            sourceUrl: url,
            durationMs: Date.now() - t0,
        };
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

    // Tier 1: full Chromium render + in-page extractor pipeline. Holds a
    // browser semaphore slot for its whole duration. Only reached when Tier 0
    // (HTTP/JSON-LD) missed or was skipped.
    async function runBrowser(url) {
        const t0 = Date.now();
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
                const loc = String(extracted.data.location || '').trim() || locationFromDescription(desc);
                const country = countryFromLocation(loc);
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
                    mainJd: desc,
                    location: loc,
                    country,
                    title: extracted.data.position || '',
                    company: extracted.data.company || '',
                    employmentType: extracted.data.type || '',
                    provider: providerFor(extracted.finalUrl || url),
                    method: extracted.method,
                    tier: 'browser',
                    confidence: extracted.confidence,
                    fieldSources: extracted.fieldSources,
                    finalUrl: extracted.finalUrl,
                    sourceUrl: url,
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

    // Browser tier wrapped in the semaphore. Caches successful results.
    async function browserTier(url) {
        await acquire();
        let r;
        try {
            r = await runBrowser(url);
        } finally {
            release();
        }
        if (r && r.ok && cache) await cache.set(url, r);
        return r;
    }

    // Single-URL extraction. Order: cache → Tier 0 (HTTP/JSON-LD) → Tier 1
    // (browser). Tier 0 never takes a browser slot, so most traffic bypasses
    // the Chromium bottleneck entirely.
    async function fetchJobDetail(url) {
        if (!isHttpUrl(url)) {
            return { ok: false, error: 'BAD_INPUT', message: 'http(s) url required', durationMs: 0 };
        }
        if (cache) {
            const hit = await cache.get(url);
            if (hit) return { ...hit, cached: true };
        }
        if (httpFirst && !isBrowserOnlyHost(url)) {
            const t = await tryHttp(url);
            if (t) {
                if (cache) await cache.set(url, t);
                return t;
            }
        }
        return browserTier(url);
    }

    // Bounded-concurrency map. Runs `fn` over `items` with at most `limit`
    // in flight. Errors per-item are caught and surfaced as the rejected
    // value so one bad URL never sinks the batch.
    async function mapLimit(items, limit, fn) {
        const out = new Array(items.length);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
            while (cursor < items.length) {
                const idx = cursor;
                cursor += 1;
                try {
                    out[idx] = await fn(items[idx], idx);
                } catch (e) {
                    out[idx] = { ok: false, error: 'UNEXPECTED', message: e?.message || 'failed' };
                }
            }
        });
        await Promise.all(workers);
        return out;
    }

    // Batch extraction. Phase 1 runs cache + Tier 0 across ALL urls at high
    // concurrency (httpConcurrency) — cheap, no browser. Only the Tier-0
    // misses go to Phase 2 (browser tier, capped by the semaphore). Returns a
    // plain object keyed by the original URL → result.
    async function fetchJobDetailBatch(urls) {
        const seen = new Set();
        const list = [];
        for (const raw of Array.isArray(urls) ? urls : []) {
            const u = typeof raw === 'string' ? raw.trim() : '';
            if (!isHttpUrl(u) || seen.has(u)) continue;
            seen.add(u);
            list.push(u);
            if (list.length >= batchMax) break;
        }
        const results = {};
        if (!list.length) return results;

        const misses = [];
        await mapLimit(list, httpConcurrency, async (url) => {
            if (cache) {
                const hit = await cache.get(url);
                if (hit) {
                    results[url] = { ...hit, cached: true };
                    return;
                }
            }
            if (httpFirst && !isBrowserOnlyHost(url)) {
                const t = await tryHttp(url);
                if (t) {
                    if (cache) await cache.set(url, t);
                    results[url] = t;
                    return;
                }
            }
            misses.push(url);
        });

        if (misses.length) {
            await mapLimit(misses, maxConcurrent, async (url) => {
                results[url] = await browserTier(url);
            });
        }
        return results;
    }

    return { fetchJobDetail, fetchJobDetailBatch };
}
