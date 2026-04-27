// Mongo-backed per-client scrape settings + JR credentials.
//
// Collection: scraper_client_settings
//   {
//     _id: <email lowercased>,
//     email, scrapeCount,
//     // Optional per-client JR credentials (set via PUT /api/clients/:email/jr-creds).
//     // The password is AES-256-GCM-encrypted with env JR_CRED_KEY before
//     // it lands here — the store NEVER sees plaintext.
//     jrEmail?, jrPasswordEnc?, jrCredsSetAt?,
//     // Per-client persistent-context dir name (slug of email). Set
//     // automatically on first login attempt.
//     jrStorageDir?, jrLastLoginAt?, jrLastLoginOk?,
//     updatedAt, createdAt
//   }
//
// Why one collection: every per-client knob fits in one doc. Adding more
// later (auto-run cron, preferred work-models) is a single-field add.

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

    // --- per-client JR credentials --------------------------------------
    // Stored alongside scrapeCount. Password ciphertext lives here; the
    // crypto module owns encrypt/decrypt — store handlers receive plaintext
    // from the route layer and pass through `crypto.encrypt` exactly once.

    async function getCredentials(email) {
        const key = normaliseEmail(email);
        if (!key) return null;
        try {
            const c = await coll();
            const doc = await c.findOne(
                { _id: key },
                { projection: { jrEmail: 1, jrPasswordEnc: 1, jrCredsSetAt: 1, jrStorageDir: 1, jrLastLoginAt: 1, jrLastLoginOk: 1 } },
            );
            if (!doc || !doc.jrEmail) return null;
            return {
                email: key,
                jrEmail: doc.jrEmail,
                jrPasswordEnc: doc.jrPasswordEnc || null,
                jrCredsSetAt: doc.jrCredsSetAt ? new Date(doc.jrCredsSetAt).toISOString() : null,
                jrStorageDir: doc.jrStorageDir || null,
                jrLastLoginAt: doc.jrLastLoginAt ? new Date(doc.jrLastLoginAt).toISOString() : null,
                jrLastLoginOk: typeof doc.jrLastLoginOk === 'boolean' ? doc.jrLastLoginOk : null,
            };
        } catch (e) {
            logger?.warn?.({ err: e.message, email: key }, 'clientSettings.getCredentials failed');
            return null;
        }
    }

    async function putCredentials(email, { jrEmail, jrPasswordEnc }) {
        const key = normaliseEmail(email);
        if (!key) throw new Error('clientSettings.putCredentials: valid email required');
        if (typeof jrEmail !== 'string' || !jrEmail.includes('@')) {
            throw new Error('clientSettings.putCredentials: jrEmail must be an email');
        }
        if (typeof jrPasswordEnc !== 'string' || jrPasswordEnc.length < 16) {
            throw new Error('clientSettings.putCredentials: jrPasswordEnc must be a non-empty encrypted envelope');
        }
        const now = new Date();
        const c = await coll();
        await c.updateOne(
            { _id: key },
            {
                $set: {
                    email: key,
                    jrEmail: jrEmail.trim().toLowerCase(),
                    jrPasswordEnc,
                    jrCredsSetAt: now,
                    updatedAt: now,
                },
                $setOnInsert: { createdAt: now },
            },
            { upsert: true },
        );
        return { email: key, jrEmail: jrEmail.trim().toLowerCase(), jrCredsSetAt: now.toISOString() };
    }

    async function removeCredentials(email) {
        const key = normaliseEmail(email);
        if (!key) return false;
        const c = await coll();
        const r = await c.updateOne(
            { _id: key },
            { $unset: { jrEmail: '', jrPasswordEnc: '', jrCredsSetAt: '', jrStorageDir: '', jrLastLoginAt: '', jrLastLoginOk: '' } },
        );
        return r.matchedCount === 1;
    }

    // markLogin: stamp the last-login outcome so the UI can show a green
    // dot ("logged in 2 min ago") or a red one with the failure reason.
    async function markLogin(email, { ok, storageDir }) {
        const key = normaliseEmail(email);
        if (!key) return;
        const now = new Date();
        const set = { jrLastLoginAt: now, jrLastLoginOk: !!ok, updatedAt: now };
        if (storageDir) set.jrStorageDir = storageDir;
        try {
            const c = await coll();
            await c.updateOne({ _id: key }, { $set: set });
        } catch (e) {
            logger?.warn?.({ err: e.message, email: key }, 'clientSettings.markLogin failed');
        }
    }

    return { get, put, listAll, remove, ensureIndexes, getCredentials, putCredentials, removeCredentials, markLogin };
}
