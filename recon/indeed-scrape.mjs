// Standalone Indeed click-based scraper (Playwright).
//
// Why a standalone script (not the browser extension): switching Indeed's
// right-hand detail pane requires a TRUSTED click. A content-script's
// synthetic `.click()` is untrusted — Indeed's React handler ignores it and
// the anchor just navigates to /viewjob (404). Playwright fires real OS
// clicks, so it can drive the pane exactly like a human operator.
//
// Flow (per card, like a human):
//   1. real-click the card  → right pane loads → read #jobDescriptionText
//   2. skip Easy Apply (Indeed-hosted) — keep only "Apply on company site"
//   3. real-click "Apply on company site" → a new tab opens and follows
//      Indeed's redirect to the ORIGINAL employer URL → capture it → close
//   4. collect {jobId,title,company,location,salary,jobType,description,applyUrl}
//   5. paginate via "Next page" and repeat
//
// Persistent context (./storage/indeed-profile) keeps cookies + Cloudflare
// clearance + any Indeed login between runs. First run is headed so you can
// clear Cloudflare / log in once.
//
// Usage:
//   node recon/indeed-scrape.mjs "<indeed search url>" [maxPages]
//   MAX_PAGES=3 HEADLESS=0 node recon/indeed-scrape.mjs
//   # optional dashboard push:
//   PUSH=1 CLIENT_EMAIL=foo@bar.com CLIENT_NAME="Foo" \
//   API_BASE=https://dashboard-api.flashfirejobs.com \
//   node recon/indeed-scrape.mjs "<url>" 2
//
// Output: prints a JSON array + writes runs/indeed-<timestamp>.json

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

const SEARCH_URL = process.argv[2]
    || 'https://ca.indeed.com/jobs?q=software+developer&l=Toronto%2C+ON';
const MAX_PAGES = Number(process.argv[3] || process.env.MAX_PAGES || 3);
const HEADLESS = /^(1|true|yes)$/i.test(String(process.env.HEADLESS ?? '0'));
const PROFILE_DIR = process.env.IND_PROFILE || join(REPO, 'storage', 'indeed-profile');
const JD_MIN = 80;

