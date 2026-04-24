// Shared helper: run a `fetch` inside a Playwright page's origin.
//
// Why : every same-origin API call the scraper makes (auth probe, login,
//       filter update, list jobs) benefits from riding the page's cookie
//       jar + browser fingerprint. Centralising the dance means one place
//       to tweak headers / timeouts / error handling.
//
// Returns the SAME shape regardless of success:
//   { status, body, bodyText, error? }   — status 0 indicates a transport
//                                            failure (CORS, net, etc.)
// Callers decide what "success" means (e.g. status===200 && body.success).

// pageFetch: single-call JSON-in / JSON-out helper.
// input  : page, { url, method?, body?, headers? }
// output : { status:number, body:any|null, bodyText:string, error?:string }
export async function pageFetch(page, { url, method = 'GET', body, headers = null } = {}) {
    if (!page || typeof page.evaluate !== 'function') {
        throw new TypeError('pageFetch: page must be a Playwright Page');
    }
    if (typeof url !== 'string' || !url) {
        throw new TypeError('pageFetch: url is required');
    }
    return page.evaluate(
        async ({ u, m, b, h }) => {
            try {
                const init = { method: m, credentials: 'include' };
                const reqHeaders = { accept: 'application/json' };
                if (b !== undefined) {
                    reqHeaders['content-type'] = 'application/json';
                    init.body = JSON.stringify(b);
                }
                if (h) Object.assign(reqHeaders, h);
                init.headers = reqHeaders;
                const r = await fetch(u, init);
                const text = await r.text();
                let parsed = null;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    /* non-JSON, leave null */
                }
                return { status: r.status, body: parsed, bodyText: text.slice(0, 1000) };
            } catch (e) {
                return { status: 0, body: null, bodyText: '', error: String(e) };
            }
        },
        { u: url, m: method, b: body, h: headers },
    );
}
