// Mongo-backed per-client scrape settings.
//
// Collection: scraper_client_settings
//   { _id: <email lowercased>, email, scrapeCount, updatedAt, createdAt }
//
// Only field we persist today is `scrapeCount` — the default number of
// jobs to pull when admin clicks Scrape / Scrape All for this client.
// Kept as its own collection so adding more per-client toggles later
// (e.g. preferredSearchPreset, autoRunDaily) is a single-doc change.

function normaliseEmail(email) {
    if (typeof email !== 'string' || !email.includes('@')) return null;
    return email.trim().toLowerCase();
}

export function createMongoClientSettingsStore({
    connection,
    collectionName = 'scraper_client_settings',
    logger = null,
} = {}) {
    if (!connection || typeof connection.connect !== 'function') {
        throw new TypeError('createMongoClientSettingsStore: connection is required');
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
            logger?.warn?.({ err: e.message }, 'clientSettings: ensureIndexes failed');
        }
    }

    async function get(email) {
        const key = normaliseEmail(email);
        if (!key) return null;
        try {
            const c = await coll();
            const doc = await c.findOne({ _id: key });
            if (!doc) return null;
            return {
                email: doc.email,
                scrapeCount: Number.isInteger(doc.scrapeCount) ? doc.scrapeCount : null,
                updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
            };
        } catch (e) {
            logger?.warn?.({ err: e.message, email: key }, 'clientSettings.get failed');
            return null;
        }
    }

    async function put(email, { scrapeCount }) {
        const key = normaliseEmail(email);
        if (!key) throw new Error('clientSettings.put: valid email required');
        const n = Number.parseInt(scrapeCount, 10);
        if (!Number.isInteger(n) || n < 1 || n > 50) {
            throw new Error('clientSettings.put: scrapeCount must be integer in [1,50]');
        }
        const now = new Date();
        const c = await coll();
        await c.updateOne(
            { _id: key },
            {
                $set: { email: key, scrapeCount: n, updatedAt: now },
                $setOnInsert: { createdAt: now },
            },
            { upsert: true },
        );
        return { email: key, scrapeCount: n, updatedAt: now.toISOString() };
    }

    async function listAll() {
        try {
            const c = await coll();
            const docs = await c
                .find({}, { projection: { email: 1, scrapeCount: 1, updatedAt: 1 } })
                .toArray();
            return docs.map((d) => ({
                email: d.email,
                scrapeCount: Number.isInteger(d.scrapeCount) ? d.scrapeCount : null,
                updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
            }));
        } catch (e) {
            logger?.warn?.({ err: e.message }, 'clientSettings.listAll failed');
            return [];
        }
    }

    async function remove(email) {
        const key = normaliseEmail(email);
        if (!key) return false;
        try {
            const c = await coll();
            const r = await c.deleteOne({ _id: key });
            return r.deletedCount === 1;
        } catch (e) {
            logger?.warn?.({ err: e.message, email: key }, 'clientSettings.remove failed');
            return false;
        }
    }

    return { get, put, listAll, remove, ensureIndexes };
}
