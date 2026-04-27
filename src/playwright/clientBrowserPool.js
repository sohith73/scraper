// Per-client persistent-context pool.
//
// Why : we used to run every scrape against ONE shared JR account
//       (Sohith's). JR's recommender then personalised against Sohith's
//       resume, returning irrelevant jobs for every other client. The
//       pivot is: every client owns their own JR account; we log in as
//       them, scrape /swan/recommend/list/jobs (the same endpoint
//       JR's "/jobs/recommend" page uses), and JR's recommender does
//       the heavy filtering AGAINST THE CLIENT'S OWN RESUME. Far higher
//       quality than our shared-account filter manipulation.
//
// Each client gets a separate Chromium persistent context backed by
// `storage/<emailSlug>/`. We keep the most recently used N open and LRU-
// evict the rest so disk + memory stay bounded.
//
// Concurrency model: callers wrap operations in the SAME mutex used by
// the rest of the playwright layer. The pool itself does not serialise
// — it just ensures `get(email)` returns a ready handle.

import { createBrowserHandle } from './browser.js';

// emailSlug: lowercase + replace anything outside [a-z0-9] with `_` and
// collapse runs. Stable across machines so the same client always gets
// the same dir name.
export function emailSlug(email) {
    if (typeof email !== 'string') return null;
    const s = email.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return s.length > 0 ? s.slice(0, 60) : null;
}

// createClientBrowserPool: factory. Returns
//   { get(email): browserHandle,
//     evict(email): boolean,
//     closeAll(): Promise<void>,
//     status(): { size, max, baseDir, slugs } }
//
// input  : { env, logger, baseDir, max = 8, launcher? }
// output : pool object
export function createClientBrowserPool({
    env,
    logger,
    baseDir = null,
    max = 8,
    launcher = null,
} = {}) {
    if (!env) throw new TypeError('createClientBrowserPool: env is required');
    const dir = baseDir || `${(env.STORAGE_DIR || './storage').replace(/\/+$/, '')}/clients`;

    // Map<slug, { email, handle, lastUsed }>. JS Maps preserve insertion
    // order, but we need explicit LRU re-ordering on access — plain Map
    // delete + re-set on touch.
    const handles = new Map();

    function touch(slug, entry) {
        handles.delete(slug);
        entry.lastUsed = Date.now();
        handles.set(slug, entry);
    }

    async function evictOne() {
        // First entry in iteration order = least recently touched.
        const oldestKey = handles.keys().next().value;
        if (!oldestKey) return;
        const entry = handles.get(oldestKey);
        handles.delete(oldestKey);
        try { await entry.handle.close(); }
        catch (e) { logger?.warn?.({ err: e.message, slug: oldestKey }, 'pool: evict close failed'); }
        logger?.info?.({ slug: oldestKey, remaining: handles.size }, 'pool: evicted');
    }

    // get: return (or create) the persistent-context handle for `email`.
    // The returned object is a `createBrowserHandle` instance — call
    // `.withContext({headless}, fn)` to use it. NEVER share the handle
    // across clients; pool ownership is per-slug.
    function get(email) {
        const slug = emailSlug(email);
        if (!slug) throw new Error('clientBrowserPool.get: valid email required');
        const existing = handles.get(slug);
        if (existing) {
            touch(slug, existing);
            return existing.handle;
        }
        // Make room before creating a new handle.
        // Defer the eviction promise — caller awaits via withContext later.
        if (handles.size >= max) {
            evictOne().catch((e) => logger?.warn?.({ err: e.message }, 'pool: async evict failed'));
        }
        const storageDir = `${dir}/${slug}`;
        const handle = createBrowserHandle({ env, logger, launcher, storageDir });
        const entry = { email: email.trim().toLowerCase(), handle, lastUsed: Date.now() };
        handles.set(slug, entry);
        logger?.info?.({ slug, dir: storageDir, size: handles.size }, 'pool: opened client context');
        return handle;
    }

    async function evict(email) {
        const slug = emailSlug(email);
        if (!slug) return false;
        const entry = handles.get(slug);
        if (!entry) return false;
        handles.delete(slug);
        try { await entry.handle.close(); }
        catch (e) { logger?.warn?.({ err: e.message, slug }, 'pool: evict close failed'); }
        return true;
    }

    async function closeAll() {
        const all = [...handles.values()];
        handles.clear();
        for (const e of all) {
            try { await e.handle.close(); }
            catch (err) { logger?.warn?.({ err: err.message, email: e.email }, 'pool.closeAll: handle close failed'); }
        }
    }

    function status() {
        return {
            size: handles.size,
            max,
            baseDir: dir,
            slugs: [...handles.keys()],
        };
    }

    return { get, evict, closeAll, status };
}

// storageDirFor: convenience for callers that need to know the dir without
// instantiating a handle (e.g. cleanup scripts).
export function storageDirFor(env, email) {
    const base = `${(env?.STORAGE_DIR || './storage').replace(/\/+$/, '')}/clients`;
    const slug = emailSlug(email);
    if (!slug) return null;
    return `${base}/${slug}`;
}
