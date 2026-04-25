// Batch routes — the "Scrape All" flow.
//
//   POST /api/batches                 body { clients:[{email,name,count}] }
//   GET  /api/batches                 list all batches (summary view)
//   GET  /api/batches/:id             snapshot of one batch
//   GET  /api/batches/:id/events      SSE stream (emits on every item transition)
//   POST /api/batches/:id/cancel      cooperatively cancel the batch

import { Router } from 'express';
import { resultCodeToStatus } from './clients.js';

function respondOk(res, req, value, status = 200) {
    res.status(status).json({ success: true, requestId: req.id, ...value });
}
function respondErr(res, req, code, message) {
    res.status(resultCodeToStatus(code)).json({
        success: false,
        error: code,
        message,
        requestId: req.id,
    });
}

export function batchesRouter({ container }) {
    if (!container?.batches) {
        throw new Error('batchesRouter: container.batches is required');
    }
    const router = Router();

    // POST /api/batches
    router.post('/batches', (req, res) => {
        try {
            const { clients } = req.body || {};
            const batch = container.batches.start({ clients });
            respondOk(res, req, { batch }, 201);
        } catch (e) {
            if (e.code === 'BATCH_BUSY') {
                return res.status(409).json({
                    success: false,
                    error: 'BATCH_BUSY',
                    message: e.message,
                    requestId: req.id,
                });
            }
            respondErr(res, req, 'BAD_INPUT', e.message);
        }
    });

    // GET /api/batches
    router.get('/batches', (req, res) => {
        respondOk(res, req, { batches: container.batches.list() });
    });

    // GET /api/batches/:id
    router.get('/batches/:id', (req, res) => {
        const b = container.batches.get(req.params.id);
        if (!b) return respondErr(res, req, 'NOT_FOUND', 'batch not found');
        respondOk(res, req, { batch: b });
    });

    // POST /api/batches/:id/cancel
    router.post('/batches/:id/cancel', (req, res) => {
        const b = container.batches.cancel(req.params.id);
        if (!b) return respondErr(res, req, 'NOT_FOUND', 'batch not found');
        respondOk(res, req, { batch: b });
    });

    // GET /api/batches/:id/events — SSE stream
    router.get('/batches/:id/events', (req, res) => {
        const id = req.params.id;
        const current = container.batches.get(id);
        if (!current) {
            res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'batch not found' });
            return;
        }
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache, no-transform');
        res.setHeader('connection', 'keep-alive');
        res.setHeader('x-accel-buffering', 'no');
        res.flushHeaders?.();

        const send = (state) => {
            try {
                res.write(`id: ${state.eventSeq}\n`);
                res.write(`event: state\n`);
                res.write(`data: ${JSON.stringify(state)}\n\n`);
            } catch { /* socket gone */ }
        };
        send(current);

        if (current.status !== 'running') {
            res.end();
            return;
        }

        const unsubscribe = container.batches.subscribe(id, (state) => {
            send(state);
            if (state.status !== 'running') res.end();
        });
        const heartbeat = setInterval(() => {
            try { res.write(': ping\n\n'); } catch { /* ignore */ }
        }, 15_000);

        const cleanup = () => {
            clearInterval(heartbeat);
            unsubscribe();
        };
        req.on('close', cleanup);
        req.on('aborted', cleanup);
    });

    return router;
}
