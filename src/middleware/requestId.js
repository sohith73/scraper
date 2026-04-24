// Request ID middleware.
// Assigns a short random ID to every request for log correlation. Honors a
// caller-supplied `x-request-id` if present (useful when a parent service
// already generated one).

import { randomUUID } from 'node:crypto';

// requestId: Express middleware that sets req.id and echoes x-request-id.
// input  : express req/res/next
// output : void (mutates req.id, sets response header)
export function requestId() {
    return function requestIdMiddleware(req, res, next) {
        const incoming = req.headers['x-request-id'];
        // Accept the incoming id only if it's a short-ish printable string —
        // never trust arbitrarily long header values.
        const safe =
            typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 120
                ? incoming
                : randomUUID();
        req.id = safe;
        res.setHeader('x-request-id', safe);
        next();
    };
}
