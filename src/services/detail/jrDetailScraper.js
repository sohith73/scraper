// JR detail-page scraper.
//
// Extension flow: operator picks a job, hands jobId to scraper. Scraper
// opens https://jobright.ai/jobs/info/<jobId> in the persistent (logged-in)
// Chromium context, extracts __NEXT_DATA__, composes the full JD, and
// returns { applyLink, description }. Extension pushes that to dashboard.
//
// Why Playwright here vs the extension's own fetch:
//   - extension fetch from MV3 SW often loses third-party cookies,
//     depending on Chrome's cookie policy + JR's hydration path. Result:
//     SSR HTML returns the anonymous variant with empty jobResult.
//   - the scraper's persistent context is reliably authenticated and shares
//     identical headers across runs.
//
// Output (Result<T, E>):
//   ok  : { ok:true,  applyLink, description, raw }
//   err : { ok:false, error:'CODE', message }

import { ok, err } from '../../clients/common/result.js';
import { composeDescription } from '../../adapters/jobright.js';
import { probeViaPage } from '../../playwright/session.js';
import { scrapeEmployerPage, isScrapableEmployerUrl } from './employerPage.js';

const JR_DETAIL_PATH = (jobId) => `https://jobright.ai/jobs/info/${jobId}`;

// extractNextData: serialise __NEXT_DATA__ from the rendered page.
// Tries the inline script first; if absent (CSR-only render), reads the
// hydrated client-side store off `window.__NEXT_DATA__`.
async function extractNextData(page) {
    return page.evaluate(() => {
        const tag = document.getElementById('__NEXT_DATA__');
        if (tag && tag.textContent) {
            try {
                return JSON.parse(tag.textContent);
            } catch {
                /* fallthrough */
            }
        }
        if (window.__NEXT_DATA__) return window.__NEXT_DATA__;
        return null;
    });
}

// extractFromDom: last-resort fallback when __NEXT_DATA__ is missing the
// jobResult fields. Walks the rendered detail-page sections by their
// well-known headings (Responsibilities / Qualification / Required /
// Preferred / Benefits) and concatenates their visible text.
async function extractFromDom(page) {
    return page.evaluate(() => {
        function textOf(el) {
            if (!el) return '';
            return (el.innerText || el.textContent || '').trim();
        }
        function findHeading(name) {
            const all = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,div,span,p'));
            const target = name.toLowerCase();
            return all.find(
                (el) => el.children.length === 0 && (el.textContent || '').trim().toLowerCase() === target,
            );
        }
        function nextSiblingBlockText(headingEl) {
            if (!headingEl) return '';
            let cur = headingEl.parentElement;
            // climb up to the section container, then read the next sibling.
            while (cur && cur !== document.body && (!cur.nextElementSibling || textOf(cur.nextElementSibling).length < 20)) {
                cur = cur.parentElement;
            }
            if (!cur) return '';
            const sib = cur.nextElementSibling;
            return sib ? textOf(sib) : '';
        }
        const sections = [];
        const summaryEl = document.querySelector('article, main, [data-job-summary], .job-summary');
        if (summaryEl) {
            // Grab the first 1-2 paragraphs as a rough summary.
            const paras = summaryEl.querySelectorAll('p');
            if (paras.length) {
                const summary = Array.from(paras).slice(0, 2).map((p) => textOf(p)).filter(Boolean).join('\n\n');
                if (summary) sections.push(summary);
            }
        }
        for (const name of ['Responsibilities', 'Qualification', 'Required', 'Preferred', 'Benefits']) {
            const h = findHeading(name);
            if (!h) continue;
            const body = nextSiblingBlockText(h);
            if (body && body.length > 20) sections.push(`${name}:\n${body}`);
        }
        return sections.join('\n\n').trim();
    });
}

