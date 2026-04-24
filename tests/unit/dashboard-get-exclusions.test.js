import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getExclusions } from '../../src/clients/dashboard/getExclusions.js';

function fakeHttp({ envelope, calls } = {}) {
    return {
        postJson: async (path, body) => {
            if (calls) calls.push({ path, body });
            return envelope;
        },
    };
}

test('rejects invalid email', async () => {
    const r = await getExclusions({ http: fakeHttp({ envelope: {} }), email: 'nope' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('lowercases email and posts correct body', async () => {
    const calls = [];
    const http = fakeHttp({
        calls,
        envelope: {
            status: 200,
            bodyJson: { excludedCompanies: ['Acme'], excludedLocations: ['NYC'] },
        },
    });
    await getExclusions({ http, email: 'Alice@Example.com' });
    assert.deepEqual(calls[0], {
        path: '/operations/client-operations',
        body: { clientEmail: 'alice@example.com' },
    });
});

test('reads lists from top-level envelope', async () => {
    const http = fakeHttp({
        envelope: {
            status: 200,
            bodyJson: {
                excludedCompanies: ['Acme', 'acme', 'BetaCo'],
                excludedLocations: ['new york', 'New York', 'Remote'],
            },
        },
    });
    const r = await getExclusions({ http, email: 'a@b.com' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.excludedCompanies.sort(), ['acme', 'betaco']);
    assert.deepEqual(r.value.excludedLocations.sort(), ['new york', 'remote']);
});

test('reads lists from body.clientOperations envelope', async () => {
    const http = fakeHttp({
        envelope: {
            status: 200,
            bodyJson: {
                clientOperations: {
                    excludedCompanies: ['X'],
                    excludedLocations: ['Y'],
                },
            },
        },
    });
    const r = await getExclusions({ http, email: 'a@b.com' });
    assert.deepEqual(r.value.excludedCompanies, ['x']);
    assert.deepEqual(r.value.excludedLocations, ['y']);
});

test('reads lists from body.result envelope', async () => {
    const http = fakeHttp({
        envelope: {
            status: 200,
            bodyJson: {
                result: { excludedCompanies: ['Z'], excludedLocations: [] },
            },
        },
    });
    const r = await getExclusions({ http, email: 'a@b.com' });
    assert.deepEqual(r.value.excludedCompanies, ['z']);
});

test('returns empty lists when fields absent entirely', async () => {
    const http = fakeHttp({ envelope: { status: 200, bodyJson: {} } });
    const r = await getExclusions({ http, email: 'a@b.com' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.excludedCompanies, []);
    assert.deepEqual(r.value.excludedLocations, []);
});

test('BAD_STATUS on non-200', async () => {
    const http = fakeHttp({ envelope: { status: 500, bodyJson: { error: 'db' } } });
    const r = await getExclusions({ http, email: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_STATUS');
});
