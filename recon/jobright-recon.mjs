#!/usr/bin/env node
// Phase 0 — JobRight.ai reconnaissance tool.
//
// What it does : opens a headed Chromium, navigates to jobright.ai, and taps
//                every same-origin XHR/fetch response. Saves each JSON body
//                to `recon/samples/`, writes a JSONL index, and on Ctrl-C
//                emits a `summary.md` ranking endpoints by hit count.
// Why          : we don't yet know JobRight's real job-list / job-detail
//                endpoints (the `/swan/event/submit` URL the user pasted is
//                just telemetry). This captures the network traffic produced
//                while an operator browses manually, so we can design the
//                Phase 9 search runner against actual payload shapes.
// Input        : CLI flags (see parseArgs). Nothing from the runtime env.
// Output       : files under `recon/samples/`:
//                  - index.jsonl     one line per captured response
//                  - <seq>-<slug>.(json|txt)  the response body
//                  - summary.md      human-readable summary on shutdown
//
// Safety       : cookies + authorization request headers are stripped from
//                the index before writing. Sample files contain response
//                bodies only (no request cookies).
//
// Usage:
//   node recon/jobright-recon.mjs
//   node recon/jobright-recon.mjs --url=https://jobright.ai/jobs/recommend
//   node recon/jobright-recon.mjs --out=recon/samples --max-body=524288

import { chromium } from 'playwright';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// --- CLI parsing ---------------------------------------------------------

// parseArgs: reads --flag=value from process.argv. No third-party parser
// needed for a handful of flags.
// input  : none (reads process.argv)
// output : { url, out, storage, maxBody, includeAssets, includeTelemetry }
function parseArgs() {
    const defaults = {
        url: 'https://jobright.ai/jobs/recommend',
        out: resolve(ROOT, 'recon/samples'),
        storage: resolve(ROOT, 'recon/storage'),
        maxBody: 512 * 1024,
        includeAssets: false,
        includeTelemetry: false,
    };
    const out = { ...defaults };
    for (const arg of process.argv.slice(2)) {
        const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
        if (!m) continue;
        const [, key, value] = m;
        switch (key) {
            case 'url':
                out.url = value;
                break;
            case 'out':
                out.out = resolve(value);
                break;
            case 'storage':
                out.storage = resolve(value);
                break;
            case 'max-body':
                out.maxBody = Math.max(0, Number(value));
                break;
            case 'include-assets':
                out.includeAssets = true;
                break;
            case 'include-telemetry':
                out.includeTelemetry = true;
                break;
            case 'help':
            case 'h':
                printHelpAndExit();
                break;
            default:
                console.error(`unknown flag: --${key}`);
                process.exit(2);
        }
    }
    return out;
}

function printHelpAndExit() {
    console.log(`JobRight reconnaissance tool

Flags:
  --url=<url>              Starting URL (default: https://jobright.ai/jobs/recommend)
  --out=<dir>              Where to drop samples (default: recon/samples)
  --storage=<dir>          Persistent Chromium profile dir (default: recon/storage)
  --max-body=<bytes>       Truncate JSON bodies larger than this (default: 524288)
  --include-assets         Also capture .js/.css/.png/etc. (default: skip)
  --include-telemetry      Also capture /swan/event/submit telemetry (default: skip)
  --help                   This message

Flow:
  1. A headed Chromium window opens on the given URL.
  2. Log in manually if needed — the profile dir persists the session.
  3. Browse /jobs/recommend, apply a filter or two, scroll a few pages.
  4. Optionally click one or two job cards to trigger the detail endpoint.
  5. Ctrl-C in the terminal when done. A summary.md is written.
`);
    process.exit(0);
}

// --- URL classifiers -----------------------------------------------------

const ASSET_RE = /\.(js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|map|txt|mp4|webm)(\?|$)/i;
const TELEMETRY_PATHS = new Set(['/swan/event/submit']);

// shouldCapture: returns true if this response should be persisted.
// input  : { url:URL, pathname:string, options }
// output : boolean
function shouldCapture(url, options) {
    if (!/jobright\.ai$/i.test(url.hostname) && !url.hostname.endsWith('.jobright.ai'))
        return false;
    if (!options.includeAssets && ASSET_RE.test(url.pathname)) return false;
    if (!options.includeTelemetry && TELEMETRY_PATHS.has(url.pathname)) return false;
    return true;
}

