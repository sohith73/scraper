// Employer-site JD scraper.
//
// JobRight only hands us a *summary* of a job. The operator wants the REAL
// description + location, scraped straight from the original employer / ATS
// page. After JR gives us the employer `applyLink`, we navigate the
// authenticated Playwright page to it and extract the full posting.
//
// Strategy (most reliable first):
//   1. schema.org `JobPosting` JSON-LD — Greenhouse, Lever, Ashby, Workday,
//      SmartRecruiters, iCIMS, LinkedIn and most company career sites embed
//      this. Gives clean `description` (HTML) + structured `jobLocation`.
//   2. Known ATS description containers (selector list).
//   3. Largest visible <main>/<article>/<section> text block.
//   4. Body text (capped) — last resort.
//
// ALWAYS best-effort: returns { ok:false, ... } on any failure so the caller
// keeps JR's composed JD as the floor. Never throws.
//
// Output:
//   { ok, description, location, source, finalUrl, error? }
//   ok === true means we navigated AND extracted something usable
//   (description >= 200 chars OR a non-empty location).

// Hosts we don't bother scraping: hard bot-walls / login gates, or handled by
// a dedicated path elsewhere (Indeed has its own in-extension scraper). For
// these we keep JR's composed JD + the JR-captured location.
const SKIP_HOSTS = [
    /(^|\.)linkedin\.com$/i,
    /(^|\.)indeed\.com$/i,
    /(^|\.)glassdoor\.[a-z.]+$/i,
    /(^|\.)ziprecruiter\.com$/i,
];

// isScrapableEmployerUrl: http(s), parseable, not a skip-host.
export function isScrapableEmployerUrl(url) {
    if (!url || typeof url !== 'string') return false;
    let u;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (SKIP_HOSTS.some((rx) => rx.test(u.hostname))) return false;
    return true;
}

// employerExtractInPage: runs INSIDE the page (serialised by Playwright, so
// it must be fully self-contained — no outer references). Returns
// { description, location, source }.
function employerExtractInPage() {
    function htmlToText(html) {
        if (!html) return '';
        const d = document.createElement('div');
        d.innerHTML = String(html);
        d.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
        const t = d.innerText || d.textContent || '';
        return t
            .replace(/ /g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }
    function addrText(a) {
        if (!a) return '';
        if (typeof a === 'string') return a.trim();
        const ad = a.address || a;
        if (typeof ad === 'string') return ad.trim();
        return [ad.addressLocality, ad.addressRegion, ad.addressCountry]
            .filter(Boolean)
            .join(', ');
    }
    function locFromPosting(jp) {
        const out = [];
        const jl = jp.jobLocation;
        if (Array.isArray(jl)) jl.map(addrText).filter(Boolean).forEach((s) => out.push(s));
        else if (jl) {
            const s = addrText(jl);
            if (s) out.push(s);
        }
        const remote = /telecommute/i.test(String(jp.jobLocationType || ''));
        if (out.length === 0 && jp.applicantLocationRequirements) {
            const alr = Array.isArray(jp.applicantLocationRequirements)
                ? jp.applicantLocationRequirements
                : [jp.applicantLocationRequirements];
            const names = alr.map((x) => x && (x.name || x.addressCountry)).filter(Boolean);
            if (names.length) out.push((remote ? 'Remote — ' : '') + names.join(', '));
        } else if (remote) {
            out.unshift('Remote');
        }
        return out.join(' | ');
    }

    // 1) JSON-LD JobPosting (walks @graph + arrays).
    const blocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const b of blocks) {
        let parsed;
        try {
            parsed = JSON.parse(b.textContent);
        } catch {
            continue;
        }
        const found = [];
        const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                node.forEach(walk);
                return;
            }
            const ty = node['@type'];
            if (ty === 'JobPosting' || (Array.isArray(ty) && ty.includes('JobPosting'))) found.push(node);
            if (node['@graph']) walk(node['@graph']);
        };
        walk(parsed);
        for (const jp of found) {
            const desc = htmlToText(jp.description || '');
            if (desc && desc.length >= 200) {
                return { description: desc, location: locFromPosting(jp), source: 'jsonld' };
            }
        }
    }

    // 2) Known ATS / common description containers.
    const SELECTORS = [
        '[data-automation-id="jobPostingDescription"]', // Workday
        '#content .body',                               // Greenhouse classic
        '#grnhse_app',                                  // Greenhouse embed
        '.job__description',                            // common
        '.jobDescriptionContent',                       // common
        '[data-qa="job-description"]',                  // Lever / others
        '.posting .section-wrapper',                    // Lever
        '[class*="_descriptionText"]',                  // Ashby
        '[class*="JobDescription"]',                    // various
        '#job-details',
        '#jobDescriptionText',
        '.description__text',                           // LinkedIn-like
        'main article',
        'article',
        'main',
    ];
    for (const sel of SELECTORS) {
        let el;
        try {
            el = document.querySelector(sel);
        } catch {
            continue;
        }
        if (!el) continue;
        const t = (el.innerText || el.textContent || '').trim();
        if (t && t.length >= 300) {
            return { description: t.replace(/\n{3,}/g, '\n\n').trim(), location: '', source: `selector:${sel}` };
        }
    }

    // 3) Largest visible text block.
    let best = '';
    let bestLen = 0;
    for (const el of document.querySelectorAll('main, article, section, div')) {
        const t = (el.innerText || '').trim();
        if (t.length > bestLen && t.length <= 18000) {
            best = t;
            bestLen = t.length;
        }
    }
    if (best && bestLen >= 400) {
        return { description: best.replace(/\n{3,}/g, '\n\n').trim(), location: '', source: 'heuristic' };
    }

    // 4) Body text, capped.
    const body = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    if (body && body.length >= 400) {
        return { description: body.slice(0, 8000), location: '', source: 'body' };
    }
    return { description: '', location: '', source: 'none' };
}

// scrapeEmployerPage: navigate `page` to the employer URL and extract JD +
// location. Caller already holds the mutex + an authenticated context; we
// reuse the same page (JR data was already extracted before this call).
//   input  : { page, url, logger?, ctxLog?, timeoutMs? }
//   output : { ok, description, location, source, finalUrl, error? }
export async function scrapeEmployerPage({ page, url, logger, ctxLog = (x) => x, timeoutMs = 25_000 } = {}) {
    if (!page) return { ok: false, error: 'NO_PAGE' };
    if (!isScrapableEmployerUrl(url)) return { ok: false, error: 'SKIP_HOST' };
    try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        if (!resp) return { ok: false, error: 'EMP_NO_RESPONSE', finalUrl: page.url() };
        const status = resp.status();
        if (status >= 400) return { ok: false, error: `EMP_HTTP_${status}`, finalUrl: page.url() };
        // JSON-LD is in the initial HTML, but give SPA ATSes a beat to hydrate.
        await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
        const out = await page.evaluate(employerExtractInPage);
        const description = String(out?.description || '').trim();
        const location = String(out?.location || '').trim();
        const source = out?.source || 'none';
        const finalUrl = page.url();
        const usable = description.length >= 200 || !!location;
        logger?.info?.(
            ctxLog({ phase: 'employer-extract', source, descLen: description.length, location, status, finalUrl }),
            'scrapeEmployerPage: extracted',
        );
        return { ok: usable, description, location, source, finalUrl };
    } catch (e) {
        logger?.warn?.(ctxLog({ phase: 'employer-threw', err: e?.message }), 'scrapeEmployerPage: threw');
        return { ok: false, error: 'EMP_THREW', message: e?.message || String(e) };
    }
}
