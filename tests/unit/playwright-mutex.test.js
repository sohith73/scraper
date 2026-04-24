import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMutex } from '../../src/playwright/mutex.js';

test('serialises calls in FIFO order', async () => {
    const mutex = createMutex();
    const order = [];
    const tasks = [1, 2, 3].map((n) =>
        mutex.run(async () => {
            order.push(`start-${n}`);
            await new Promise((r) => setTimeout(r, 10));
            order.push(`end-${n}`);
            return n;
        }),
    );
    const results = await Promise.all(tasks);
    assert.deepEqual(results, [1, 2, 3]);
    assert.deepEqual(order, [
        'start-1', 'end-1',
        'start-2', 'end-2',
        'start-3', 'end-3',
    ]);
});

test('an earlier failure does not block later callers', async () => {
    const mutex = createMutex();
    const errors = [];
    const p1 = mutex.run(async () => {
        throw new Error('boom');
    }).catch((e) => errors.push(e.message));
    const p2 = mutex.run(async () => 'ok');
    await Promise.all([p1, p2]);
    assert.deepEqual(errors, ['boom']);
    assert.equal(await p2, 'ok');
});

test('size reflects queue depth', async () => {
    const mutex = createMutex();
    let release;
    const gate = new Promise((r) => (release = r));
    const running = mutex.run(async () => gate);
    const queued1 = mutex.run(async () => 1);
    const queued2 = mutex.run(async () => 2);
    // Tiny yield — size reflects enqueues already done.
    await new Promise((r) => setImmediate(r));
    assert.equal(mutex.size, 3);
    release();
    await Promise.all([running, queued1, queued2]);
    assert.equal(mutex.size, 0);
});
