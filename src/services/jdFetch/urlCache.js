// urlCache — tiny best-effort disk cache keyed by URL, for JD extraction
// results. Repeat URLs (re-runs, the same job surfaced for multiple clients,
// dedup overlap) skip extraction entirely and return instantly.
//
// Why a separate cache: ai/cache.js is keyed on the OpenAI prompt hash; this
// one is keyed on the normalized job URL. Same atomic tmp-then-rename write +
// corrupt-file-tolerant read pattern, much smaller surface.
//
// Best-effort by design: every read/write swallows errors and degrades to a
// cache miss. The cache is an optimization, never a correctness dependency.

import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// normaliseUrl: strip the fragment + common tracking params so trivially
// different URLs for the same posting share a cache entry. Conservative —
// keeps all non-tracking query params (ATS job ids often live in the query).
function normaliseUrl(url) {
    try {
        const u = new URL(String(url));
        u.hash = '';
        const drop = [];
        for (const [k] of u.searchParams) {
            if (/^utm_/i.test(k) || /^(gclid|fbclid|mc_cid|mc_eid|ref|source|src)$/i.test(k)) drop.push(k);
        }
        for (const k of drop) u.searchParams.delete(k);
        // Lowercase host only; path/query are case-sensitive on many ATSes.
        u.hostname = u.hostname.toLowerCase();
        return u.toString();
    } catch {
        return String(url || '');
    }
}

export function createUrlCache({ dir, ttlMs = 24 * 60 * 60 * 1000, logger = null } = {}) {
    const enabled = ttlMs > 0 && !!dir;
    let ready = false;

    async function ensureDir() {
        if (ready) return;
        try {
            await mkdir(dir, { recursive: true });
        } catch {
            /* best-effort */
        }
        ready = true;
    }

    function fileFor(url) {
        const h = createHash('sha256').update(normaliseUrl(url)).digest('hex').slice(0, 40);
        return join(dir, h + '.json');
    }

    async function get(url) {
        if (!enabled) return null;
        await ensureDir();
        const f = fileFor(url);
        try {
            const raw = await readFile(f, 'utf8');
            const obj = JSON.parse(raw);
            if (!obj || typeof obj.exp !== 'number') return null;
            if (Date.now() > obj.exp) {
                // expired — evict lazily, ignore failures
                unlink(f).catch(() => {});
                return null;
            }
            return obj.v ?? null;
        } catch {
            return null;
        }
    }

    async function set(url, value) {
        if (!enabled || !value) return;
        await ensureDir();
        const f = fileFor(url);
        const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
        try {
            await writeFile(tmp, JSON.stringify({ exp: Date.now() + ttlMs, v: value }));
            await rename(tmp, f);
        } catch (e) {
            logger?.warn?.({ err: e?.message }, '[jdCache] set failed');
            unlink(tmp).catch(() => {});
        }
    }

    return { get, set, enabled, normaliseUrl };
}
