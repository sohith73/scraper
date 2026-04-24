// Generic network-response interceptor.
//
// Why : Phase 9 search runner needs to grab JR's /swan/recommend/list/jobs
//       JSON payload after it mutates the filter + triggers a fetch.
//       `page.on('response')` is the right primitive but it's async-by-design
//       (no native "wait until N matches" combinator) and has sharp edges
//       (reading the body twice, reading after page closure, ordering vs.
//       the very first fetch). This module wraps all of that.
//
// Usage:
//   const interceptor = startInterceptor(page, {
//       urlPattern: /\/swan\/recommend\/list\/jobs/,
//       method: 'GET',
//       statusRange: [200, 299],
//   });
//   await doWhateverTriggersRequests();
//   const captured = await interceptor.waitFor({ count: 1, timeoutMs: 30_000 });
//   interceptor.stop();
//
// Tests inject a page-like fake (see tests/unit/playwright-intercept.test.js).

import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// matches: predicate over a Playwright `Response`. Each filter is independent
// so callers can mix+match (method-only, status-only, etc.).
// input  : response, { urlPattern, method, statusRange }
// output : boolean
function matches(response, { urlPattern, method, statusRange }) {
    if (method) {
        const m = response.request()?.method?.() ?? null;
        if (m !== method) return false;
    }
    if (statusRange) {
        const s = response.status();
        if (s < statusRange[0] || s > statusRange[1]) return false;
    }
    const url = response.url();
    if (urlPattern) {
        if (urlPattern instanceof RegExp) {
            if (!urlPattern.test(url)) return false;
        } else if (typeof urlPattern === 'string') {
            if (!url.includes(urlPattern)) return false;
        } else if (typeof urlPattern === 'function') {
            if (!urlPattern(url, response)) return false;
        } else {
            throw new TypeError('urlPattern must be a RegExp, string, or function');
        }
    }
    return true;
}

// readBodySafe: reads the response body once and tries to parse as JSON.
// Any IO/parse error returns a preview-only record so the caller still sees
// status + headers without the interceptor throwing.
async function readBodySafe(response) {
    let text = '';
    try {
        text = await response.text();
    } catch {
        return { bodyJson: null, bodyTextPreview: '', bodyBytes: 0 };
    }
    const bodyBytes = Buffer.byteLength(text);
    if (!text) return { bodyJson: null, bodyTextPreview: '', bodyBytes: 0 };
    try {
        return { bodyJson: JSON.parse(text), bodyTextPreview: '', bodyBytes };
    } catch {
        return {
            bodyJson: null,
            bodyTextPreview: text.slice(0, 512),
            bodyBytes,
        };
    }
}

// slugifyUrl: filesystem-safe short form of a URL path for debug-dump names.
function slugifyUrl(url) {
    try {
        const u = new URL(url);
        const s = u.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
        return s.slice(0, 60) || 'root';
    } catch {
        return 'unknown';
    }
}

// dumpEntry: best-effort write of one captured entry to disk. Swallows IO
// errors because the interceptor must never break the caller's run.
async function dumpEntry(entry, debugDir) {
    try {
        await mkdir(debugDir, { recursive: true });
        const slug = slugifyUrl(entry.url);
        const fname = `${String(entry.seq).padStart(5, '0')}-${entry.method}-${slug}.json`;
        await writeFile(join(debugDir, fname), JSON.stringify(entry, null, 2));
    } catch {
        /* opportunistic */
    }
}

// startInterceptor: install a response listener; return a handle.
// input  : page, options
//   urlPattern   RegExp | string (substring) | function(url,response) | null
//   method       'GET' | 'POST' | ... | null
//   statusRange  [min, max] inclusive | null
//   maxBuffer    bounded size; older entries are evicted (default 500)
//   debugDir     if set, each match is dumped to disk
//   logger       optional pino-like logger for debug lines
// output : handle with methods { waitFor, drain, stop, all(), count, droppedCount, stopped }
export function startInterceptor(page, options = {}) {
    if (!page || typeof page.on !== 'function' || typeof page.off !== 'function') {
        throw new TypeError('startInterceptor: page must expose .on() and .off()');
    }
    const {
        urlPattern = null,
        method = null,
        statusRange = null,
        maxBuffer = 500,
        debugDir = null,
        logger = null,
    } = options;

    if (!Number.isInteger(maxBuffer) || maxBuffer <= 0) {
        throw new TypeError('startInterceptor: maxBuffer must be a positive integer');
    }

    const captured = [];
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    let seq = 0;
    let droppedCount = 0;
    let stopped = false;

    async function onResponse(response) {
        if (stopped) return;
        try {
            if (!matches(response, { urlPattern, method, statusRange })) return;
        } catch (err) {
            logger?.warn?.({ err: err.message }, 'interceptor matcher threw');
            return;
        }
        try {
            const body = await readBodySafe(response);
            seq += 1;
            const entry = {
                seq,
                ts: new Date().toISOString(),
                url: response.url(),
                method: response.request()?.method?.() ?? null,
                status: response.status(),
                contentType:
                    (response.headers?.()['content-type'] || '').split(';')[0].trim(),
                bodyBytes: body.bodyBytes,
                bodyJson: body.bodyJson,
                bodyTextPreview: body.bodyTextPreview,
            };
            if (captured.length >= maxBuffer) {
                captured.shift();
                droppedCount += 1;
            }
            captured.push(entry);
            if (debugDir) await dumpEntry(entry, debugDir);
            emitter.emit('match', entry);
        } catch (err) {
            // An error reading the body (e.g. page closed) must not crash
            // the caller's run. Log and move on.
            logger?.warn?.({ err: err.message }, 'interceptor body-read failed');
        }
    }

    page.on('response', onResponse);

    return {
        // live view; copy so the caller can't mutate internal state
        all() {
            return captured.slice();
        },
        get count() {
            return captured.length;
        },
        get droppedCount() {
            return droppedCount;
        },
        get stopped() {
            return stopped;
        },

        // waitFor: resolves with a snapshot once `count` matching responses
        // have arrived. On timeout, resolves with whatever's arrived so far
        // AND a flag so callers can tell the difference.
        // input  : { count:number, timeoutMs:number }
        // output : { items: Entry[], complete: boolean, timedOut: boolean }
        async waitFor({ count, timeoutMs }) {
            if (!Number.isInteger(count) || count <= 0) {
                throw new TypeError('waitFor: count must be a positive integer');
            }
            if (captured.length >= count) {
                return { items: captured.slice(0, count), complete: true, timedOut: false };
            }
            return new Promise((resolve) => {
                const done = (timedOut) => {
                    emitter.off('match', onMatch);
                    clearTimeout(timer);
                    resolve({
                        items: captured.slice(0, Math.min(count, captured.length)),
                        complete: captured.length >= count,
                        timedOut,
                    });
                };
                const onMatch = () => {
                    if (captured.length >= count) done(false);
                };
                const timer = setTimeout(() => done(true), timeoutMs);
                emitter.on('match', onMatch);
            });
        },

        // drain: snapshot + clear. Useful between steps of a pipeline when
        // you want to partition captures by phase.
        drain() {
            const out = captured.slice();
            captured.length = 0;
            droppedCount = 0;
            return out;
        },

        // stop: detach from the page. Idempotent.
        stop() {
            if (stopped) return;
            stopped = true;
            try {
                page.off('response', onResponse);
            } catch {
                /* page may already be closed */
            }
            emitter.removeAllListeners();
        },
    };
}