// scrapeJobDetail: navigate + extract + compose. Always closes the page.
// input  : { browser, mutex, env, logger, jobId, reqId? }
// output : Result<{applyLink, description, raw}, {code,message}>
export async function scrapeJobDetail({ browser, mutex, env, logger, jobId, reqId } = {}) {
    if (!browser) return err('BAD_INPUT', 'browser is required');
    if (!mutex) return err('BAD_INPUT', 'mutex is required');
    if (!jobId || typeof jobId !== 'string') {
        return err('BAD_INPUT', 'jobId (string) is required');
    }
    const t0 = Date.now();
    const ctxLog = (extra) => ({ reqId, jobId, ...extra });
    logger?.info?.(ctxLog({ phase: 'queue' }), 'jrDetailScraper: queued for mutex');
    return mutex.run(async () => {
        const tMutex = Date.now();
        logger?.info?.(ctxLog({ phase: 'mutex-acquired', waitMs: tMutex - t0 }), 'jrDetailScraper: mutex acquired');
        return browser.withContext({ headless: true }, async (ctx) => {
            const tCtx = Date.now();
            logger?.info?.(ctxLog({ phase: 'context-ready', ms: tCtx - tMutex }), 'jrDetailScraper: browser context ready');
            const page = await ctx.newPage();
            try {
                // Probe session before navigating — saves a 30s nav timeout
                // on dead sessions and surfaces NEEDS_REAUTH cleanly.
                if (env) {
                    const probe = await probeViaPage(page, env);
                    logger?.info?.(
                        ctxLog({ phase: 'probe', loggedIn: probe.loggedIn, status: probe.status, userId: probe.userInfo?.userId }),
                        'jrDetailScraper: session probe',
                    );
                    if (!probe.loggedIn) {
                        return err(
                            'NEEDS_REAUTH',
                            'JR session not logged in — run /api/admin/first-login',
                        );
                    }
                }
                const url = JR_DETAIL_PATH(jobId);
                logger?.info?.(ctxLog({ phase: 'navigate-start', url }), 'jrDetailScraper: navigating');
                const tNav = Date.now();
                const resp = await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30_000,
                });
                const navMs = Date.now() - tNav;
                if (!resp) {
                    logger?.warn?.(ctxLog({ phase: 'navigate-no-response', navMs }), 'jrDetailScraper: no response');
                    return err('NETWORK', 'no response from JR detail page');
                }
                logger?.info?.(
                    ctxLog({ phase: 'navigate-end', status: resp.status(), navMs, finalUrl: page.url() }),
                    'jrDetailScraper: navigation complete',
                );
                if (resp.status() >= 400) {
                    return err(`HTTP_${resp.status()}`, `JR returned ${resp.status()}`);
                }
                // give the client-side hydration a moment so that __NEXT_DATA__
                // population from any client-only store is finished.
                const tIdle = Date.now();
                const idleHit = await page
                    .waitForLoadState('networkidle', { timeout: 8_000 })
                    .then(() => true)
                    .catch(() => false);
                logger?.info?.(
                    ctxLog({ phase: 'idle', ms: Date.now() - tIdle, networkIdle: idleHit }),
                    'jrDetailScraper: networkidle wait',
                );

                const data = await extractNextData(page);
                const ds = data?.props?.pageProps?.dataSource || {};
                const jr = ds.jobResult || {};
                const applyLink = jr.applyLink || jr.originalUrl || ds.applyLink || ds.originalUrl || '';
                const ssrFound = !!data;
                const ssrJobId = jr.jobId || '';
                logger?.info?.(
                    ctxLog({
                        phase: 'ssr-extract',
                        ssrFound,
                        ssrJobId,
                        idMatch: ssrJobId === jobId,
                        applyLink,
                        title: jr.jobTitle || '',
                        company: ds.companyResult?.companyName || '',
                        summaryLen: (jr.jobSummary || '').length,
                        respCount: (jr.coreResponsibilities || []).length,
                        mustCount: (jr.qualifications?.mustHave || []).length,
                        prefCount: (jr.qualifications?.preferredHave || []).length,
                        skillCount: (jr.skillSummaries || []).length,
                        benefitCount: (jr.benefitsSummaries || []).length,
                    }),
                    'jrDetailScraper: SSR payload',
                );

                let description = composeDescription(jr);
                let usedDomFallback = false;
                if (!description || description.length < 200) {
                    logger?.warn?.(
                        ctxLog({ phase: 'ssr-thin', composedLen: description.length }),
                        'jrDetailScraper: SSR composed description too short — trying DOM fallback',
                    );
                    const domText = await extractFromDom(page);
                    logger?.info?.(
                        ctxLog({ phase: 'dom-fallback', domLen: domText.length }),
                        'jrDetailScraper: DOM fallback complete',
                    );
                    if (domText && domText.length > description.length) {
                        description = domText;
                        usedDomFallback = true;
                    }
                }
                if (!description) {
                    logger?.warn?.(ctxLog({ phase: 'no-description' }), 'jrDetailScraper: NO_DESCRIPTION');
                    return err('NO_DESCRIPTION', 'could not extract any description text');
                }
                if (!applyLink) {
                    logger?.warn?.(ctxLog({ phase: 'no-applylink' }), 'jrDetailScraper: NO_APPLYLINK');
                    return err('NO_APPLYLINK', 'dataSource has no applyLink/originalUrl');
                }

                // Prefer the REAL employer-site JD + location. JR only gives a
                // summary; the operator wants the description scraped from the
                // ORIGINAL company page. Navigate the (already-authenticated)
                // page to the employer applyLink and extract. Best-effort: keep
                // JR's composed JD as the floor if the employer page fails or is
                // bot-walled. Toggle with env JR_SCRAPE_EMPLOYER (default on).
                let location = jr.jobLocation || '';
                let descriptionSource = usedDomFallback ? 'jr-dom' : 'jr-ssr';
                const wantEmployer = !env || env.JR_SCRAPE_EMPLOYER !== false;
                if (wantEmployer && isScrapableEmployerUrl(applyLink)) {
                    const empTimeout = Number(env?.JR_EMPLOYER_TIMEOUT_MS) || 25_000;
                    logger?.info?.(ctxLog({ phase: 'employer-navigate', applyLink }), 'jrDetailScraper: scraping employer site');
                    const emp = await scrapeEmployerPage({ page, url: applyLink, logger, ctxLog, timeoutMs: empTimeout });
                    if (emp.ok && emp.description && emp.description.length >= 200) {
                        description = emp.description;
                        descriptionSource = `employer:${emp.source}`;
                    }
                    if (emp.location) location = emp.location;
                    logger?.info?.(
                        ctxLog({
                            phase: 'employer-result',
                            ok: emp.ok,
                            source: emp.source || '',
                            empDescLen: emp.description?.length || 0,
                            empLocation: emp.location || '',
                            error: emp.error || '',
                            finalUrl: emp.finalUrl || '',
                        }),
                        'jrDetailScraper: employer scrape result',
                    );
                } else {
                    logger?.info?.(
                        ctxLog({ phase: 'employer-skip', applyLink, reason: wantEmployer ? 'host-not-scrapable' : 'disabled' }),
                        'jrDetailScraper: skipped employer scrape',
                    );
                }

                logger?.info?.(
                    ctxLog({
                        phase: 'extract-ok',
                        applyLink,
                        descLen: description.length,
                        descriptionSource,
                        location,
                        usedDomFallback,
                        totalMs: Date.now() - t0,
                    }),
                    'jrDetailScraper: extracted',
                );
                return ok({
                    applyLink,
                    description,
                    raw: {
                        title: jr.jobTitle || '',
                        company: ds.companyResult?.companyName || '',
                        location,
                        descriptionSource,
                        publishedAt: jr.publishTime || '',
                        tags: [
                            ...(jr.recommendationTags || []),
                            ...(jr.jobTags || []),
                        ],
                        h1bSponsor: !!jr.isH1bSponsor,
                        usedDomFallback,
                    },
                });
            } catch (e) {
                logger?.error?.(
                    ctxLog({ phase: 'threw', err: e.message, stack: e.stack, totalMs: Date.now() - t0 }),
                    'jrDetailScraper: threw',
                );
                return err('SCRAPER_ERROR', e.message || String(e));
            } finally {
                await page.close().catch(() => {});
            }
        });
    });
}
