// Healthcheck route.
// Returns basic process info used by humans + future uptime probes. Kept
// cheap: no downstream calls here so it stays a true liveness check.
// Readiness checks (can we reach dashboard/resume/OpenAI?) come in later
// phases via a separate /api/ready endpoint.

import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { env } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// readPackageVersion: loads the version string from package.json once.
// Defensive: if the file ever moves, health still returns a sensible default.
async function readPackageVersion() {
    try {
        const pkgPath = resolve(__dirname, '../../package.json');
        const raw = await readFile(pkgPath, 'utf8');
        const parsed = JSON.parse(raw);
        return typeof parsed.version === 'string' ? parsed.version : 'unknown';
    } catch {
        return 'unknown';
    }
}

const versionPromise = readPackageVersion();
const bootTime = Date.now();

export function healthRouter({ container } = {}) {
    const router = Router();

    // GET /api/health
    // Returns { ok, service, version, port, uptimeSec, node, env, storage }.
    // When Mongo is wired, storage reports live connection status so an
    // operator notices if the DB is unreachable without waiting for the
    // next feedback click to fail.
    router.get('/health', async (req, res) => {
        const version = await versionPromise;
        let storage = { backend: 'file' };
        if (container?.mongo) {
            let connected = false;
            try {
                await container.mongo.ping();
                connected = true;
            } catch { /* down */ }
            storage = { backend: 'mongo', db: env.MONGO_DB, connected };
        }
        res.json({
            ok: true,
            service: 'jobright-scraper',
            version,
            port: env.PORT,
            uptimeSec: Math.round((Date.now() - bootTime) / 1000),
            node: process.versions.node,
            env: env.NODE_ENV,
            storage,
            requestId: req.id,
        });
    });

    return router;
}
