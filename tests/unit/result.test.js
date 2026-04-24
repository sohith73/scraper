import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, isOk, isErr } from '../../src/clients/common/result.js';

test('ok wraps a value', () => {
    const r = ok(42);
    assert.equal(r.ok, true);
    assert.equal(r.value, 42);
    assert.equal(isOk(r), true);
    assert.equal(isErr(r), false);
});

test('err carries code + message + extras', () => {
    const r = err('NETWORK', 'boom', { status: 503, cause: new Error('x') });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'NETWORK');
    assert.equal(r.error.message, 'boom');
    assert.equal(r.error.status, 503);
    assert.ok(r.error.cause instanceof Error);
    assert.equal(isErr(r), true);
});
