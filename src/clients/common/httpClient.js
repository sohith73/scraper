// Generic HTTP client used by every outbound integration (dashboard,
// resume, future OpenAI). Nothing dashboard-specific lives in here.
//
// Responsibilities:
//   - attach the shared service token (if configured) to every call
//   - honour a per-call AbortController timeout
//   - retry network errors + 5xx with exponential backoff (NOT 4xx — those
//     are real domain signals from the server)
//   - parse JSON bodies defensively
//   - throw a typed HttpError so domain modules can switch on `.kind`
//
// Deliberately NOT wrapping errors into Result<>: the caller (listClients,
// pushJob, etc.) does the conversion once it knows the domain semantics
// of each status code.

// HttpError.kind values — stable strings, used by domain modules.
//   'network'    : DNS / socket / abort due to process signal
//   'timeout'    : our AbortController fired
//   'bad-status' : response whose status we didn't retry and caller hasn't
//                  domain-interpreted (usually the final 4xx)
//   'bad-json'   : response.ok but the body wasn't parseable JSON
export class HttpError extends Error {
    constructor(kind, message, { status, bodyJson, bodyText, cause } = {}) {
        super(message);
        this.name = 'HttpError';
        this.kind = kind;
        this.status = status;
        this.bodyJson = bodyJson;
        this.bodyText = bodyText;
        if (cause) this.cause = cause;
    }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 300;

// sleep: tiny util, kept local so this module has zero deps.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// shouldRetry: returns true when an error or response warrants another
// attempt. Retries are for transport-level problems and server overload —
// never for client errors the server wants us to see.
// input  : { error?:Error, status?:number }
// output : boolean
function shouldRetry({ error, status }) {
    if (error) {
        // Abort-due-to-timeout we DO retry; abort-due-to-parent-abort we don't.
        if (error.name === 'AbortError') return Boolean(error.__timeout);
        return true; // any other network-level error
    }
    // 429 = "Too Many Requests". Always safe to back off + retry. Without
    // this, transient dashboard rate-limit hiccups (Express express-rate-limit
    // / Cloudflare bot-throttle) bubble straight up as BAD_STATUS and fail
    // the whole run on the very first phase.
    if (status === 429) return true;
    if (status && status >= 500 && status <= 599) return true;
    return false;
}

// retryDelay: returns the ms to wait before the next attempt. Honours the
// server's `Retry-After` header (seconds OR HTTP-date) when present, else
// falls back to exponential 300ms · 2^attempt.
//   input  : { attempt, headers? }
//   output : ms
function retryDelay({ attempt, headers }) {
    const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
    const ra = headers?.get?.('retry-after');
    if (!ra) return base;
    const asInt = Number.parseInt(ra, 10);
    if (Number.isFinite(asInt) && asInt >= 0) return Math.min(asInt * 1000, 30_000);
    const asDate = Date.parse(ra);
    if (!Number.isNaN(asDate)) {
        const ms = asDate - Date.now();
        if (ms > 0) return Math.min(ms, 30_000);
    }
    return base;
}

// createHttpClient: factory. Returns an object with .get / .postJson
// / .putJson methods. Injected `fetchImpl` makes tests deterministic.
// input  : { baseUrl, serviceToken, fetchImpl, timeoutMs, retries }
// output : { get, postJson, putJson, request }
export function createHttpClient({
    baseUrl,
    serviceToken = '',
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    logger = null,
} = {}) {
    if (!baseUrl) throw new Error('createHttpClient: baseUrl is required');
    if (typeof fetchImpl !== 'function') {
        throw new Error('createHttpClient: fetchImpl must be a function');
    }
    const trimmedBase = baseUrl.replace(/\/+$/, '');

    // request: the core loop — a single call site wraps the fetch, retries,
    // and parses. Every other method is a thin shim.
    async function request(method, path, { body, headers, timeoutMs: callTimeoutMs } = {}) {
        const url = path.startsWith('http')
            ? path
            : `${trimmedBase}${path.startsWith('/') ? '' : '/'}${path}`;

        const effectiveTimeout = callTimeoutMs ?? timeoutMs;
        const mergedHeaders = {
            accept: 'application/json',
            ...(serviceToken ? { 'x-service-token': serviceToken } : {}),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(headers || {}),
        };

        let lastError;
        let attempt = 0;
        while (attempt <= retries) {
            const ac = new AbortController();
            const timer = setTimeout(() => {
                // Mark the abort as timeout-origin so shouldRetry can tell
                // the difference between user-cancel and our-cancel.
                ac.__timeout = true;
                ac.abort();
            }, effectiveTimeout);

            let response;
            try {
                response = await fetchImpl(url, {
                    method,
                    headers: mergedHeaders,
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: ac.signal,
                });
            } catch (error) {
                clearTimeout(timer);
                const isTimeout = ac.__timeout === true;
                if (isTimeout) error.__timeout = true;
                lastError = error;
                if (attempt < retries && shouldRetry({ error })) {
                    const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
                    logger?.debug?.({ url, attempt, err: error.message }, 'retrying after network error');
                    await sleep(delay);
                    attempt += 1;
                    continue;
                }
                if (isTimeout) {
                    throw new HttpError('timeout', `request timed out after ${effectiveTimeout}ms`, {
                        cause: error,
                    });
                }
                throw new HttpError('network', `network error: ${error.message}`, {
                    cause: error,
                });
            }
            clearTimeout(timer);

            const bodyText = await response.text().catch(() => '');
            let bodyJson;
            if (bodyText) {
                try {
                    bodyJson = JSON.parse(bodyText);
                } catch {
                    bodyJson = undefined;
                }
            }

            if (shouldRetry({ status: response.status }) && attempt < retries) {
                const delay = retryDelay({ attempt, headers: response.headers });
                logger?.warn?.(
                    { url, attempt, status: response.status, delayMs: delay },
                    `retrying after ${response.status}`,
                );
                await sleep(delay);
                attempt += 1;
                continue;
            }

            // Always return the envelope — status=0..599. Domain modules
            // interpret 4xx themselves. We only throw for post-ok bodies
            // that fail JSON parse when a caller explicitly asks for JSON.
            return { status: response.status, bodyText, bodyJson, headers: response.headers };
        }
        // Fallback (should be unreachable because the loop either returns
        // or throws above).
        throw new HttpError('network', lastError ? lastError.message : 'exhausted retries');
    }

    return {
        request,
        get: (path, opts) => request('GET', path, opts),
        postJson: (path, body, opts) => request('POST', path, { ...opts, body }),
        putJson: (path, body, opts) => request('PUT', path, { ...opts, body }),
    };
}
