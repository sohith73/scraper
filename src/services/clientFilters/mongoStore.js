// Mongo-backed client filter store.
//
// Same public surface as the file store in ./store.js:
//   { get(email), put(email, state), remove(email), list() }
//
// Schema — collection `scraper_client_filters`:
//   {
//     _id:       <email lowercased>     // natural PK, no separate index needed
//     email:     <lowercased email>     // denormalised for readability
//     intent:    <SearchIntent | null>
//     overrides: <object | null>
//     meta:      { savedAt, source, lastRunId? }
//     createdAt: Date
//     updatedAt: Date
//   }
//
// Concurrency: every write uses findOneAndUpdate w/ upsert, so two UI
// clicks from the same operator race safely. No transaction needed.

function normaliseEmail(email) {
    if (typeof email !== 'string' || !email.includes('@')) return null;
    return email.trim().toLowerCase();
}

// createMongoClientFilterStore: factory.
// input  : { connection, collectionName?, logger? }
//          connection = { connect(), db() }  (from storage/mongo.js)
// output : { get, put, remove, list, ensureIndexes }
export function createMongoClientFilterStore({
    connection,
    collectionName = 'scraper_client_filters',
    logger = null,
} = {}) {
    if (!connection || typeof connection.connect !== 'function') {
        throw new TypeError('createMongoClientFilterStore: connection is required');
    }

    async function coll() {
        await connection.connect();
        return connection.db().collection(collectionName);
    }

    // ensureIndexes: idempotent — driver no-ops on an existing index.
    // The _id index is automatic; we only need updatedAt for admin queries.
    async function ensureIndexes() {
        try {
            const c = await coll();
            await c.createIndex({ updatedAt: -1 }, { name: 'by_updatedAt' });
        } catch (e) {
            logger?.warn?.({ err: e.message }, 'clientFilters: ensureIndexes failed');
        }
    }

    async function get(email) {
        const key = normaliseEmail(email);
        if (!key) return null;
        try {
            const c = await coll();
            const doc = await c.findOne({ _id: key });
            if (!doc) return null;
            // Strip the mongo-specific fields so callers see the same shape
            // the file store returns.
            const { _id, email: e, createdAt, updatedAt, ...rest } = doc;
            return {
                intent: rest.intent ?? null,
                overrides: rest.overrides ?? null,
                meta: {
                    ...(rest.meta || {}),
                    savedAt: rest.meta?.savedAt
                        ?? (updatedAt ? new Date(updatedAt).toISOString() : null),
                },
            };
        } catch (e) {
            logger?.warn?.({ err: e.message, email: key }, 'clientFilters.get failed');
            return null;
        }
    }

    async function put(email, payload) {
        const key = normaliseEmail(email);
        if (!key) throw new Error('clientFilters.put: valid email required');
        const now = new Date();
        const record = {
            email: key,
            intent: payload?.intent ?? null,
            overrides: payload?.overrides ?? null,
            meta: {
                ...(payload?.meta || {}),
                savedAt: now.toISOString(),
            },
            updatedAt: now,
        };
        const c = await coll();
        await c.updateOne(
            { _id: key },
            {
                $set: record,
                $setOnInsert: { createdAt: now },
            },
            { upsert: true },
        );
        return record;
    }

    async function remove(email) {
        const key = normaliseEmail(email);
        if (!key) return false;
        try {
            const c = await coll();
            const r = await c.deleteOne({ _id: key });
            return r.deletedCount === 1;
        } catch (e) {
            logger?.warn?.({ err: e.message, email: key }, 'clientFilters.remove failed');
            return false;
        }
    }

    async function list() {
        try {
            const c = await coll();
            const docs = await c
                .find({}, { projection: { email: 1, updatedAt: 1 } })
                .sort({ updatedAt: -1 })
                .toArray();
            return docs.map((d) => ({
                email: d.email,
                savedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
            }));
        } catch (e) {
            logger?.warn?.({ err: e.message }, 'clientFilters.list failed');
            return [];
        }
    }

    return { get, put, remove, list, ensureIndexes };
}
