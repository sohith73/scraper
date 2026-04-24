import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listClients } from '../../src/clients/dashboard/listClients.js';
import { HttpError } from '../../src/clients/common/httpClient.js';

// fakeHttp: returns a shim whose .get resolves to a canned envelope or throws.
function fakeHttp({ envelope, error } = {}) {
    return {
        get: async () => {
            if (error) throw error;
            return envelope;
        },
    };
}

test('returns normalised clients on 200', async () => {
    const http = fakeHttp({
        envelope: {
            status: 200,
            bodyJson: {
                success: true,
                count: 2,
                data: [
                    { email: 'Alice@Example.com', name: 'Alice', userID: 'u1', planType: 'Ignite' },
                    { email: 'bob@example.com', name: 'Bob', userID: 'u2' },
                    { email: '', name: 'skip-me' }, // dropped
                    { name: 'also-skipped' }, // dropped
                ],
            },
        },
    });
    const r = await listClients({ http });
    assert.equal(r.ok, true);
    assert.equal(r.value.count, 2);
    assert.deepEqual(r.value.clients[0], {
        email: 'alice@example.com',
        name: 'Alice',
        userID: 'u1',
        planType: 'Ignite',
        dashboardManager: '',
    });
    assert.equal(r.value.clients[1].email, 'bob@example.com');
});

test('BAD_SHAPE when success !== true', async () => {
    const http = fakeHttp({
        envelope: { status: 200, bodyJson: { success: false, data: [] } },
    });
    const r = await listClients({ http });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_SHAPE');
});

test('BAD_SHAPE when data is not an array', async () => {
    const http = fakeHttp({
        envelope: { status: 200, bodyJson: { success: true, data: 'nope' } },
    });
    const r = await listClients({ http });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_SHAPE');
});

test('BAD_STATUS on non-200', async () => {
    const http = fakeHttp({ envelope: { status: 500, bodyJson: { message: 'boom' } } });
    const r = await listClients({ http });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_STATUS');
    assert.equal(r.error.status, 500);
});

test('NETWORK when httpClient throws HttpError kind=network', async () => {
    const http = fakeHttp({ error: new HttpError('network', 'socket hangup') });
    const r = await listClients({ http });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'NETWORK');
});

test('TIMEOUT when httpClient throws HttpError kind=timeout', async () => {
    const http = fakeHttp({ error: new HttpError('timeout', 'slow') });
    const r = await listClients({ http });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'TIMEOUT');
});

test('rethrows unexpected non-HttpError exceptions', async () => {
    const http = fakeHttp({ error: new TypeError('not my class') });
    await assert.rejects(() => listClients({ http }), TypeError);
});
