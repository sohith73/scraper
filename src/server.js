// Scraper HTTP server entry point.
// Wires env -> logger -> Express app -> listen. Handles graceful shutdown,
// EADDRINUSE, unhandledRejection, uncaughtException. No business logic here.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { healthRouter } from './routes/health.js';
import { clientsRouter } from './routes/clients.js';
import { adminRouter } from './routes/admin.js';
import { runsRouter } from './routes/runs.js';
import { batchesRouter } from './routes/batches.js';
import { debugRouter } from './routes/debug.js';
import { buildContainer } from './container.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');

// buildApp: constructs the Express app. Extracted so tests can boot it
// without a real listener, and can inject a fake service container.
// input  : { container? } — optional pre-built service graph
// output : express.Express
export function buildApp({ container = buildContainer() } = {}) {
    const app = express();
    app.disable('x-powered-by');

    // Request IDs must come first so every downstream log line has one.
    app.use(requestId());

    // Per-request access log. We re-use the root logger but attach a child
    // with the request id so every log line from this request is correlated.
    app.use(
        pinoHttp({
            logger,
            genReqId: (req) => req.id,
            customProps: (req) => ({ reqId: req.id }),
            customLogLevel: (_req, res, err) => {
                if (err) return 'error';
                if (res.statusCode >= 500) return 'error';
                if (res.statusCode >= 400) return 'warn';
                return 'info';
            },
            serializers: {
                req: (req) => ({ method: req.method, url: req.url }),
                res: (res) => ({ statusCode: res.statusCode }),
            },
            autoLogging: {
                // Suppress health spam once an uptime probe starts hitting us.
                ignore: (req) => req.url === '/api/health',
            },
        }),
    );

    // CORS allowlist. Loopback origins always allowed for dev + the admin
    // clients-tracking portal (which lives on hq.flashfirejobs.com in prod).
    // Extra origins can be added via env.CORS_EXTRA_ORIGINS (comma-separated).
    const defaultOrigins = [
        'http://localhost:3000',
        'http://localhost:5173',
        'http://localhost:8092',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:8092',
        'https://hq.flashfirejobs.com',
    ];
    const extra = (container.env?.CORS_EXTRA_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    // CORS_EXTRA_ORIGINS=`*` opens the API to any origin — used during
    // local cross-port testing where the clients-tracking page is served
    // from an unexpected host. Otherwise we keep a strict allowlist.
    const allowAnyOrigin = extra.includes('*');
    const allowedOrigins = [...defaultOrigins, ...extra.filter((o) => o !== '*')];
    app.use(
        cors({
            origin: allowAnyOrigin ? true : allowedOrigins,
            credentials: false,
            maxAge: 600,
        }),
    );

    // Body parsers with defensive limits — scraper payloads are small.
    app.use(express.json({ limit: '256kb' }));
    app.use(express.urlencoded({ extended: false, limit: '64kb' }));

    // Minimal hardening headers.
    app.use((_req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });

    // API routes.
    app.use('/api', healthRouter({ container }));
    app.use('/api', clientsRouter({ container }));
    app.use('/api', adminRouter({ container }));
    app.use('/api', runsRouter({ container }));
    // Batches router is optional — tests that stub out the full run graph
    // don't necessarily wire up a batch runner.
    if (container.batches) {
        app.use('/api', batchesRouter({ container }));
    }
    // Debug routes — single-shot bundles for remote inspection. Gated by
    // env.DEBUG_TOKEN when set. See src/routes/debug.js for endpoint list.
    app.use('/api', debugRouter({ container }));

    // Static UI. Served AFTER /api so a stray public/api.html can't shadow.
    app.use(
        express.static(PUBLIC_DIR, {
            fallthrough: true,
            index: 'index.html',
            etag: true,
            lastModified: true,
            maxAge: env.NODE_ENV === 'production' ? '1h' : 0,
        }),
    );

    // 404 + error handler must be last.
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

// startServer: boots the HTTP listener, wires process-level signal + crash
// handlers, returns a shutdown function used by tests.
// input  : { port?: number }
// output : Promise<{ server, shutdown }>
export async function startServer({ port = env.PORT } = {}) {
    // Reject unsupported Node versions loudly so we don't chase phantom
    // behavior differences in old runtimes.
    const major = Number(process.versions.node.split('.')[0]);
    if (!Number.isFinite(major) || major < 20) {
        throw new Error(
            `Node >= 20 required, running ${process.versions.node}. Upgrade to match engines.node in package.json.`,
        );
    }

    const app = buildApp();
    const server = createServer(app);

    await new Promise((resolveListen, rejectListen) => {
        server.once('error', (err) => {
            if (err && err.code === 'EADDRINUSE') {
                rejectListen(
                    new Error(
                        `Port ${port} already in use. Stop the other process or set PORT in .env.`,
                    ),
                );
                return;
            }
            rejectListen(err);
        });
        server.listen(port, () => {
            server.removeAllListeners('error');
            logger.info(
                {
                    port,
                    env: env.NODE_ENV,
                    node: process.versions.node,
                    pid: process.pid,
                },
                'scraper listening',
            );
            resolveListen();
        });
    });

    // --- graceful shutdown ------------------------------------------------
    let shuttingDown = false;
    const shutdown = async (reason) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info({ reason }, 'shutdown begin');

        // Close HTTP listener — stops accepting new connections but lets
        // in-flight ones finish up to the hard timeout below.
        await new Promise((r) => server.close(() => r()));

        // Fallback: force-exit if something is hanging the event loop.
        const hardExitMs = 8_000;
        const forceTimer = setTimeout(() => {
            logger.fatal({ hardExitMs }, 'forced exit after timeout');
            process.exit(1);
        }, hardExitMs);
        forceTimer.unref();

        logger.info('shutdown complete');
    };

    const onSignal = (sig) => {
        shutdown(`signal:${sig}`).then(() => process.exit(0));
    };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));

    // Unhandled promise rejections + uncaught exceptions should log loudly
    // and exit so a supervisor (pm2/systemd/nodemon) restarts us clean.
    // We intentionally do NOT swallow them.
    process.on('unhandledRejection', (reason) => {
        logger.fatal({ err: reason }, 'unhandledRejection');
        shutdown('unhandledRejection').then(() => process.exit(1));
    });
    process.on('uncaughtException', (err) => {
        logger.fatal({ err }, 'uncaughtException');
        shutdown('uncaughtException').then(() => process.exit(1));
    });

    return { server, shutdown };
}

// Auto-start when run directly (node src/server.js), not when imported in tests.
const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
    startServer().catch((err) => {
        logger.fatal({ err }, 'failed to start');
        process.exit(1);
    });
}
