// OpenAI client tailored to our use-case: JSON-mode completions with retry,
// classification, and optional zod validation + disk cache.
//
// Design notes:
//   - We hide the SDK behind `completionFn` injection so unit tests are fully
//     deterministic with zero SDK surface.
//   - Retries cover transient failures (429, 5xx, network). Auth errors do
//     NOT retry — retrying a bad key just wastes time.
//   - Cache is keyed by model + system + user + schemaName. Identical prompt
//     = zero cost on replay. Cache is opt-in (pass a cache to the factory).
//   - Output is a Result<T,E>. Never throws on expected failure modes.

import { ok, err } from '../clients/common/result.js';
import { hashPromptKey } from './keyHash.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// classifyError: inspect an exception from the OpenAI SDK (or injected
// completionFn) and return a stable code. Shape used:
//   { status:number?, code?:string, type?:string, message?:string }
// Anything not matching a known shape falls through to NETWORK.
function classifyError(e) {
    const status = typeof e?.status === 'number' ? e.status : null;
    if (status === 401 || status === 403) return 'AUTH';
    if (status === 429) return 'RATE_LIMITED';
    if (status && status >= 500 && status < 600) return 'SERVER_ERROR';
    if (status === 408 || e?.code === 'ETIMEDOUT' || e?.name === 'AbortError') {
        return 'TIMEOUT';
    }
    return 'NETWORK';
}

function shouldRetryCode(code) {
    return code === 'RATE_LIMITED' || code === 'SERVER_ERROR' || code === 'TIMEOUT' || code === 'NETWORK';
}

// extractMessageContent: the OpenAI Chat Completions response places the
// model's text at `choices[0].message.content`. Defensive reads so a
// malformed envelope turns into a BAD_SHAPE rather than a NPE.
function extractMessageContent(response) {
    const choice = response?.choices?.[0];
    const content = choice?.message?.content;
    return typeof content === 'string' ? content : null;
}

// buildResponseFormat: when `schema` is provided we use Structured Outputs
// (strict JSON schema). When only JSON is needed, use plain json_object mode.
// input  : { schema?, schemaName }
// output : OpenAI response_format object
function buildResponseFormat({ schema, schemaName }) {
    if (schema) {
        return {
            type: 'json_schema',
            json_schema: {
                name: schemaName || 'Output',
                strict: true,
                schema,
            },
        };
    }
    return { type: 'json_object' };
}

// createOpenAIClient: factory.
//   Required : apiKey (unless you inject completionFn that doesn't need one)
//   Optional : model, cache, retries, temperature, logger, completionFn
// Returns   : { completeJson({system, user, schema?, schemaName?, zodSchema?}) }
export function createOpenAIClient({
    apiKey,
    model = DEFAULT_MODEL,
    cache = null,
    retries = DEFAULT_RETRIES,
    temperature = 0.1,
    logger = null,
    completionFn = null,
} = {}) {
    // Lazy-initialise the real SDK only when we need it. Avoids importing
    // the SDK during tests that inject `completionFn`.
    let sdkPromise = null;
    async function defaultCompletionFn(args) {
        if (!sdkPromise) {
            sdkPromise = import('openai').then(({ default: OpenAI }) => {
                if (!apiKey) throw Object.assign(new Error('OPENAI_API_KEY missing'), { status: 401 });
                return new OpenAI({ apiKey });
            });
        }
        const client = await sdkPromise;
        return client.chat.completions.create(args);
    }
    const complete = completionFn || defaultCompletionFn;

    // completeJson: the only public method. Input/output shape documented
    // at the top of this file.
    async function completeJson({
        system,
        user,
        schema = null, // JSON Schema object for Structured Outputs
        schemaName = 'Output',
        zodSchema = null, // optional zod parser for client-side validation
        cacheKey = null, // caller-provided cache key wins over the derived one
    } = {}) {
        if (typeof system !== 'string' || typeof user !== 'string') {
            return err('BAD_INPUT', 'system and user must be strings');
        }

        // --- cache read -------------------------------------------------
        const resolvedKey = cacheKey || hashPromptKey({ model, system, user, schemaName });
        if (cache) {
            const hit = await cache.get(resolvedKey);
            if (hit !== null && hit !== undefined) {
                logger?.debug?.({ key: resolvedKey.slice(0, 10) }, 'ai cache hit');
                return ok({ value: hit, cacheHit: true, key: resolvedKey });
            }
        }

        // --- SDK call with retry ----------------------------------------
        const requestArgs = {
            model,
            temperature,
            response_format: buildResponseFormat({ schema, schemaName }),
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
        };

        let lastCode = 'NETWORK';
        let lastMessage = '';
        let attempt = 0;
        let response;
        while (attempt <= retries) {
            try {
                response = await complete(requestArgs);
                break;
            } catch (e) {
                const code = classifyError(e);
                lastCode = code;
                lastMessage = e?.message || String(e);
                logger?.debug?.(
                    { attempt, code, status: e?.status },
                    'ai call failed',
                );
                if (!shouldRetryCode(code) || attempt >= retries) {
                    return err(code, lastMessage, { cause: e });
                }
                const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
                await sleep(delay);
                attempt += 1;
            }
        }

        // --- parse JSON -------------------------------------------------
        const content = extractMessageContent(response);
        if (!content) {
            return err('BAD_SHAPE', 'response missing choices[0].message.content', {
                cause: response,
            });
        }
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            return err('BAD_JSON', 'model returned non-JSON content', {
                cause: e,
                bodyText: content.slice(0, 500),
            });
        }

        // --- optional zod validation -----------------------------------
        if (zodSchema) {
            const parse = zodSchema.safeParse(parsed);
            if (!parse.success) {
                return err('BAD_SHAPE', 'model output failed zod validation', {
                    cause: parse.error,
                });
            }
            parsed = parse.data;
        }

        // --- cache write (best-effort) ---------------------------------
        if (cache) {
            await cache.set(resolvedKey, parsed);
        }

        return ok({ value: parsed, cacheHit: false, key: resolvedKey });
    }

    return { completeJson };
}
