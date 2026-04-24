// Centralised error handler.
// Converts thrown errors / next(err) into a consistent JSON response and
// always logs with the request id. Never leaks stack traces in production.

import { env } from '../config/env.js';

// notFoundHandler: catches routes that matched no handler.
// input  : express req/res/next
// output : 404 JSON
export function notFoundHandler(req, res) {
    res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: `No route for ${req.method} ${req.originalUrl}`,
        requestId: req.id,
    });
}

// errorHandler: final Express error middleware (4-arg signature is required).
// input  : Error, express req/res/next
// output : 4xx/5xx JSON, logs the error with req.log if available
export function errorHandler(err, req, res, _next) {
    const status =
        Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599
            ? err.status
            : 500;

    const log = req.log || console;
    const severity = status >= 500 ? 'error' : 'warn';
    log[severity]?.(
        { err, status, path: req.originalUrl, method: req.method, reqId: req.id },
        'request failed',
    );

    const body = {
        success: false,
        error: err?.code || (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
        message:
            status >= 500 && env.NODE_ENV === 'production'
                ? 'Internal server error'
                : err?.message || 'Unknown error',
        requestId: req.id,
    };

    // Expose stack only in non-production to speed up dev debugging.
    if (env.NODE_ENV !== 'production' && err?.stack) {
        body.stack = String(err.stack).split('\n').slice(0, 8);
    }

    res.status(status).json(body);
}
