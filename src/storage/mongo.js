// Single-process MongoDB connection. Lazy-connect, reuse across services.
//
// Why : both clientFilters + feedback need the same connection. Opening
//       one per service is wasteful; the official driver pools internally,
//       but one client is the canonical pattern.
//
// Usage:
//   const conn = createMongoConnection({ uri, dbName, logger });
//   await conn.connect();
//   const db = conn.db();
//   const coll = db.collection('scraper_client_filters');

import { MongoClient } from 'mongodb';

export function createMongoConnection({ uri, dbName, logger = null } = {}) {
    if (!uri || typeof uri !== 'string') {
        throw new TypeError('createMongoConnection: uri is required');
    }
    if (!dbName || typeof dbName !== 'string') {
        throw new TypeError('createMongoConnection: dbName is required');
    }

    let client = null;
    let db = null;
    let connecting = null;

    async function connect() {
        if (db) return db;
        if (connecting) return connecting;
        connecting = (async () => {
            client = new MongoClient(uri, {
                // Conservative defaults tuned for a scraper:
                // - short server selection so operators see errors fast
                // - retryWrites so transient failovers don't kill a feedback click
                serverSelectionTimeoutMS: 8000,
                socketTimeoutMS: 30000,
                retryWrites: true,
                retryReads: true,
            });
            await client.connect();
            db = client.db(dbName);
            logger?.info?.({ dbName }, 'mongo connected');
            return db;
        })();
        try {
            return await connecting;
        } finally {
            connecting = null;
        }
    }

    async function close() {
        if (client) {
            try {
                await client.close();
            } catch (e) {
                logger?.warn?.({ err: e.message }, 'mongo close failed');
            }
            client = null;
            db = null;
        }
    }

    return {
        connect,
        close,
        // db() throws before connect() is called — caller must connect first.
        db: () => {
            if (!db) throw new Error('mongo.db() called before connect()');
            return db;
        },
        // health: cheap round-trip to the primary. Used by /api/health.
        async ping() {
            await connect();
            await db.command({ ping: 1 });
            return true;
        },
    };
}
