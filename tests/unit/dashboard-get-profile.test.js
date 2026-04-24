import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProfile } from '../../src/clients/dashboard/getProfile.js';

function fakeHttp({ envelope, calls } = {}) {
    return {
        get: async (path) => {
            if (calls) calls.push({ path });
            return envelope;
        },
    };
}

test('rejects missing / malformed email', async () => {
    let r = await getProfile({ http: fakeHttp({ envelope: {} }), email: '' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');

    r = await getProfile({ http: fakeHttp({ envelope: {} }), email: 'no-at-sign' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('lowercases + url-encodes email in the path', async () => {
    const calls = [];
    const http = fakeHttp({
        calls,
        envelope: {
            status: 200,
            bodyJson: {
                userProfile: { firstName: 'A', removedJobsCount: 3 },
            },
        },
    });
    await getProfile({ http, email: 'Alice+tag@Example.com' });
    assert.equal(calls[0].path, '/get-profile?email=alice%2Btag%40example.com');
});

test('returns profile + removedJobsCount on 200', async () => {
    const http = fakeHttp({
        envelope: {
            status: 200,
            bodyJson: {
                userProfile: {
                    firstName: 'Alice',
                    preferredRoles: ['Backend Engineer'],
                    removedJobsCount: 5,
                },
            },
        },
    });
    const r = await getProfile({ http, email: 'a@b.com' });
    assert.equal(r.ok, true);
    assert.equal(r.value.profile.firstName, 'Alice');
    assert.deepEqual(r.value.profile.preferredRoles, ['Backend Engineer']);
    assert.equal(r.value.removedJobsCount, 5);
    // removedJobsCount is stripped from the returned profile
    assert.equal(r.value.profile.removedJobsCount, undefined);
});

test('removedJobsCount defaults to 0 when missing', async () => {
    const http = fakeHttp({
        envelope: { status: 200, bodyJson: { userProfile: { firstName: 'A' } } },
    });
    const r = await getProfile({ http, email: 'a@b.com' });
    assert.equal(r.ok, true);
    assert.equal(r.value.removedJobsCount, 0);
});

test('NOT_FOUND on 404', async () => {
    const http = fakeHttp({
        envelope: { status: 404, bodyJson: { message: 'Profile not found' } },
    });
    const r = await getProfile({ http, email: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'NOT_FOUND');
    assert.equal(r.error.status, 404);
});

test('BAD_SHAPE when userProfile missing', async () => {
    const http = fakeHttp({ envelope: { status: 200, bodyJson: { message: 'hi' } } });
    const r = await getProfile({ http, email: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_SHAPE');
});

test('BAD_STATUS on unexpected status', async () => {
    const http = fakeHttp({ envelope: { status: 418, bodyJson: { message: 'teapot' } } });
    const r = await getProfile({ http, email: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_STATUS');
    assert.equal(r.error.status, 418);
});
