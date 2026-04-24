// Mongo-backed feedback store.
//
// Same public surface as the file store in ./store.js:
//   { append, list, remove, clear, selectCalibration, listAllEmails }
//
// Schema — collection `scraper_client_feedback`:
//   {
//     _id:       <email lowercased>
//     email:     <lowercased>
//     entries:   [{ id, ts, jobId, title, company, verdict, aiPick,
//                   aiScore, aiReason, note, sourceRunId }]
//     updatedAt: Date
//     createdAt: Date
//   }
//
// One doc per client, entries embedded. Same model as file store so the
// migration is a 1:1 copy. Max 50 entries per client keeps each doc tiny.

import { randomUUID } from 'node:crypto';

const MAX_ENTRIES = 50;

export const VERDICTS = Object.freeze([
    'bad_pick',
    'good_pick',
    'bad_skip',
    'good_skip',
]);

function normaliseEmail(email) {
    if (typeof email !== 'string' || !email.includes('@')) return null;
    return email.trim().toLowerCase();
}

function coerceString(v, cap = 200) {
    if (typeof v !== 'string') return '';
    const t = v.trim();
    return t.length > cap ? `${t.slice(0, cap)}…` : t;
}

export function createMongoFeedbackStore({
    connection,
    collectionName = 'scraper_client_feedback',
    logger = null,
} = {}) {
    if (!connection || typeof connection.connect !== 'function') {
        throw new TypeError('createMongoFeedbackStore: connection is required');
    }

    async function coll() {
        await connection.connect();
        return connection.db().collection(collectionName);
    }

    async function ensureIndexes() {
        try {
            const c = await coll();
            await c.createIndex({ updatedAt: -1 }, { name: 'by_updatedAt' });
        } catch (e) {
            logger?.warn?.({ err: e.message }, 'feedback: ensureIndexes failed');
        }
    }

    // append: atomic read-modify-write via findOneAndUpdate with a pipeline.
    // We compute the next entries array server-side so two concurrent appends
    // don't clobber each other.
    async function append(email, raw) {
        const key = normaliseEmail(email);
        if (!key) throw new Error('feedback.append: valid email required');
        if (!VERDICTS.includes(raw?.verdict)) {
            throw new Error(`feedback.append: verdict must be one of ${VERDICTS.join('|')}`);
        }
        const now = new Date();
        const entry = {
            id: randomUUID(),
            ts: now.toISOString(),
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
        const c = await coll();
        // Aggregation-pipeline update lets us dedupe + append + trim in one
        // atomic server-side operation.
        await c.updateOne(
            { _id: key },
            [
                {
                    $set: {
                        _id: key,
                        email: key,
                        entries: {
                            $let: {
                                vars: {
                                    filtered: {
                                        $filter: {
                                            input: { $ifNull: ['$entries', []] },
                                            as: 'e',
                                            cond: {
                                                $not: {
                                                    $and: [
                                                        { $eq: ['$$e.jobId', entry.jobId] },
                                                        { $eq: ['$$e.verdict', entry.verdict] },
                                                    ],
                                                },
                                            },
                                        },
                                    },
                                },
                                in: {
                                    $let: {
                                        vars: {
                                            combined: { $concatArrays: ['$$filtered', [entry]] },
                                        },
                                        in: {
                                            $cond: {
                                                if: { $gt: [{ $size: '$$combined' }, MAX_ENTRIES] },
                                                then: {
                                                    $slice: [
                                                        '$$combined',
                                                        { $subtract: [{ $size: '$$combined' }, MAX_ENTRIES] },
                                                        MAX_ENTRIES,
                                                    ],
                                                },
                                                else: '$$combined',
                                            },
                                        },
                                    },
                                },
                            },
                        },
                        updatedAt: now,
                        createdAt: { $ifNull: ['$createdAt', now] },
                    },
                },
            ],
            { upsert: true },
        );
        logger?.info?.(
            { email: key, verdict: entry.verdict, jobId: entry.jobId },
            'feedback.append (mongo)',
        );
        return entry;
    }

    async function list(email) {
        const key = normaliseEmail(email);
        if (!key) return [];
        try {
            const c = await coll();
            const doc = await c.findOne({ _id: key }, { projection: { entries: 1 } });
            return Array.isArray(doc?.entries) ? doc.entries : [];
        } catch (e) {
            logger?.warn?.({ err: e.message, email: key }, 'feedback.list failed');
            return [];
        }
    }

    async function remove(email, entryId) {
        const key = normaliseEmail(email);
        if (!key || !entryId) return false;
        try {
            const c = await coll();
            const r = await c.updateOne(
                { _id: key },
                {
                    $pull: { entries: { id: entryId } },
                    $set: { updatedAt: new Date() },
                },
            );
            return r.modifiedCount === 1;
        } catch (e) {
            logger?.warn?.({ err: e.message, email: key }, 'feedback.remove failed');
            return false;
        }
    }

    async function clear(email) {
        const key = normaliseEmail(email);
        if (!key) return false;
        try {
            const c = await coll();
            const r = await c.deleteOne({ _id: key });
            return r.deletedCount === 1;
        } catch (e) {
            logger?.warn?.({ err: e.message, email: key }, 'feedback.clear failed');
            return false;
        }
    }

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
        const groups = { bad_pick: [], good_skip: [], good_pick: [], bad_skip: [] };
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
            const c = await coll();
            const docs = await c.find({}, { projection: { _id: 1 } }).toArray();
            return docs.map((d) => d._id);
        } catch (e) {
            logger?.warn?.({ err: e.message }, 'feedback.listAllEmails failed');
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
        ensureIndexes,
    };
}