const PUSH = /^(1|true|yes)$/i.test(String(process.env.PUSH ?? '0'));
const CLIENT_EMAIL = process.env.CLIENT_EMAIL || '';
const CLIENT_NAME = process.env.CLIENT_NAME || '';
const API_BASE = (process.env.API_BASE || 'https://dashboard-api.flashfirejobs.com').replace(/\/+$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isIndeedHost = (u) => { try { return /(^|\.)indeed\.com$/i.test(new URL(u).hostname); } catch { return false; } };

// ---- per-card extraction (runs in page context) -------------------------
async function readDetailPane(page) {
    return page.evaluate(() => {
        const txt = (sel) => {
            const el = document.querySelector(sel);
            return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
        };
        const jdEl = document.querySelector('#jobDescriptionText, [data-testid="jobsearch-JobComponent-description"]');
        const description = jdEl ? (jdEl.textContent || '').replace(/\n{3,}/g, '\n\n').trim() : '';
        // Apply button text decides Easy Apply vs company-site.
        const applyBtn = [...document.querySelectorAll('button, a')]
            .find((b) => /apply/i.test(b.textContent || '') && /company site|apply now|apply on/i.test(b.textContent || ''));
        const applyText = applyBtn ? (applyBtn.textContent || '').trim() : '';
        return {
            title: txt('h2[data-testid="simpler-jobTitle"]') || txt('h2.jobsearch-JobInfoHeader-title'),
            company: txt('[data-company-name="true"]') || txt('[data-testid="inlineHeader-companyName"]'),
            location: txt('[data-testid="jobsearch-JobInfoHeader-companyLocation"]') || txt('#jobLocationText'),
            salaryType: txt('#salaryInfoAndJobType'),
            description,
            applyText,
            // Easy Apply = Indeed-hosted ("Apply now" / Indeed Apply), no
            // "company site" wording.
            easyApply: !!applyText && !/company site/i.test(applyText),
        };
    });
}

// ---- resolve the original employer URL via the Apply button -------------
async function resolveApplyUrl(context, page) {
    const applyBtn = page.locator(
        'button[contenthtml="Apply on company site"], a[aria-label*="Apply on company site"], button:has-text("Apply on company site")',
    ).first();
    if (!(await applyBtn.count())) return '';
    let popup = null;
    try {
        [popup] = await Promise.all([
            context.waitForEvent('page', { timeout: 20000 }),
            applyBtn.click({ timeout: 8000 }),
        ]);
    } catch {
        return ''; // no new tab opened
    }
    let url = '';
    try {
        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        url = popup.url();
        // applystart → (apply.indeed) → employer. Wait until it leaves indeed.
        for (let i = 0; i < 40 && (!url || isIndeedHost(url) || url === 'about:blank'); i++) {
            await sleep(300);
            url = popup.url();
        }
    } catch { /* ignore */ }
    try { await popup.close(); } catch {}
    return isIndeedHost(url) ? '' : url;
}

// ---- dashboard push (optional) ------------------------------------------
async function pushToDashboard(job) {
    const payload = {
        jobDetails: {
            userID: CLIENT_EMAIL.toLowerCase(),
            jobTitle: String(job.title).slice(0, 50),
            companyName: job.company,
            jobLocation: job.location || '',
            jobDescription: job.description || '',
            joblink: job.applyUrl || `https://ca.indeed.com/viewjob?jk=${job.jobId}`,
        },
        userDetails: { email: CLIENT_EMAIL.toLowerCase(), name: CLIENT_NAME || CLIENT_EMAIL },
        role: 'operations',
        operationsEmail: 'scraper@flashfirehq',
        operationsName: 'IndeedScraper',
    };
    try {
        const res = await fetch(`${API_BASE}/addjob`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        return { status: res.status, ok: res.status === 200, message: body.message || body.error || '' };
    } catch (e) {
        return { status: 0, ok: false, message: e.message };
    }
}

async function main() {
    console.log(`[indeed] launching (headless=${HEADLESS}) profile=${PROFILE_DIR}`);
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: HEADLESS,
        viewport: null,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = context.pages()[0] || await context.newPage();

    console.log(`[indeed] goto ${SEARCH_URL}`);
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

    // Wait for cards; if Cloudflare is up, give the operator time (headed).
    try {
        await page.waitForSelector('div.job_seen_beacon', { timeout: 60000 });
    } catch {
        console.error('[indeed] no job cards — Cloudflare challenge or empty search. '
            + 'Run with HEADLESS=0 and clear it once; the profile persists.');
        await context.close();
        process.exit(1);
    }

    const results = [];
    const seen = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
        await page.waitForSelector('div.job_seen_beacon', { timeout: 30000 }).catch(() => {});
        const jks = await page.$$eval('div.job_seen_beacon a[data-jk]',
            (as) => [...new Set(as.map((a) => a.getAttribute('data-jk')).filter(Boolean))]);
        console.log(`[indeed] page ${pageNum}: ${jks.length} cards`);

        for (const jk of jks) {
            if (seen.has(jk)) continue;
            seen.add(jk);
            const link = page.locator(`a[data-jk="${jk}"]`).first();
            if (!(await link.count())) continue;
            // Sponsored/ad placeholder cards carry a fake jk and aren't
            // visible — skip them without the noisy click timeout.
            if (!(await link.isVisible().catch(() => false))) continue;
            try {
                await link.scrollIntoViewIfNeeded({ timeout: 5000 });
                await link.click({ timeout: 8000 });
            } catch (e) {
                console.warn(`[indeed] ${jk} click failed: ${e.message}`);
                continue;
            }
            // Wait for the pane to switch to this jk + the JD to populate.
            await page.waitForFunction(
                (id) => new URLSearchParams(location.search).get('vjk') === id,
                jk, { timeout: 15000 },
            ).catch(() => {});
            await page.waitForSelector('#jobDescriptionText', { timeout: 12000 }).catch(() => {});
            await sleep(400);

            const detail = await readDetailPane(page);
            if (detail.easyApply) {
                console.log(`[indeed] ${jk} SKIP easy-apply — ${detail.title}`);
                continue;
            }
            if (!detail.description || detail.description.length < JD_MIN) {
                console.warn(`[indeed] ${jk} thin/empty JD (${detail.description.length}) — ${detail.title}`);
            }

            const applyUrl = await resolveApplyUrl(context, page);

            const job = {
                jobId: jk,
                title: detail.title,
                company: detail.company,
                location: detail.location,
                salary: detail.salaryType,
                description: detail.description,
                applyUrl,
                indeedUrl: `https://ca.indeed.com/viewjob?jk=${jk}`,
                capturedAt: new Date().toISOString(),
            };
            results.push(job);
            console.log(`[indeed] ✓ ${detail.title} @ ${detail.company} | JD ${detail.description.length}c | ${applyUrl || '(no employer url)'}`);

            if (PUSH && CLIENT_EMAIL && job.title && job.company) {
                const r = await pushToDashboard(job);
                console.log(`[indeed]   push → ${r.status} ${r.ok ? 'ok' : r.message}`);
            }
            await sleep(500 + Math.floor(800 * ((jk.charCodeAt(0) % 10) / 10))); // jitter
        }

        // Next page.
        const next = page.locator('a[data-testid="pagination-page-next"]').first();
        if (pageNum < MAX_PAGES && (await next.count())) {
            try {
                await next.click({ timeout: 8000 });
                await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
                await sleep(1500);
            } catch {
                console.log('[indeed] no further pages');
                break;
            }
        } else {
            break;
        }
    }

    mkdirSync(join(REPO, 'runs'), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = join(REPO, 'runs', `indeed-${stamp}.json`);
    writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`\n[indeed] DONE — ${results.length} jobs → ${outPath}`);
    console.log(JSON.stringify(results, null, 2));

    await context.close();
}

main().catch((e) => { console.error('[indeed] fatal', e); process.exit(1); });
