// Structured logger (pino).
// One shared logger across the process. Pretty stream in development,
// line-delimited JSON in production (cheap to parse by log aggregators).

import pino from 'pino';
import { env } from './env.js';

// buildLogger: constructs the root pino logger. Kept as a factory so tests
// can create isolated loggers pointing at a buffer.
// input  : { level, prettyPrint }
// output : pino.Logger
export function buildLogger({
    level = env.LOG_LEVEL,
    prettyPrint = env.NODE_ENV !== 'production',
} = {}) {
    const base = {
        service: 'jobright-scraper',
        pid: process.pid,
        // Version comes from package.json at read time; logger doesn't need to
        // hot-reload it, so a static import-time value is fine.
        nodeEnv: env.NODE_ENV,
    };

    const options = {
        level,
        base,
        // Hide the default hostname to keep log lines short in dev terminals.
        redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', '*.token', '*.password'],
            remove: true,
        },
        timestamp: pino.stdTimeFunctions.isoTime,
    };

    if (prettyPrint) {
        return pino({
            ...options,
            transport: {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'HH:MM:ss.l',
                    ignore: 'pid,hostname,service,nodeEnv',
                    singleLine: false,
                },
            },
        });
    }
    return pino(options);
}

export const logger = buildLogger();
