// Env loader + validator.
// Reads process.env once, runs a zod schema, exits with a readable list of
// problems if anything is wrong. The rest of the app imports `env` and trusts it.

import { z } from 'zod';

// --- zod helpers for boolean-ish and numeric-ish env vars ----------------

// Errors raised inside a zod `.transform()` via `throw` bypass zod's issue
// aggregator and lose the field path. We therefore use `ctx.addIssue(...)`
// + `return z.NEVER` so bad values bubble up through `safeParse` with their
// key intact and the final error message includes the env var name.

// envBool: accepts "1"/"0"/"true"/"false"/"yes"/"no"/"" (case-insensitive).
// Empty string coerces to the given default so "unset" feels natural.
const envBool = (defaultValue) =>
    z
        .string()
        .optional()
        .transform((raw, ctx) => {
            if (raw === undefined || raw === '') return defaultValue;
            const v = raw.trim().toLowerCase();
            if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
            if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `must be one of 1/0/true/false/yes/no, got "${raw}"`,
            });
            return z.NEVER;
        });

// envInt: parses an integer within an optional [min,max]. Empty → default.
const envInt = (defaultValue, { min, max } = {}) =>
    z
        .string()
        .optional()
        .transform((raw, ctx) => {
            if (raw === undefined || raw === '') return defaultValue;
            const n = Number(raw);
            if (!Number.isFinite(n) || !Number.isInteger(n)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `must be an integer, got "${raw}"`,
                });
                return z.NEVER;
            }
            if (min !== undefined && n < min) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `must be >= ${min}, got ${n}`,
                });
                return z.NEVER;
            }
            if (max !== undefined && n > max) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `must be <= ${max}, got ${n}`,
                });
                return z.NEVER;
            }
            return n;
        });

// envUrl: validates the value parses as a URL (or returns default if unset).
const envUrl = (defaultValue) =>
    z
        .string()
        .optional()
        .transform((raw, ctx) => {
            const value = raw === undefined || raw === '' ? defaultValue : raw;
            try {
                // will throw if malformed
                // eslint-disable-next-line no-new
                new URL(value);
            } catch {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `must be a valid URL, got "${raw}"`,
                });
                return z.NEVER;
            }
            return value;
        });

// --- schema --------------------------------------------------------------

