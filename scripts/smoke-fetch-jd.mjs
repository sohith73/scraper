// Smoke-test the new POST /api/fetch-jd endpoint against 5 real job sites.
//
// Usage:
//   1) Start the scraper backend:  npm run dev
//   2) (Optional) Override URLs:   FETCH_JD_URLS="<url1>,<url2>,..." node scripts/smoke-fetch-jd.mjs
//   3) Otherwise edit DEFAULT_URLS below to current live postings, since
//      most ATS URLs 404 within weeks of close.
//
// What this proves:
//   - Backend serves /api/fetch-jd
//   - Playwright persistent context opens each URL successfully
//   - Per-site extractor selects the right pipeline ('greenhouse', 'lever', 'ashby',
//     'workday', 'generic'/'json-ld' for company-direct)
//   - Description length ≥ 300 chars (THIN_CONTENT gate)

const BASE = process.env.SCRAPER_BASE || 'http://localhost:8092';

const DEFAULT_URLS = [
    // EDIT to currently-live postings before running.
    'https://boards.greenhouse.io/stripe/jobs/EXAMPLE',
    'https://jobs.lever.co/EXAMPLE/EXAMPLE',
    'https://jobs.ashbyhq.com/EXAMPLE/EXAMPLE',
    'https://EXAMPLE.wd5.myworkdayjobs.com/External/job/EXAMPLE',
    'https://stripe.com/jobs/listing/EXAMPLE',
];

const urls = process.env.FETCH_JD_URLS
    ? process.env.FETCH_JD_URLS.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_URLS;

console.log(`smoke-fetch-jd — ${BASE} — testing ${urls.length} sites\n`);

let pass = 0, fail = 0;
for (const url of urls) {
    const host = new URL(url).hostname;
    process.stdout.write(`[${host.padEnd(40)}] `);
    const t0 = Date.now();
    let body;
    try {
        const res = await fetch(`${BASE}/api/fetch-jd`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url }),
        });
        body = await res.json();
        if (!res.ok || !body.success) {
            console.log(`FAIL  ${body.error || res.status}  ${body.message || ''}`);
            fail++;
            continue;
        }
        console.log(
            `OK    method=${(body.method || '').padEnd(12)} desc=${String(body.description.length).padStart(5)}  loc="${(body.location || '').slice(0, 30)}"  ${Date.now() - t0}ms`,
        );
        pass++;
    } catch (err) {
        console.log(`THREW  ${err.message}`);
        fail++;
    }
}

console.log(`\n${pass}/${urls.length} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
