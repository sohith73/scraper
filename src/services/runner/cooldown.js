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

// setCooldown: writes a cooldown record with EXPONENTIAL BACKOFF across
// consecutive throttles. A flat 15-minute wait does nothing if JR is
// repeatedly angry; each repeat throttle doubles the base wait (15m→30m→1h…)
// up to `maxMs`. A "repeat" is a new cooldown set while the previous one is
// still active or within one base-window of having expired — otherwise the
// streak is considered broken and the count resets to 0.
// Best-effort; failures logged by the caller (if provided).
// input  : runsDir, { ms, reason?, code?, now?, maxMs? }
// output : Promise<{record, path} | null>  (record.until reflects the backoff)
export async function setCooldown(
    runsDir,
    { ms, reason = '', code = 'COOLDOWN', now = Date.now(), maxMs = 4 * 60 * 60 * 1000 } = {},
) {
    if (!Number.isFinite(ms) || ms <= 0) return null;

    let consecutiveCount = 0;
    const prev = await readCooldown(runsDir);
    if (prev) {
        const prevUntil = Date.parse(prev.until);
        const prevBase = Number(prev.baseMs) || ms;
        // Still cooling (now < until) OR re-throttled within one base-window
        // of expiry → JR is still mad, escalate. Else the streak is broken.
        if (Number.isFinite(prevUntil) && now - prevUntil <= prevBase) {
            consecutiveCount = (Number(prev.consecutiveCount) || 0) + 1;
        }
    }
    const cap = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : Infinity;
    const effectiveMs = Math.min(ms * 2 ** consecutiveCount, cap);

    const record = {
        code,
        reason: String(reason).slice(0, 500),
        setAt: new Date(now).toISOString(),
        until: new Date(now + effectiveMs).toISOString(),
        baseMs: ms,
        effectiveMs,
        consecutiveCount,
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
