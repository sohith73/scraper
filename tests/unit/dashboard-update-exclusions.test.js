import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateExclusions } from '../../src/clients/dashboard/updateExclusions.js';
import { HttpError } from '../../src/clients/common/httpClient.js';

function fakeHttp({ envelope, error, calls } = {}) {
    return {
        putJson: async (path, body) => {
            if (calls) calls.push({ path, body });
            if (error) throw error;
            return envelope;
        },
    };
}

test('rejects invalid email', async () => {
    const r = await updateExclusions({
        http: fakeHttp({ envelope: {} }),
        email: 'nope',
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('PUTs normalised body to /operations/client-operations', async () => {
    const calls = [];
    const http = fakeHttp({ calls, envelope: { status: 200, bodyJson: { success: true } } });
    await updateExclusions({
        http,
        email: 'Alice@Co.com',
        companies: ['Acme', '  Acme  ', '', 'BetaCo'],
        locations: ['New York', 'new york', 'SF'],
    });
    assert.deepEqual(calls[0], {
        path: '/operations/client-operations',
        body: {
            clientEmail: 'alice@co.com',
            excludedCompanies: ['Acme', 'BetaCo'],
            excludedLocations: ['New York', 'SF'],
            operatorName: 'JRA',
        },
    });
});

test('200 → ok with normalised lists', async () => {
    const http = fakeHttp({
        envelope: { status: 200, bodyJson: { success: true } },
    });
    const r = await updateExclusions({
        http,
        email: 'a@b.com',
        companies: ['X'],
        locations: ['Y'],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.excludedCompanies, ['X']);
    assert.deepEqual(r.value.excludedLocations, ['Y']);
});

test('non-200 → BAD_STATUS', async () => {
    const http = fakeHttp({
        envelope: { status: 500, bodyJson: { message: 'boom' } },
    });
    const r = await updateExclusions({ http, email: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_STATUS');
    assert.equal(r.error.status, 500);
});

test('HttpError kind surfaces as typed Result', async () => {
    const http = fakeHttp({ error: new HttpError('timeout', 'slow') });
    const r = await updateExclusions({ http, email: 'a@b.com' });
    assert.equal(r.error.code, 'TIMEOUT');
});

test('default operatorName is JRA', async () => {
    const calls = [];
    const http = fakeHttp({ calls, envelope: { status: 200, bodyJson: {} } });
    await updateExclusions({ http, email: 'a@b.com' });
    assert.equal(calls[0].body.operatorName, 'JRA');
});

test('empty lists accepted + passed through', async () => {
    const calls = [];
    const http = fakeHttp({ calls, envelope: { status: 200, bodyJson: {} } });
    const r = await updateExclusions({ http, email: 'a@b.com' });
    assert.equal(r.ok, true);
    assert.deepEqual(calls[0].body.excludedCompanies, []);
    assert.deepEqual(calls[0].body.excludedLocations, []);
});
