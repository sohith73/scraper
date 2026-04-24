// Service graph constructor.
//
// Why : every Express route needs access to the same configured instances
//       of the dashboard http client, the resume http client, the OpenAI
//       client, and the summariser. Building them once at boot avoids
//       re-constructing the OpenAI SDK, re-opening the disk cache, etc.
//       It also gives tests a single injection point — pass `overrides`
//       to swap in fakes.
//
// Not a DI framework — just a plain factory returning a frozen object.

import { env } from './config/env.js';
import { logger as rootLogger } from './config/logger.js';
import { createHttpClient } from './clients/common/httpClient.js';
import { listClients, getProfile, getExclusions, updateExclusions, pushJob } from './clients/dashboard/index.js';
import { getResumeByEmail } from './clients/resume/index.js';
import { createAiCache, createOpenAIClient } from './ai/index.js';
import { summarizeProfile } from './services/intent/index.js';
import {
    createMutex,
    createBrowserHandle,
    createSessionService,
} from './playwright/index.js';
import { createRunsService } from './services/runner/index.js';
import { createClientFilterStore } from './services/clientFilters/store.js';
import { createMongoClientFilterStore } from './services/clientFilters/mongoStore.js';
import { createFeedbackStore } from './services/feedback/index.js';
import { createMongoFeedbackStore } from './services/feedback/mongoStore.js';
import { createMongoConnection } from './storage/mongo.js';
import { createDiscordNotifier } from './services/notify/index.js';

// buildContainer: returns `{ dashboard, resume, ai, summariser, logger, env }`.
// Any field in `overrides` wins over the default construction — handy for
// unit tests that want deterministic fakes.
// input  : { overrides?:object, logger?:pino.Logger }
// output : container object
export function buildContainer({ overrides = {}, logger = rootLogger } = {}) {
    const dashboardHttp = createHttpClient({
        baseUrl: env.DASHBOARD_BASE,
        serviceToken: env.DASHBOARD_SERVICE_TOKEN,
        logger,
    });
    const resumeHttp = createHttpClient({ baseUrl: env.RESUME_BASE, logger });

    const aiCache = env.OPENAI_API_KEY
        ? createAiCache({ dir: env.AI_CACHE_DIR })
        : null;
    const ai = env.OPENAI_API_KEY
        ? createOpenAIClient({
              apiKey: env.OPENAI_API_KEY,
              model: env.OPENAI_MODEL,
              cache: aiCache,
              logger,
          })
        : null;

    const dashboard = {
        listClients: () => listClients({ http: dashboardHttp }),
        getProfile: (email) => getProfile({ http: dashboardHttp, email }),
        getExclusions: (email) => getExclusions({ http: dashboardHttp, email }),
        updateExclusions: (args) => updateExclusions({ http: dashboardHttp, ...args }),
        pushJob: (args) =>
            pushJob({ http: dashboardHttp, dryRun: env.DRY_RUN, ...args }),
    };

    const resume = {
        getByEmail: (email) => getResumeByEmail({ http: resumeHttp, email }),
    };

    // summariser wraps summarizeProfile so callers don't need to pass `ai`.
    // When no OpenAI key is configured, we expose a Result-producing stub
    // so the route layer can surface a clean 503 instead of crashing.
    const summariser = ai
        ? (args) => summarizeProfile({ ai, ...args })
        : async () => ({
              ok: false,
              error: {
                  code: 'NO_OPENAI_KEY',
                  message: 'OPENAI_API_KEY not configured',
              },
          });

    // --- Playwright session layer --------------------------------------
    // One mutex guards the shared JR account. Same mutex will later wrap
    // Phase 9 search runs.
    const mutex = createMutex();
    const browser = createBrowserHandle({ env, logger });
    const session = createSessionService({ env, browser, mutex, logger });

    // Per-client persistence. Mongo when MONGO_URI is set (durable +
    // replicable), on-disk JSON otherwise (zero-infra dev default).
    // Interfaces are identical — callers don't change.
    let mongo = null;
    let clientFilters;
    let feedback;
    if (env.MONGO_URI) {
        mongo = createMongoConnection({
            uri: env.MONGO_URI,
            dbName: env.MONGO_DB,
            logger,
        });
        clientFilters = createMongoClientFilterStore({ connection: mongo, logger });
        feedback = createMongoFeedbackStore({ connection: mongo, logger });
        // Fire-and-forget: connect + index creation. Failures log but don't
        // block boot — the first actual read/write will surface real errors.
        mongo.connect()
            .then(() => clientFilters.ensureIndexes())
            .then(() => feedback.ensureIndexes())
            .then(() => logger?.info?.({ dbName: env.MONGO_DB }, 'mongo stores ready'))
            .catch((e) =>
                logger?.error?.({ err: e.message }, 'mongo init failed — reads will error'),
            );
    } else {
        clientFilters = createClientFilterStore({
            dir: `${env.RUNS_DIR.replace(/\/+$/, '')}/client-filters`,
            logger,
        });
        feedback = createFeedbackStore({
            dir: `${env.RUNS_DIR.replace(/\/+$/, '')}/client-feedback`,
            logger,
        });
    }

    // Discord ops alerts. When webhook URL blank → `enabled:false` → every
    // send() is a fast no-op. Pipeline code always calls it; never branches.
    const notifier = createDiscordNotifier({
        webhookUrl: env.DISCORD_WEBHOOK_URL,
        logger,
    });
    if (notifier.enabled) {
        logger?.info?.('discord: webhook configured — ops alerts active');
    }

    const defaults = {
        env,
        logger,
        dashboard,
        resume,
        ai,
        summariser,
        mutex,
        browser,
        session,
        clientFilters,
        feedback,
        notifier,
        mongo,  // null when using file store — health route uses for ping
    };

    // runs depends on the rest of the container; build a proxy so the
    // pipeline can see a fully-assembled graph at call time (important
    // when tests provide `overrides` that swap out sub-services).
    const assembled = Object.freeze({ ...defaults, ...overrides });
    const runs = overrides.runs
        || createRunsService({
            container: assembled,
            runsDir: env.RUNS_DIR,
            logger,
        });

    return Object.freeze({ ...assembled, runs });
}
