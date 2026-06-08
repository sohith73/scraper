// htmlExtract — Tier 0 extraction: plain HTTP GET + server-side parse of
// schema.org JobPosting JSON-LD (with OpenGraph/meta fallback) straight from
// the raw HTML. NO browser, NO Chromium page, NO semaphore slot.
//
// Why : the dominant cost on the JD hot path was launching a Chromium page per
//       request (RAM + CPU + multi-second SPA settle). But ~70-80% of ATS
//       pages — Greenhouse, Lever, Ashby, SmartRecruiters, BambooHR, and many
//       company-direct sites — ship a full `JobPosting` JSON-LD block
//       (description + addressCountry/jobLocation) in the INITIAL HTML. A bare
//       `fetch()` + JSON.parse gets that in 200-800ms and scales to 100s
//       concurrent. Browser is only needed for JS-rendered SPA shells
//       (Workday app, etc.) and bot-walled hosts, which fall through to the
//       browser tier when this returns thin/empty.
//
// This is a straight port of the in-page extractor in
// playwright/extractors/json-ld.js, rewritten to walk a parsed object graph
// off a raw HTML string instead of a live DOM.

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// JD pages are small. Cap the body we read so a misrouted URL to some huge
// asset can't blow up memory.
const MAX_HTML_BYTES = 3_000_000;

// --- text + country helpers (kept in sync with fetchJobDetail.js) ----------

function textFromHtml(value) {
    return String(value || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

const COUNTRY_HINTS = [
    [/united states|usa|u\.s\.a\.|u\.s\.|\bus\b|remote\s*-\s*us|\bny\b|\bca\b|\btx\b|\bfl\b|\bwa\b/i, 'United States'],
    [/canada|toronto|vancouver|ontario|british columbia/i, 'Canada'],
    [/united kingdom|\buk\b|england|london/i, 'United Kingdom'],
    [/india|bengaluru|bangalore|mumbai|delhi|hyderabad|pune/i, 'India'],
    [/germany|berlin|munich/i, 'Germany'],
    [/france|paris/i, 'France'],
    [/australia|sydney|melbourne/i, 'Australia'],
    [/singapore/i, 'Singapore'],
];

export function countryFromLocation(location) {
    const loc = String(location || '').trim();
    if (!loc) return '';
    for (const [rx, country] of COUNTRY_HINTS) {
        if (rx.test(loc)) return country;
    }
    const parts = loc.split(/[,|/]/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
}

// --- JSON-LD parse ----------------------------------------------------------

// Pull every <script type="application/ld+json"> body out of the raw HTML.
function jsonLdBlocks(html) {
    const out = [];
    const rx = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = rx.exec(html)) !== null) {
        const raw = (m[1] || '').trim();
        if (raw) out.push(raw);
    }
    return out;
}

// Recursively collect all JobPosting objects (handles arrays + @graph).
function findJobPostings(data, result) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data)) {
        for (const item of data) findJobPostings(item, result);
        return;
    }
    if (Array.isArray(data['@graph'])) findJobPostings(data['@graph'], result);
    const type = data['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.indexOf('JobPosting') !== -1)) {
        result.push(data);
    }
}

function extractCompany(jp) {
    const org = jp.hiringOrganization;
    if (!org) return '';
    if (typeof org === 'string') return org;
    return org.name || org['@name'] || '';
}

function extractLocation(jp) {
    let location = '';
    if (jp.jobLocation) {
        const locs = Array.isArray(jp.jobLocation) ? jp.jobLocation : [jp.jobLocation];
        const parts = [];
        for (const loc of locs) {
            if (!loc) continue;
            if (typeof loc === 'string') {
                parts.push(loc);
            } else if (loc.address) {
                const addr = loc.address;
                if (typeof addr === 'string') {
                    parts.push(addr);
                } else {
                    const addrParts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
                    if (addrParts.length) parts.push(addrParts.join(', '));
                }
            } else if (loc.name) {
                parts.push(loc.name);
            }
        }
        location = parts.join(' | ');
    }
    if (jp.jobLocationType === 'TELECOMMUTE' || jp.applicantLocationRequirements) {
        location = location ? location + ' (Remote)' : 'Remote';
    }
    return location;
}