const schema = z.object({
    PORT: envInt(8092, { min: 1, max: 65535 }),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z
        .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
        .default('info'),

    STORAGE_DIR: z.string().default('./storage'),
    RUNS_DIR: z.string().default('./runs'),
    AI_CACHE_DIR: z.string().default('./ai-cache'),

    HEADLESS: envBool(true),
    STEALTH: envBool(false),
    DEBUG_CAPTURE: envBool(false),
    RECORD_HAR: envBool(false),
    DRY_RUN: envBool(false),

    // When true (default), JR job-detail extraction navigates to the ORIGINAL
    // employer applyLink and scrapes the real job description + location from
    // the company / ATS page (JSON-LD JobPosting → ATS selectors → heuristic),
    // falling back to JR's composed summary only if that fails / is bot-walled.
    // Set false to use JR's structured JD directly (faster, but summary-only).
    JR_SCRAPE_EMPLOYER: envBool(true),
    // Per-employer-page navigation budget. Raise if target ATSes are slow.
    JR_EMPLOYER_TIMEOUT_MS: envInt(25_000, { min: 5_000, max: 60_000 }),

    DASHBOARD_BASE: envUrl('http://localhost:8086'),
    DASHBOARD_SERVICE_TOKEN: z.string().optional().default(''),

    RESUME_BASE: envUrl('http://localhost:8001'),

    // Required only when AI features are exercised (Phase 4+).
    // Keep it optional here so Phase 1 can boot without a key.
    OPENAI_API_KEY: z.string().optional().default(''),
    OPENAI_MODEL: z.string().default('gpt-4o-mini'),

    JOBRIGHT_BASE: envUrl('https://jobright.ai'),
    JOBRIGHT_COOLDOWN_MS: envInt(900_000, { min: 0 }),
    // Exponential-backoff ceiling for CONSECUTIVE cooldowns. Each repeat
    // throttle doubles the base wait (15m→30m→1h…) up to this cap.
    JOBRIGHT_COOLDOWN_MAX_MS: envInt(4 * 60 * 60 * 1000, { min: 0 }),
    // Anti-throttle: pause between JR page fetches so request cadence isn't
    // robotic. Actual wait = DELAY + random(0..JITTER). Set both 0 to disable.
    JOBRIGHT_PAGE_DELAY_MS: envInt(400, { min: 0, max: 60_000 }),
    JOBRIGHT_PAGE_JITTER_MS: envInt(2_000, { min: 0, max: 60_000 }),
    // Browser fingerprint normalisation (reduces automation signal).
    JR_USER_AGENT: z.string().optional().default(''),
    JR_LOCALE: z.string().default('en-US'),
    JR_TIMEZONE: z.string().optional().default(''),
    // Recycle the shared Chromium context every N ms to flush memory leaks
    // (long-running headless Chromium grows unbounded). 0 disables.
    CHROMIUM_RECYCLE_MS: envInt(6 * 60 * 60 * 1000, { min: 0 }),
    // Caller-side timeout for a single mutex-guarded browser op. Surfaces a
    // clean error to the HTTP caller instead of an indefinite hang. 0 = off.
    MUTEX_OP_TIMEOUT_MS: envInt(0, { min: 0, max: 600_000 }),
    // Delete runs/<id>/ directories older than N days on boot (keeps the
    // cold-start state scan + disk bounded). 0 disables pruning.
    RUNS_RETENTION_DAYS: envInt(7, { min: 0, max: 365 }),

    // JobRight credentials for programmatic login. If absent, the scraper
    // falls back to manual headed login via POST /api/admin/first-login.
    JOBRIGHT_EMAIL: z.string().optional().default(''),
    JOBRIGHT_PASSWORD: z.string().optional().default(''),

    // --- MongoDB (optional) --------------------------------------------
    // When MONGO_URI is set, per-client filters + feedback are persisted to
    // Mongo instead of disk JSON. Same connection string the dashboard uses.
    // MONGO_DB defaults to `flashfire_scraper` to keep the scraper's data in
    // its own namespace when sharing a cluster with the dashboard.
    MONGO_URI: z.string().optional().default(''),
    MONGO_DB: z.string().optional().default('flashfire_scraper'),

    // --- Discord webhook (optional) ------------------------------------
    // Ops channel that receives terminal-run alerts: success with counts,
    // failure with error code, no-jobs warnings, cooldown triggers. Empty
    // string disables alerts (zero-config default). The URL itself is a
    // capability token — treat as SECRET.
    DISCORD_WEBHOOK_URL: z.string().optional().default(''),

    // --- CORS allowlist extension (optional) ---------------------------
    // Comma-separated list of extra origins that may call /api/* beyond
    // the built-in loopback + hq.flashfirejobs.com defaults.
    CORS_EXTRA_ORIGINS: z.string().optional().default(''),

    // --- Debug-routes shared secret (optional) -------------------------
    // Gates /api/debug/* — when empty the routes are open (use only on a
    // firewalled box). When set, callers must send `X-Debug-Token: <val>`.
    DEBUG_TOKEN: z.string().optional().default(''),
});

// loadEnv: parses process.env against the schema. On failure, formats a clear
// human-readable error list and throws. Callers should catch once in server
// bootstrap and exit(1).
export function loadEnv(rawEnv = process.env) {
    const result = schema.safeParse(rawEnv);
    if (result.success) return Object.freeze(result.data);

    const issues = result.error.issues
        .map((issue) => {
            const key = issue.path.join('.') || '<root>';
            return `  - ${key}: ${issue.message}`;
        })
        .join('\n');
    const err = new Error(`Invalid environment configuration:\n${issues}`);
    err.code = 'ENV_VALIDATION_FAILED';
    throw err;
}

// Default export is the validated, frozen config.
// Import as: `import { env } from './config/env.js'`.
export const env = loadEnv();
