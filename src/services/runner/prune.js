// runs/ directory pruner.
//
// Every run writes runs/<id>/state.json (+ run.log, trace.zip, artifacts).
// Over weeks of operation these pile up: the cold-start scan that restores
// run history slows, and disk fills. This deletes run directories older than
// a retention window, leaving the reserved store sub-dirs + the cooldown
// marker untouched.
//
// Best-effort, never throws — a prune failure must never block boot.

import { readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Sub-directories under runs/ that are NOT run artifacts (file-store mode
// keeps per-client state here). Never prune these.
const RESERVED_DIRS = new Set(['client-filters', 'client-feedback', 'client-settings']);

// pruneOldRuns: delete runs/<id>/ dirs whose state.json mtime is older than
// maxAgeDays. A directory is only treated as a run dir if it actually holds a
// state.json — so reserved stores (no state.json) are skipped structurally,
// belt-and-suspenders with RESERVED_DIRS + the dotfile guard.
// input  : runsDir, { maxAgeDays?, now?, logger? }
// output : Promise<{ removed, scanned, skipped }>
export async function pruneOldRuns(runsDir, { maxAgeDays = 7, now = Date.now(), logger } = {}) {
    const out = { removed: 0, scanned: 0, skipped: 0 };
    if (!runsDir || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return out;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    let entries;
    try {
        entries = await readdir(runsDir, { withFileTypes: true });
    } catch {
        return out; // runs/ doesn't exist yet — nothing to prune
    }

    for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('.') || RESERVED_DIRS.has(e.name)) {
            out.skipped += 1;
            continue;
        }
        const dir = join(runsDir, e.name);
        let st;
        try {
            st = await stat(join(dir, 'state.json'));
        } catch {
            out.skipped += 1; // no state.json → not a run dir
            continue;
        }
        out.scanned += 1;
        if (now - st.mtimeMs > maxAgeMs) {
            try {
                await rm(dir, { recursive: true, force: true });
                out.removed += 1;
            } catch (err) {
                logger?.warn?.({ dir, err: err.message }, 'prune: rm failed');
            }
        }
    }

    if (out.removed > 0) {
        logger?.info?.({ ...out, maxAgeDays }, 'pruned old run directories');
    }
    return out;
}
