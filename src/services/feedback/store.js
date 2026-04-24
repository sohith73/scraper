// Per-client feedback store.
//
// Why : the relevance filter's output drifts from operator taste over time
//       — what "good" means for a specific candidate is known only by the
//       humans placing them. We capture every thumbs-up / thumbs-down the
//       operator gives on an AI decision and replay the last N events back
//       into the prompt as CLIENT CALIBRATION examples. AI picks get
//       more personal per client without any model fine-tuning.
//
// Algorithm :
//   - Append-only event log, trimmed to MAX_ENTRIES (newest kept).
//   - Four verdicts map to two signal-density tiers:
//       bad_pick / good_skip = CORRECTION  (AI disagreed → highest signal)
//       good_pick / bad_skip = CONFIRMATION (AI agreed → lower signal)
//   - `selectCalibration()` returns the optimal mix for prompt injection:
//     up to 3 corrections per direction + 2 confirmations, deduped by jobId.
//
// Storage : one JSON file per client at <dir>/<email-slug>.json. Atomic
//           tmp-then-rename write. chmod 0700 dir / 0600 file since records
//           include job titles + operator notes.

import { mkdir, readFile, writeFile, rename, chmod, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_ENTRIES = 50;

export const VERDICTS = Object.freeze([
    'bad_pick',   // AI picked → operator disagrees
    'good_pick',  // AI picked → operator confirms
    'bad_skip',   // AI skipped → operator disagrees (wanted it)
    'good_skip',  // AI skipped → operator confirms (correct skip)
]);

function emailToSlug(email) {
    const lower = String(email).trim().toLowerCase();
    const safe = lower.replace(/[^a-z0-9]/g, '_').slice(0, 80);
    const hash = createHash('sha1').update(lower).digest('hex').slice(0, 8);
    return `${safe}-${hash}`;
}

// coerceString: defensive — accept only strings, truncate runaway lengths
// so one pathological feedback doesn't blow up the prompt later.
function coerceString(v, cap = 200) {
    if (typeof v !== 'string') return '';
    const t = v.trim();
    return t.length > cap ? `${t.slice(0, cap)}…` : t;
}

// createFeedbackStore: factory.
// input  : { dir, logger? }
// output : { append, list, clear, remove, selectCalibration, list_all_emails }
export function createFeedbackStore({ dir, logger = null } = {}) {
    if (!dir || typeof dir !== 'string') {
        throw new TypeError('createFeedbackStore: dir is required');
    }

    async function ensureDir() {
        await mkdir(dir, { recursive: true });
        try { await chmod(dir, DIR_MODE); } catch { /* non-POSIX */ }
    }

    function pathFor(email) {
        return join(dir, `${emailToSlug(email)}.json`);
    }

    // readRaw: returns the parsed record or a freshly initialised shape.
    async function readRaw(email) {
        try {
            const raw = await readFile(pathFor(email), 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
                return { email, entries: [], updatedAt: null };
            }
            return parsed;
        } catch {
            return { email, entries: [], updatedAt: null };
        }
    }

    async function writeAtomic(email, record) {
        await ensureDir();
        const target = pathFor(email);
        const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
        try { await chmod(tmp, FILE_MODE); } catch { /* ignore */ }
        await rename(tmp, target);
    }

    // append: add one event, dedupe by (jobId, verdict) by keeping newest,
    // trim to MAX_ENTRIES.
    // input  : email, { jobId, title, company, verdict, aiPick, aiScore,
    //                   aiReason, note?, sourceRunId? }
    // output : the saved entry with its assigned id + ts.
    async function append(email, raw) {
        if (typeof email !== 'string' || !email.includes('@')) {
            throw new Error('feedback.append: valid email required');
        }
        if (!VERDICTS.includes(raw?.verdict)) {
            throw new Error(`feedback.append: verdict must be one of ${VERDICTS.join('|')}`);
        }
        const entry = {
            id: randomUUID(),
            ts: new Date().toISOString(),
            jobId: coerceString(raw.jobId, 80),
            title: coerceString(raw.title, 140),
            company: coerceString(raw.company, 120),
            verdict: raw.verdict,
            aiPick: !!raw.aiPick,
            aiScore: Number.isInteger(raw.aiScore) ? raw.aiScore : 0,
            aiReason: coerceString(raw.aiReason, 240),
            note: coerceString(raw.note, 300),
            sourceRunId: coerceString(raw.sourceRunId, 64),
        };
        const record = await readRaw(email);
        // Dedupe: same (jobId, verdict) replaces the prior entry.
        const kept = record.entries.filter(
            (e) => !(e.jobId && e.jobId === entry.jobId && e.verdict === entry.verdict),
        );
        kept.push(entry);
        // Trim oldest, keep newest MAX_ENTRIES.
        if (kept.length > MAX_ENTRIES) kept.splice(0, kept.length - MAX_ENTRIES);
        const updated = { email, entries: kept, updatedAt: entry.ts };
        await writeAtomic(email, updated);
        logger?.info?.(
            { email, verdict: entry.verdict, jobId: entry.jobId, total: kept.length },
            'feedback.append',
        );
        return entry;
    }

    async function list(email) {
        if (typeof email !== 'string' || !email.includes('@')) return [];
        const record = await readRaw(email);
        return record.entries;
    }

    async function remove(email, entryId) {
        if (typeof email !== 'string' || !email.includes('@')) return false;
        const record = await readRaw(email);
        const next = record.entries.filter((e) => e.id !== entryId);
        if (next.length === record.entries.length) return false;
        await writeAtomic(email, {
            ...record,
            entries: next,
            updatedAt: new Date().toISOString(),
        });
        return true;
    }

    async function clear(email) {
        if (typeof email !== 'string' || !email.includes('@')) return false;
        try {
            await unlink(pathFor(email));
            return true;
        } catch {
            return false;
        }
    }

    // selectCalibration: the prompt-injection brain.
    //
    // Algorithm:
    //   1. Group entries by verdict.
    //   2. Within each group, newest-first (we rely on push order).
    //   3. Dedupe by jobId across groups (a job's latest verdict wins).
    //   4. Take up to 3 from each "correction" group (bad_pick, good_skip)
    //      and up to 2 from each "confirmation" group (good_pick, bad_skip).
    //   5. Return groups separately so the prompt builder can label them.
    //
    // Why this mix: corrections carry the most information because they
    // identify where AI went wrong. Confirmations prevent regression on
    // things AI already got right. 3+3+2+2 = ~10 examples at most, which
    // keeps the prompt under ~1.5KB extra.
    async function selectCalibration(email, {
        maxCorrections = 3,
        maxConfirmations = 2,
    } = {}) {
        const entries = await list(email);
        if (entries.length === 0) {
            return { rejected: [], rescued: [], confirmedPick: [], confirmedSkip: [] };
        }
        const newestFirst = [...entries].reverse();
        const seen = new Set();
        const groups = {
            bad_pick: [],     // rejected
            good_skip: [],    // rescued
            good_pick: [],    // confirmedPick
            bad_skip: [],     // confirmedSkip
        };
        for (const e of newestFirst) {
            if (e.jobId && seen.has(e.jobId)) continue;
            if (e.jobId) seen.add(e.jobId);
            const g = groups[e.verdict];
            if (!g) continue;
            const cap = e.verdict === 'bad_pick' || e.verdict === 'good_skip'
                ? maxCorrections
                : maxConfirmations;
            if (g.length < cap) g.push(e);
        }
        return {
            rejected: groups.bad_pick,
            rescued: groups.good_skip,
            confirmedPick: groups.good_pick,
            confirmedSkip: groups.bad_skip,
        };
    }

    async function listAllEmails() {
        try {
            const files = await readdir(dir);
            return files
                .filter((f) => f.endsWith('.json'))
                .map((f) => f.replace(/\.json$/, ''));
        } catch {
            return [];
        }
    }

    return {
        append,
        list,
        remove,
        clear,
        selectCalibration,
        listAllEmails,
    };
}