// JSON-LD addressCountry is usually an ISO code ("CA" = Canada, NOT
// California). Trust it over the location-string regex, which can't tell
// "CA"-the-country from "CA"-the-state.
const ISO_COUNTRY = {
    US: 'United States', USA: 'United States',
    CA: 'Canada', CAN: 'Canada',
    GB: 'United Kingdom', UK: 'United Kingdom',
    IN: 'India', DE: 'Germany', FR: 'France',
    AU: 'Australia', SG: 'Singapore',
};
function extractCountryFromPosting(jp) {
    if (!jp.jobLocation) return '';
    const locs = Array.isArray(jp.jobLocation) ? jp.jobLocation : [jp.jobLocation];
    for (const loc of locs) {
        const addr = loc && loc.address;
        if (!addr || typeof addr !== 'object') continue;
        const cc = typeof addr.addressCountry === 'string'
            ? addr.addressCountry
            : (addr.addressCountry?.name || '');
        const key = String(cc).trim().toUpperCase();
        if (ISO_COUNTRY[key]) return ISO_COUNTRY[key];
        if (cc) return String(cc).trim();
    }
    return '';
}

function extractType(jp) {
    if (!jp.employmentType) return '';
    const raw = Array.isArray(jp.employmentType) ? jp.employmentType.join(', ') : String(jp.employmentType);
    return raw
        .replace(/_/g, ' ')
        .replace(/FULL.?TIME/gi, 'Full-time')
        .replace(/PART.?TIME/gi, 'Part-time')
        .replace(/CONTRACT/gi, 'Contract')
        .replace(/INTERN/gi, 'Internship')
        .replace(/TEMPORARY/gi, 'Temporary');
}

// parseJobPostingFromHtml: returns { description, location, country, company,
// position, type } or null when no usable JobPosting JSON-LD is present.
export function parseJobPostingFromHtml(html) {
    const blocks = jsonLdBlocks(html);
    if (!blocks.length) return null;
    const postings = [];
    for (const b of blocks) {
        try {
            findJobPostings(JSON.parse(b), postings);
        } catch {
            // malformed JSON-LD block — skip
        }
    }
    if (!postings.length) return null;
    // Pick the most complete JobPosting when several exist.
    let jp = postings[0];
    if (postings.length > 1) {
        jp = postings.reduce((best, cur) =>
            Object.keys(cur).length > Object.keys(best).length ? cur : best,
        );
    }
    const description = textFromHtml(jp.description || '');
    const position = String(jp.title || jp.name || '').trim();
    const company = extractCompany(jp);
    const location = extractLocation(jp);
    const type = extractType(jp);
    if (!position && !company && !description) return null;
    return {
        description,
        location,
        country: extractCountryFromPosting(jp) || countryFromLocation(location),
        company,
        position,
        type,
    };
}

// httpExtractJobDetail: fetch the URL over plain HTTP and parse JobPosting
// JSON-LD. Returns { ok:true, description, location, country, company,
// position, type, finalUrl } on success, or { ok:false, error, message } on
// any failure (network, timeout, non-HTML, no JSON-LD). Never throws.
export async function httpExtractJobDetail(url, { timeoutMs = 8000, userAgent = DEFAULT_UA } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url, {
            redirect: 'follow',
            signal: ctrl.signal,
            headers: {
                'user-agent': userAgent,
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
            },
        });
    } catch (e) {
        clearTimeout(timer);
        return {
            ok: false,
            error: e?.name === 'AbortError' ? 'HTTP_TIMEOUT' : 'HTTP_NETWORK',
            message: e?.message || 'fetch failed',
        };
    }
    clearTimeout(timer);
    if (!res.ok) {
        return { ok: false, error: `HTTP_${res.status}`, message: `status ${res.status}`, finalUrl: res.url || url };
    }
    const ct = res.headers.get('content-type') || '';
    if (ct && !/html|xml|text/i.test(ct)) {
        return { ok: false, error: 'HTTP_NOT_HTML', message: ct, finalUrl: res.url || url };
    }
    let html;
    try {
        html = await res.text();
    } catch (e) {
        return { ok: false, error: 'HTTP_BODY', message: e?.message || 'read body failed' };
    }
    if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES);
    const parsed = parseJobPostingFromHtml(html);
    if (!parsed) {
        return { ok: false, error: 'NO_JSON_LD', message: 'no JobPosting JSON-LD in HTML', finalUrl: res.url || url };
    }
    return { ok: true, ...parsed, finalUrl: res.url || url };
}

export { DEFAULT_UA };
