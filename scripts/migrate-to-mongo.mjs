#!/usr/bin/env node
// One-shot migration: disk JSON (runs/client-filters, runs/client-feedback)
// into MongoDB. Idempotent — safe to re-run; existing docs are upserted.
//
// Usage:
//   MONGO_URI="mongodb://..." node scripts/migrate-to-mongo.mjs
//
// Reads from ${RUNS_DIR}/client-filters and ${RUNS_DIR}/client-feedback.
// Falls back to ./runs/ if env not set.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../src/config/env.js';
import { createMongoConnection } from '../src/storage/mongo.js';
import { createMongoClientFilterStore } from '../src/services/clientFilters/mongoStore.js';
import { createMongoFeedbackStore } from '../src/services/feedback/mongoStore.js';

const logger = {
    info: (o, m) => console.log(m || '', o || ''),
    warn: (o, m) => console.warn(m || '', o || ''),
    error: (o, m) => console.error(m || '', o || ''),
};

if (!env.MONGO_URI) {
    console.error('MONGO_URI not set — nothing to migrate to.');
    process.exit(1);
}

const mongo = createMongoConnection({
    uri: env.MONGO_URI,
    dbName: env.MONGO_DB,
    logger,
});
const clientFilters = createMongoClientFilterStore({ connection: mongo, logger });
const feedback = createMongoFeedbackStore({ connection: mongo, logger });

async function safeReaddir(dir) {
    try {
        return await readdir(dir);
    } catch {
        return [];
    }
}

async function migrateFilters() {
    const dir = `${env.RUNS_DIR.replace(/\/+$/, '')}/client-filters`;
    const files = (await safeReaddir(dir)).filter((f) => f.endsWith('.json'));
    console.log(`[filters] found ${files.length} files in ${dir}`);
    let ok = 0;
    let skip = 0;
    for (const f of files) {
        try {
            const raw = JSON.parse(await readFile(join(dir, f), 'utf8'));
            // Old file store doesn't persist email in the doc; recover from
            // the intent.exclusions or the filename slug pattern.
            // Safer: the file-store `put` API stored { intent, overrides, meta }.
            // We need the email. Check meta first.
            const email = raw?.meta?.email || raw?.email;
            if (!email) {
                console.warn(`  skip ${f}: no email recoverable`);
                skip += 1;
                continue;
            }
            await clientFilters.put(email, {
                intent: raw.intent || null,
                overrides: raw.overrides || null,
                meta: raw.meta || {},
            });
            ok += 1;
            console.log(`  → ${email}`);
        } catch (e) {
            console.error(`  ERR ${f}: ${e.message}`);
            skip += 1;
        }
    }
    console.log(`[filters] migrated ${ok}, skipped ${skip}`);
}

async function migrateFeedback() {
    const dir = `${env.RUNS_DIR.replace(/\/+$/, '')}/client-feedback`;
    const files = (await safeReaddir(dir)).filter((f) => f.endsWith('.json'));
    console.log(`[feedback] found ${files.length} files in ${dir}`);
    let events = 0;
    for (const f of files) {
        try {
            const raw = JSON.parse(await readFile(join(dir, f), 'utf8'));
            const email = raw?.email;
            if (!email || !Array.isArray(raw.entries)) continue;
            for (const e of raw.entries) {
                if (!e?.verdict) continue;
                await feedback.append(email, e);
                events += 1;
            }
            console.log(`  → ${email} (${raw.entries.length} entries)`);
        } catch (e) {
            console.error(`  ERR ${f}: ${e.message}`);
        }
    }
    console.log(`[feedback] migrated ${events} events total`);
}

try {
    await mongo.connect();
    await clientFilters.ensureIndexes();
    await feedback.ensureIndexes();
    await migrateFilters();
    await migrateFeedback();
    console.log('done.');
} catch (e) {
    console.error('migration failed:', e.message);
    process.exitCode = 1;
} finally {
    await mongo.close();
}
