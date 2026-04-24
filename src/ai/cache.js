// Disk-backed cache for AI responses.
//
// Why : gpt-4o-mini is cheap but repeating identical prompts is still waste.
//       Profile summarisation (Phase 5) is the obvious beneficiary — same
//       client + unchanged profile + unchanged resume = identical prompt.
// Storage shape : one JSON file per key under `${dir}/${key}.json`.
//                 Atomic write via tmp-then-rename so a crash mid-write
//                 never leaves half-JSON on disk.
// Read misses are silent — any parse/IO problem returns null and the
// caller falls through to the real AI call.

import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve as pathResolve } from 'node:path';

// createAiCache: factory. Pass `{ dir, enabled }`. When disabled, the cache
// is a no-op — useful in tests and CI.
// input  : { dir:string, enabled?:boolean }
// output : { get(key)->Promise<any|null>, set(key,value)->Promise<void>,
//            evict(key)->Promise<void>, path(key)->string }
export function createAiCache({ dir, enabled = true } = {}) {
    if (enabled && (!dir || typeof dir !== 'string')) {
        throw new TypeError('createAiCache: dir is required when enabled');
    }
    const base = enabled ? pathResolve(dir) : null;

    const pathFor = (key) => {
        if (!/^[a-f0-9]{32,128}$/i.test(key)) {
            throw new Error(`cache key must be hex sha; got ${key}`);
        }
        return `${base}/${key}.json`;
    };

    async function ensureDir(filePath) {
        await mkdir(dirname(filePath), { recursive: true });
    }

    return {
        path: (key) => (enabled ? pathFor(key) : null),

        async get(key) {
            if (!enabled) return null;
            let raw;
            try {
                raw = await readFile(pathFor(key), 'utf8');
            } catch (err) {
                if (err.code === 'ENOENT') return null;
                // Permission / transient IO — treat as miss rather than crash.
                return null;
            }
            try {
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object') return null;
                return parsed.v === undefined ? null : parsed.v;
            } catch {
                // Corrupt cache entry — delete it so we don't keep hitting it.
                try {
                    await unlink(pathFor(key));
                } catch {
                    /* ignore */
                }
                return null;
            }
        },

        async set(key, value) {
            if (!enabled) return;
            const finalPath = pathFor(key);
            const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
            const record = { k: key, v: value, t: new Date().toISOString() };
            try {
                await ensureDir(finalPath);
                await writeFile(tmpPath, JSON.stringify(record), 'utf8');
                await rename(tmpPath, finalPath);
            } catch {
                // Opportunistic — swallow errors. Best-effort cleanup.
                try {
                    await unlink(tmpPath);
                } catch {
                    /* ignore */
                }
            }
        },

        async evict(key) {
            if (!enabled) return;
            try {
                await unlink(pathFor(key));
            } catch {
                /* ignore */
            }
        },
    };
}
