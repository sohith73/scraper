// File-backed per-client scrape settings (fallback when MONGO_URI unset).
//
// Single JSON file at <dir>/client-settings.json, shape:
//   { "email@lower": { scrapeCount, updatedAt }, ... }
//
// Writes are atomic (tmp-then-rename). Reads are eager — the whole file
// is small (one entry per client). Concurrent writes serialise through a
// single in-flight promise so two PUTs from the UI don't corrupt the file.

import { mkdir, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const FILE_NAME = 'client-settings.json';

function normaliseEmail(email) {
    if (typeof email !== 'string' || !email.includes('@')) return null;
    return email.trim().toLowerCase();
}

export function createClientSettingsStore({ dir, logger = null } = {}) {
    if (!dir || typeof dir !== 'string') {
        throw new TypeError('createClientSettingsStore: dir is required');
    }
    const filePath = join(dir, FILE_NAME);
    let writing = Promise.resolve();

    async function ensureDir() {
        await mkdir(dir, { recursive: true });
        try { await chmod(dir, DIR_MODE); } catch { /* non-POSIX */ }
    }

    async function readAll() {
        try {
            const raw = await readFile(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    async function writeAll(map) {
        const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
        try {
            await ensureDir();
            await writeFile(tmp, JSON.stringify(map, null, 2), { encoding: 'utf8', mode: FILE_MODE });
            await rename(tmp, filePath);
        } catch (err) {
            logger?.warn?.({ err: err.message }, 'clientSettings: write failed');
            try { await unlink(tmp); } catch { /* ignore */ }
            throw err;
        }
    }

    async function get(email) {
        const key = normaliseEmail(email);
        if (!key) return null;
        const all = await readAll();
        const rec = all[key];
        if (!rec) return null;
        return {
            email: key,
            scrapeCount: Number.isInteger(rec.scrapeCount) ? rec.scrapeCount : null,
            updatedAt: rec.updatedAt || null,
        };
    }

    async function put(email, { scrapeCount }) {
        const key = normaliseEmail(email);
        if (!key) throw new Error('clientSettings.put: valid email required');
        const n = Number.parseInt(scrapeCount, 10);
        if (!Number.isInteger(n) || n < 1 || n > 50) {
            throw new Error('clientSettings.put: scrapeCount must be integer in [1,50]');
        }
        // Serialise writes through `writing` so two concurrent PUTs don't
        // clobber each other's read-modify-write.
        const result = writing.then(async () => {
            const all = await readAll();
            all[key] = { scrapeCount: n, updatedAt: new Date().toISOString() };
            await writeAll(all);
            return { email: key, ...all[key] };
        });
        writing = result.catch(() => {});
        return result;
    }

    async function listAll() {
        const all = await readAll();
        return Object.entries(all).map(([email, rec]) => ({
            email,
            scrapeCount: Number.isInteger(rec.scrapeCount) ? rec.scrapeCount : null,
            updatedAt: rec.updatedAt || null,
        }));
    }

    async function remove(email) {
        const key = normaliseEmail(email);
        if (!key) return false;
        const result = writing.then(async () => {
            const all = await readAll();
            if (!(key in all)) return false;
            delete all[key];
            await writeAll(all);
            return true;
        });
        writing = result.catch(() => {});
        return result;
    }

    // ensureIndexes: parity with the Mongo store — no-op here.
    async function ensureIndexes() {}

    return { get, put, listAll, remove, ensureIndexes };
}
