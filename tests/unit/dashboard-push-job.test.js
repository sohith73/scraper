import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushJob, buildPushJobPayload } from '../../src/clients/dashboard/pushJob.js';

function fakeHttp({ envelope, calls } = {}) {
    return {
        postJson: async (path, body) => {
            if (calls) calls.push({ path, body });
            return envelope;
        },
    };
}

const baseJob = {
    jobTitle: 'Senior Backend Engineer',
    companyName: 'Foundation EGI',
    jobLocation: 'United States',
    jobDescription: 'full JD here',
    joblink: 'https://jobs.lever.co/foundation/abc',
};

test('buildPushJobPayload mirrors the dashboard contract', () => {
    const payload = buildPushJobPayload({
        job: baseJob,
        clientEmail: 'Client@Co.com',
        clientName: 'Client',
    });
    assert.equal(payload.role, 'operations');
    assert.equal(payload.operationsEmail, 'scraper@flashfirehq');
    assert.equal(payload.operationsName, 'JRA');
    assert.equal(payload.jobDetails.userID, 'client@co.com');
    assert.equal(payload.userDetails.email, 'client@co.com');
    assert.equal(payload.userDetails.name, 'Client');
    assert.equal(payload.jobDetails.jobTitle, 'Senior Backend Engineer');
});

test('truncates long jobTitle to 50 chars (matches dashboard validator)', () => {
    const long = 'x'.repeat(100);
    const payload = buildPushJobPayload({ job: { ...baseJob, jobTitle: long }, clientEmail: 'a@b.com' });
    assert.equal(payload.jobDetails.jobTitle.length, 50);
});

test('rejects missing client email', async () => {
    const r = await pushJob({ http: fakeHttp({ envelope: {} }), job: baseJob, clientEmail: '' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('rejects invalid job shape', async () => {
    const r = await pushJob({
        http: fakeHttp({ envelope: {} }),
        job: { jobTitle: 'x' }, // missing companyName + joblink
        clientEmail: 'a@b.com',
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
    assert.match(r.error.message, /companyName/);
});

test('dryRun: returns payload without calling http', async () => {
    const calls = [];
    const http = fakeHttp({ calls, envelope: { status: 500 } });
    const r = await pushJob({ http, job: baseJob, clientEmail: 'a@b.com', dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.value.outcome, 'dry-run');
    assert.equal(r.value.payload.jobDetails.companyName, 'Foundation EGI');
    assert.equal(calls.length, 0);
});

test('200: returns createdJobId', async () => {
    const http = fakeHttp({
        envelope: {
            status: 200,
            bodyJson: { message: 'job added succesfully', createdJobId: 'abc123', NewJobList: [] },
        },
    });
    const r = await pushJob({ http, job: baseJob, clientEmail: 'a@b.com' });
    assert.equal(r.ok, true);
    assert.equal(r.value.outcome, 'created');
    assert.equal(r.value.createdJobId, 'abc123');
});

test('200 without createdJobId is classified BAD_SHAPE', async () => {
    const http = fakeHttp({ envelope: { status: 200, bodyJson: { message: 'ok' } } });
    const r = await pushJob({ http, job: baseJob, clientEmail: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_SHAPE');
});

test('403 BLOCKED_COMPANY', async () => {
    const http = fakeHttp({
        envelope: {
            status: 403,
            bodyJson: { error: 'BLOCKED_COMPANY', message: 'Blocked' },
        },
    });
    const r = await pushJob({ http, job: baseJob, clientEmail: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BLOCKED_COMPANY');
});

test('403 BLOCKED_LOCATION', async () => {
    const http = fakeHttp({
        envelope: {
            status: 403,
            bodyJson: { error: 'BLOCKED_LOCATION', message: 'Blocked loc' },
        },
    });
    const r = await pushJob({ http, job: baseJob, clientEmail: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BLOCKED_LOCATION');
});

test('403 "Job Already Exist" → duplicate outcome (ok result, not error)', async () => {
    const http = fakeHttp({
        envelope: {
            status: 403,
            bodyJson: { message: 'Job Already Exist  !' },
        },
    });
    const r = await pushJob({ http, job: baseJob, clientEmail: 'a@b.com' });
    assert.equal(r.ok, true);
    assert.equal(r.value.outcome, 'duplicate');
});

test('403 lock period → CLIENT_LOCKED', async () => {
    const http = fakeHttp({
        envelope: {
            status: 403,
            bodyJson: { message: 'Client is in lock period' },
        },
    });
    const r = await pushJob({ http, job: baseJob, clientEmail: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'CLIENT_LOCKED');
});

test('400 bad input surfaces dashboard message', async () => {
    const http = fakeHttp({
        envelope: {
            status: 400,
            bodyJson: { message: 'Job title is required and must be at most 50 characters.' },
        },
    });
    const r = await pushJob({ http, job: baseJob, clientEmail: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
    assert.match(r.error.message, /Job title/);
});

test('500 → BAD_STATUS', async () => {
    const http = fakeHttp({
        envelope: {
            status: 500,
            bodyJson: { message: 'Failed to add job', error: 'db is down' },
        },
    });
    const r = await pushJob({ http, job: baseJob, clientEmail: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_STATUS');
    assert.equal(r.error.status, 500);
});
