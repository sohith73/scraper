import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getResumeByEmail } from '../../src/clients/resume/getResumeByEmail.js';
import { HttpError } from '../../src/clients/common/httpClient.js';

function fakeHttp({ envelope, error, calls } = {}) {
    return {
        postJson: async (path, body) => {
            if (calls) calls.push({ path, body });
            if (error) throw error;
            return envelope;
        },
    };
}

test('rejects invalid email', async () => {
    const r = await getResumeByEmail({ http: fakeHttp({ envelope: {} }), email: '' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_INPUT');
});

test('posts lowercase email to /api/resume-by-email', async () => {
    const calls = [];
    const http = fakeHttp({
        calls,
        envelope: {
            status: 200,
            bodyJson: {
                resumeId: 'r1',
                V: 2,
                firstName: 'Alice',
                personalInfo: { name: 'Alice Doe' },
                skills: ['js'],
            },
        },
    });
    await getResumeByEmail({ http, email: 'Alice@Example.com' });
    assert.deepEqual(calls[0], {
        path: '/api/resume-by-email',
        body: { email: 'alice@example.com' },
    });
});

test('200: splits resume content from meta', async () => {
    const http = fakeHttp({
        envelope: {
            status: 200,
            bodyJson: {
                resumeId: 'r42',
                V: 3,
                firstName: 'Alice',
                lastName: 'Doe',
                checkboxStates: { showProjects: true },
                sectionOrder: ['personalInfo', 'skills'],
                personalInfo: { name: 'Alice Doe' },
                summary: 'Experienced eng',
                skills: ['python'],
            },
        },
    });
    const r = await getResumeByEmail({ http, email: 'a@b.com' });
    assert.equal(r.ok, true);
    assert.equal(r.value.found, true);
    assert.equal(r.value.meta.resumeId, 'r42');
    assert.equal(r.value.meta.version, 3);
    assert.equal(r.value.meta.firstName, 'Alice');
    assert.deepEqual(r.value.meta.sectionOrder, ['personalInfo', 'skills']);
    // content object should NOT contain metadata fields
    assert.equal(r.value.resume.resumeId, undefined);
    assert.equal(r.value.resume.V, undefined);
    assert.equal(r.value.resume.checkboxStates, undefined);
    // content object SHOULD contain actual resume fields
    assert.deepEqual(r.value.resume.personalInfo, { name: 'Alice Doe' });
    assert.deepEqual(r.value.resume.skills, ['python']);
});

test('404 "no resume assigned" → found:false reason:no-resume', async () => {
    const http = fakeHttp({
        envelope: { status: 404, bodyJson: { error: 'No resume assigned to this user' } },
    });
    const r = await getResumeByEmail({ http, email: 'a@b.com' });
    assert.equal(r.ok, true);
    assert.equal(r.value.found, false);
    assert.equal(r.value.reason, 'no-resume');
});

test('404 "Resume file missing" → found:false reason:file-missing', async () => {
    const http = fakeHttp({
        envelope: { status: 404, bodyJson: { error: 'Resume file missing' } },
    });
    const r = await getResumeByEmail({ http, email: 'a@b.com' });
    assert.equal(r.ok, true);
    assert.equal(r.value.found, false);
    assert.equal(r.value.reason, 'file-missing');
});

test('400 → BAD_STATUS', async () => {
    const http = fakeHttp({
        envelope: { status: 400, bodyJson: { error: 'Email is required' } },
    });
    const r = await getResumeByEmail({ http, email: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_STATUS');
    assert.equal(r.error.status, 400);
});

test('500 → BAD_STATUS', async () => {
    const http = fakeHttp({
        envelope: { status: 500, bodyJson: { error: 'Failed to get resume' } },
    });
    const r = await getResumeByEmail({ http, email: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_STATUS');
});

test('defaults meta fields when fields missing in response', async () => {
    const http = fakeHttp({
        envelope: {
            status: 200,
            bodyJson: { personalInfo: { name: 'X' } },
        },
    });
    const r = await getResumeByEmail({ http, email: 'a@b.com' });
    assert.equal(r.ok, true);
    assert.equal(r.value.meta.resumeId, '');
    assert.equal(r.value.meta.version, 0);
    assert.deepEqual(r.value.meta.sectionOrder, []);
    assert.equal(r.value.meta.checkboxStates, null);
});

test('propagates transport errors as typed Result', async () => {
    const http = fakeHttp({ error: new HttpError('timeout', 'slow') });
    const r = await getResumeByEmail({ http, email: 'a@b.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'TIMEOUT');
});

test('rethrows unexpected exception types', async () => {
    const http = fakeHttp({ error: new TypeError('nope') });
    await assert.rejects(() => getResumeByEmail({ http, email: 'a@b.com' }), TypeError);
});
