// Cooldown file — "JobRight is mad at us, stop running for a bit".
//
// Why : when JR returns 429 or 403, hitting them again in 30s only deepens
//       the block (and risks a full account suspension on the shared
//       account we all depend on). We write a cooldown marker so every
//       subsequent run refuses up-front until the timer expires.
//       The file lives INSIDE runs/ so it's gitignored + visible to ops
//       who know the layout.

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const COOLDOWN_FILE = '.cooldown.json';

// cooldownPath: canonical location inside `runsDir`.
function cooldownPath(runsDir) {
    return join(runsDir, COOLDOWN_FILE);
}

// readCooldown: returns the parsed cooldown record, or `null` if no file
// exists / it's malformed. Never throws.
// input  : runsDir
// output : { until:ISOString, reason:string, code:string, setAt:ISOString } | null
export async function readCooldown(runsDir) {
    try {
        const raw = await readFile(cooldownPath(runsDir), 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed?.until !== 'string') return null;
        return parsed;
    } catch {
        return null;
    }
}

// setCooldown: writes a cooldown record. Best-effort; failures logged by
// the caller (if provided).
// input  : runsDir, { ms, reason?, code?, now? }
// output : Promise<{record, path} | null>
export async function setCooldown(runsDir, { ms, reason = '', code = 'COOLDOWN', now = Date.now() } = {}) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const record = {
        code,
        reason: String(reason).slice(0, 500),
        setAt: new Date(now).toISOString(),
        until: new Date(now + ms).toISOString(),
    };
    try {
        await writeFile(cooldownPath(runsDir), JSON.stringify(record, null, 2), 'utf8');
        return { record, path: cooldownPath(runsDir) };
    } catch {
        return null;
    }
}

// clearCooldown: best-effort removal. Safe to call when no file exists.
export async function clearCooldown(runsDir) {
    try {
        await unlink(cooldownPath(runsDir));
    } catch {
        /* swallow */
    }
}

// isCooldownActive: returns `true` if `record.until` is in the future.
// Pure — pass a pre-loaded record + an optional `now` for testability.
export function isCooldownActive(record, now = Date.now()) {
    if (!record || typeof record.until !== 'string') return false;
    const untilMs = Date.parse(record.until);
    if (!Number.isFinite(untilMs)) return false;
    return untilMs > now;
}

// describeCooldown: human-readable remaining-time string.
// input  : record, now?
// output : string | '' when not active
export function describeCooldown(record, now = Date.now()) {
    if (!isCooldownActive(record, now)) return '';
    const secondsLeft = Math.ceil((Date.parse(record.until) - now) / 1000);
    const mins = Math.floor(secondsLeft / 60);
    const secs = secondsLeft % 60;
    const left = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    return `${record.code}: ${record.reason || '(no reason)'} — retry in ${left}`;
}