// slugify: turns a URL path into a filesystem-safe filename fragment.
function slugify(pathname) {
    return pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'root';
}

// redactHeaders: drops auth-like headers so the index.jsonl is safe to share.
function redactHeaders(headers) {
    const out = { ...headers };
    for (const k of Object.keys(out)) {
        const kl = k.toLowerCase();
        if (kl === 'cookie' || kl === 'authorization' || kl === 'set-cookie') {
            delete out[k];
        }
    }
    return out;
}

// --- main ---------------------------------------------------------------

async function main() {
    const opts = parseArgs();
    await mkdir(opts.out, { recursive: true });
    await mkdir(opts.storage, { recursive: true });

    console.log('━'.repeat(72));
    console.log('JobRight Recon — Phase 0');
    console.log('━'.repeat(72));
    console.log(`  url      : ${opts.url}`);
    console.log(`  samples  : ${opts.out}`);
    console.log(`  profile  : ${opts.storage}`);
    console.log(`  maxBody  : ${opts.maxBody} bytes`);
    console.log('━'.repeat(72));

    const indexPath = `${opts.out}/index.jsonl`;
    const indexStream = createWriteStream(indexPath, { flags: 'a' });

    const browser = await chromium.launchPersistentContext(opts.storage, {
        headless: false,
        viewport: { width: 1440, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = browser.pages()[0] || (await browser.newPage());

    const stats = {
        captured: 0,
        json: 0,
        other: 0,
        status: new Map(), // status code -> count
        paths: new Map(), // pathname -> { count, methods:Set, sampleFile }
        startedAt: new Date().toISOString(),
    };

    let seq = 0;

    // page.on('response') fires for every response whose request originated
    // from this page (including fetches in page JS). We tap it and persist
    // anything that matches our filter.
    page.on('response', async (response) => {
        try {
            const url = new URL(response.url());
            if (!shouldCapture(url, opts)) return;

            const method = response.request().method();
            const status = response.status();
            const ct = (response.headers()['content-type'] || '').split(';')[0].trim();
            const isJson = ct.includes('application/json');
            const mySeq = ++seq;
            const slug = slugify(url.pathname);
            const filename = `${String(mySeq).padStart(5, '0')}-${method}-${slug}.${
                isJson ? 'json' : 'txt'
            }`;
            const filePath = `${opts.out}/${filename}`;

            let bodyBytes = 0;
            let truncated = false;
            try {
                if (isJson) {
                    const text = await response.text();
                    bodyBytes = Buffer.byteLength(text);
                    const write =
                        text.length > opts.maxBody
                            ? `${text.slice(0, opts.maxBody)}\n/* truncated — original ${text.length} chars */`
                            : text;
                    truncated = text.length > opts.maxBody;
                    await writeFile(filePath, write);
                } else {
                    const buf = await response.body().catch(() => null);
                    if (buf) {
                        bodyBytes = buf.length;
                        const preview = buf.subarray(0, Math.min(1024, buf.length)).toString('utf8');
                        await writeFile(
                            filePath,
                            `[non-JSON preview, ${buf.length} bytes total]\n\n${preview}`,
                        );
                    }
                }
            } catch {
                // Some responses (304, redirects, aborted) have no body; skip.
            }

            // Stats
            stats.captured += 1;
            if (isJson) stats.json += 1;
            else stats.other += 1;
            stats.status.set(status, (stats.status.get(status) || 0) + 1);
            const p = stats.paths.get(url.pathname) || {
                count: 0,
                methods: new Set(),
                sampleFile: filename,
                contentTypes: new Set(),
            };
            p.count += 1;
            p.methods.add(method);
            p.contentTypes.add(ct || 'unknown');
            stats.paths.set(url.pathname, p);

            const entry = {
                seq: mySeq,
                ts: new Date().toISOString(),
                method,
                url: response.url(),
                path: url.pathname,
                query: url.search || '',
                status,
                contentType: ct,
                bytes: bodyBytes,
                truncated,
                sample: filename,
                reqHeaders: redactHeaders(response.request().headers()),
            };
            indexStream.write(`${JSON.stringify(entry)}\n`);

            // Live console line — short, so the user sees progress.
            const marker = isJson ? '📦' : '·';
            console.log(
                `${marker} [${mySeq.toString().padStart(4, '0')}] ${method} ${status} ${url.pathname}${url.search ? '?…' : ''}  (${bodyBytes}B)`,
            );
        } catch (err) {
            console.error('capture error:', err.message);
        }
    });

    // Initial nav. Use a lenient waitUntil because the SPA hydrates after
    // load and we want the initial XHR burst too.
    try {
        await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (err) {
        console.error(`initial goto failed: ${err.message}`);
    }

    console.log('');
    console.log('Browser is open. Log in if prompted, then:');
    console.log('  • browse /jobs/recommend, apply 1–2 filters, scroll a few pages');
    console.log('  • click one or two job cards to trigger the detail endpoint');
    console.log('  • Ctrl-C here when done.');
    console.log('');

    // Keep the process alive until user presses Ctrl-C.
    await new Promise((resolveDone) => {
        const finish = async () => {
            console.log('\n[recon] shutting down…');
            try {
                await writeSummary(opts, stats);
            } catch (err) {
                console.error('failed to write summary:', err.message);
            }
            indexStream.end();
            try {
                await browser.close();
            } catch {
                /* ignore */
            }
            resolveDone();
        };
        process.once('SIGINT', finish);
        process.once('SIGTERM', finish);
        // If the browser window is closed manually, also wrap up.
        browser.on('close', finish);
    });

    console.log(`[recon] done. ${stats.captured} responses captured → ${opts.out}`);
    process.exit(0);
}

// writeSummary: emits a human-readable markdown summary ranking endpoints
// by hit count, with sample filenames so the analyst can jump straight to
// the payload.
// input  : opts, stats
// output : void (writes <out>/summary.md)
async function writeSummary(opts, stats) {
    const lines = [];
    lines.push('# JobRight recon summary');
    lines.push('');
    lines.push(`- started: ${stats.startedAt}`);
    lines.push(`- ended: ${new Date().toISOString()}`);
    lines.push(`- total captured: **${stats.captured}**  (json: ${stats.json}, other: ${stats.other})`);
    lines.push('');
    lines.push('## Status codes');
    for (const [code, count] of [...stats.status.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`- ${code}: ${count}`);
    }
    lines.push('');
    lines.push('## Endpoints (by hit count)');
    lines.push('');
    lines.push('| count | methods | path | content-types | sample file |');
    lines.push('|------:|---------|------|---------------|-------------|');
    const sortedPaths = [...stats.paths.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [path, info] of sortedPaths) {
        lines.push(
            `| ${info.count} | ${[...info.methods].join(',')} | \`${path}\` | ${[...info.contentTypes].join(', ')} | \`${info.sampleFile}\` |`,
        );
    }
    lines.push('');
    lines.push('## Suggested follow-up');
    lines.push('');
    lines.push('1. In the table above, identify the endpoint that fires on initial /jobs/recommend load and repeats on scroll — that is the **list** endpoint.');
    lines.push('2. Identify an endpoint that fires when a single job card is clicked — that is the **detail** endpoint (may not exist if detail is embedded in the list payload).');
    lines.push('3. Identify the endpoint that fires when a filter chip is toggled — this tells us whether filters mutate the same URL or hit a separate apply endpoint.');
    lines.push('4. Open the sample file for each and record field shapes in `docs/reconnaissance.md`.');
    lines.push('');
    await writeFile(`${opts.out}/summary.md`, lines.join('\n'));
    console.log(`[recon] wrote summary: ${opts.out}/summary.md`);
    // Also surface the top 10 on stdout for convenience.
    console.log('\nTop endpoints by hit count:');
    for (const [path, info] of sortedPaths.slice(0, 10)) {
        console.log(
            `  ${info.count.toString().padStart(3, ' ')}x  [${[...info.methods].join(',')}]  ${path}`,
        );
    }
}

main().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
});
