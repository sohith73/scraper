// Per-client filter store.
//
// Why : after an AI-derived intent or operator override is computed once,
//       we cache it so the next run for the same client pre-populates the
//       Advanced Filters UI. Eliminates the round-trip to gpt-4o-mini
//       entirely for repeat runs and gives operators a clear "this is what
//       we searched with last time, tweak it" workflow.
//
// Storage : one JSON file per client at <dir>/<email-slug>.json. Atomic
//           tmp-then-rename write. Best-effort — failures don't break runs.
//           dir perms 0700 since intent contains PII-adjacent fields.

import { mkdir, readFile, writeFile, rename, unlink, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// emailToSlug: filesystem-safe filename for a client email. Lowercased,
// non-alphanum replaced with `_`, bounded length, suffix = sha1 hash
// prefix so two emails that differ only by special chars don't collide.
function emailToSlug(email) {
    const lower = String(email).trim().toLowerCase();
    const safe = lower.replace(/[^a-z0-9]/g, '_').slice(0, 80);
    const hash = createHash('sha1').update(lower).digest('hex').slice(0, 8);
    return `${safe}-${hash}`;
}

// createClientFilterStore: factory.
// input  : { dir, logger? }
// output : { get(email), put(email, state), remove(email), list() }
export function createClientFilterStore({ dir, logger = null } = {}) {
    if (!dir || typeof dir !== 'string') {
        throw new TypeError('createClientFilterStore: dir is required');
    }

    async function ensureDir() {
        await mkdir(dir, { recursive: true });
        try { await chmod(dir, DIR_MODE); } catch { /* non-POSIX — ignore */ }
    }

    function pathFor(email) {
        return join(dir, `${emailToSlug(email)}.json`);
    }

    // get: read + parse the saved record for this client. Returns null when
    // absent or malformed (caller treats as "nothing saved yet").
    async function get(email) {
        if (typeof email !== 'string' || !email.includes('@')) return null;
        try {
            const raw = await readFile(pathFor(email), 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            return parsed;
        } catch {
            return null;
        }
    }

    // put: save { intent, overrides, meta } for the client. `meta` captures
    // where the data came from (e.g. lastRunId, AI vs. operator).
    // input  : email, { intent, overrides?, meta? }
    // output : the persisted record, or null on IO failure
    async function put(email, { intent = null, overrides = null, meta = {} } = {}) {
        if (typeof email !== 'string' || !email.includes('@')) return null;
        const record = {
            email: email.toLowerCase(),
            intent,
            overrides,
            meta: { ...meta, savedAt: new Date().toISOString() },
        };
        const final = pathFor(email);
        const tmp = `${final}.tmp-${process.pid}-${Date.now()}`;
        try {
            await ensureDir();
            await writeFile(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: FILE_MODE });
            await rename(tmp, final);
            return record;
        } catch (err) {
            logger?.warn?.({ err: err.message, email }, 'clientFilters.put failed');
            try { await unlink(tmp); } catch { /* ignore */ }
            return null;
        }
    }

    async function remove(email) {
        if (typeof email !== 'string' || !email.includes('@')) return false;
        try {
            await unlink(pathFor(email));
            return true;
        } catch {
            return false;
        }
    }

    // list: enumerate every saved record (small metadata only).
    // Returns: [{ email, savedAt, intentRoles, hasOverrides }]
    async function list() {
        try {
            const files = await readdir(dir);
            const entries = await Promise.all(
                files.filter((f) => f.endsWith('.json')).map(async (f) => {
                    try {
                        const raw = await readFile(join(dir, f), 'utf8');
                        const parsed = JSON.parse(raw);
                        return {
                            email: parsed.email,
                            savedAt: parsed.meta?.savedAt || null,
                            intentRoles: parsed.intent?.roles || [],
                            hasOverrides: Boolean(parsed.overrides && Object.keys(parsed.overrides).length),
                        };
                    } catch { return null; }
                }),
            );
            return entries.filter(Boolean);
        } catch {
            return [];
        }
    }

    return { get, put, remove, list, _emailToSlug: emailToSlug };
}
