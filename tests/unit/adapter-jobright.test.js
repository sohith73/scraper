import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeJobRightJob,
    composeDescription,
    toDashboardJob,
    isLinkedInApplyUrl,
} from '../../src/adapters/jobright.js';

// Minimal realistic JR entry — mirrors the shape we captured live in recon.
const REAL_JR_JOB = {
    impId: '3678491_default_X_8454',
    displayScore: 13.1001,
    rankDesc: 'Fair Match',
    pos: 0,
    jobResult: {
        jobId: '69e9ccbc7820c036924e9db0',
        jobTitle: 'Software Engineer',
        jobSeniority: 'Senior Level',
        jobLocation: 'Somerville, MA',
        isRemote: true,
        workModel: 'Hybrid',
        publishTime: '2026-04-23 00:00:00',
        publishTimeDesc: '19 minutes ago',
        employmentType: 'Full-time',
        jobSummary: 'Build great things.',
        originalUrl: 'https://jobs.lever.co/foo/apply',
        applyLink: 'https://jobs.lever.co/foo/apply',
        applicantsCount: 96,
        minYearsOfExperience: 5,
        coreResponsibilities: ['Design systems', 'Write code'],
        recommendationTags: ['H1B Sponsor Likely'],
        jobTags: ['Be an early applicant'],
        skillSummaries: ['Python', 'Go'],
        qualifications: {
            mustHave: ['5+ years experience', 'BS degree'],
            preferredHave: ['Open source contributions'],
        },
        isH1bSponsor: true,
        isCitizenOnly: false,
        isClearanceRequired: false,
        isWorkAuthRequired: false,
    },
    companyResult: {
        companyName: 'Osmo',
        companySize: '11-50 employees',
        companyDesc: 'Electronics / Hardware startup.',
        companyCategories: 'Electronics,Hardware,Growth Stage',
        companyLinkedinURL: 'https://linkedin.com/company/osmo',
        companyURL: 'https://osmo.com',
        companyLocation: 'Somerville, MA',
        companyFoundYear: '2020',
        fundraisingCurrentStage: 'Growth Stage',
        fundraisingTotalFunding: '$50M',
    },
};

test('normalizeJobRightJob returns null for non-objects', () => {
    assert.equal(normalizeJobRightJob(null), null);
    assert.equal(normalizeJobRightJob(undefined), null);
    assert.equal(normalizeJobRightJob('string'), null);
});

test('normalizeJobRightJob skips entries missing jobId', () => {
    assert.equal(normalizeJobRightJob({ jobResult: {} }), null);
    assert.equal(
        normalizeJobRightJob({ jobResult: { jobTitle: 'x' } }),
        null,
    );
});

test('normalizeJobRightJob maps every canonical field', () => {
    const j = normalizeJobRightJob(REAL_JR_JOB);
    assert.equal(j.id, '69e9ccbc7820c036924e9db0');
    assert.equal(j.impId, '3678491_default_X_8454');
    assert.equal(j.title, 'Software Engineer');
    assert.equal(j.companyName, 'Osmo');
    assert.equal(j.jobLocation, 'Somerville, MA');
    assert.equal(j.workModel, 'Hybrid');
    assert.equal(j.isRemote, true);
    assert.equal(j.employmentType, 'Full-time');
    assert.equal(j.seniority, 'Senior Level');
    assert.equal(j.minYearsOfExperience, 5);
    assert.equal(j.publishedAt, '2026-04-23 00:00:00');
    assert.equal(j.publishedAtRelative, '19 minutes ago');
    assert.equal(j.applicantsCount, 96);
    assert.equal(j.applyUrl, 'https://jobs.lever.co/foo/apply');
    assert.deepEqual(j.requirements.must, ['5+ years experience', 'BS degree']);
    assert.deepEqual(j.requirements.preferred, ['Open source contributions']);
    assert.deepEqual(j.tags, ['H1B Sponsor Likely', 'Be an early applicant']);
    assert.deepEqual(j.flags, {
        h1bSponsor: true,
        citizenOnly: false,
        clearanceRequired: false,
        workAuthRequired: false,
    });
    assert.equal(j.score.raw, 13.1001);
    assert.equal(j.score.label, 'Fair Match');
    assert.equal(j.company.name, 'Osmo');
    assert.equal(j.company.size, '11-50 employees');
    assert.deepEqual(j.company.categories, ['Electronics', 'Hardware', 'Growth Stage']);
});

test('normalizeJobRightJob preserves raw payload at .raw', () => {
    const j = normalizeJobRightJob(REAL_JR_JOB);
    assert.strictEqual(j.raw, REAL_JR_JOB);
});

test('normalizeJobRightJob tolerates missing sub-records', () => {
    const minimal = { jobResult: { jobId: 'x', jobTitle: 'T' } };
    const j = normalizeJobRightJob(minimal);
    assert.equal(j.id, 'x');
    assert.equal(j.companyName, '');
    assert.equal(j.applyUrl, '');
    assert.deepEqual(j.requirements.must, []);
    assert.deepEqual(j.tags, []);
    assert.deepEqual(j.company.categories, []);
});

test('normalizeJobRightJob falls back from applyLink to originalUrl', () => {
    const j = normalizeJobRightJob({
        jobResult: {
            jobId: 'x',
            jobTitle: 'T',
            originalUrl: 'https://original',
            // no applyLink
        },
    });
    assert.equal(j.applyUrl, 'https://original');
});

test('composeDescription: empty JR → empty string', () => {
    assert.equal(composeDescription(null), '');
    assert.equal(composeDescription({}), '');
});

test('composeDescription: concatenates summary + responsibilities + must + preferred + skills', () => {
    const out = composeDescription({
        jobSummary: 'Do things.',
        coreResponsibilities: ['A', 'B'],
        qualifications: { mustHave: ['MH1', 'MH2'], preferredHave: ['P1'] },
        skillSummaries: ['Go'],
    });
    assert.match(out, /Do things\./);
    assert.match(out, /Responsibilities:/);
    assert.match(out, /• A\n• B/);
    assert.match(out, /Must have:/);
    assert.match(out, /• MH1\n• MH2/);
    assert.match(out, /Nice to have:/);
    assert.match(out, /• P1/);
    assert.match(out, /Key skills:/);
    assert.match(out, /• Go/);
});

test('composeDescription: emits only the sections that have content', () => {
    const out = composeDescription({ jobSummary: 'Only summary.' });
    assert.equal(out, 'Only summary.');
});

test('toDashboardJob shape matches what dashboard.pushJob expects', () => {
    const j = normalizeJobRightJob(REAL_JR_JOB);
    const d = toDashboardJob(j);
    assert.deepEqual(Object.keys(d).sort(), [
        'companyName',
        'jobDescription',
        'jobLocation',
        'jobTitle',
        'joblink',
    ]);
    assert.equal(d.jobTitle, 'Software Engineer');
    assert.equal(d.joblink, 'https://jobs.lever.co/foo/apply');
    assert.ok(d.jobDescription.length > 0);
});

// --- isLinkedInApplyUrl --------------------------------------------------

test('isLinkedInApplyUrl: matches linkedin.com + subdomains', () => {
    for (const u of [
        'https://www.linkedin.com/jobs/view/123456',
        'https://linkedin.com/jobs/view/1',
        'https://www.linkedin.com/comm/jobs/view/abc',
        'http://LINKEDIN.com/jobs',
        'https://jobs.linkedin.com/view/1',
    ]) {
        assert.equal(isLinkedInApplyUrl(u), true, `expected LinkedIn: ${u}`);
    }
});

test('isLinkedInApplyUrl: does NOT match direct career URLs', () => {
    for (const u of [
        'https://jobs.lever.co/foo/apply',
        'https://boards.greenhouse.io/acme/jobs/123',
        'https://careers.stripe.com/jobs/xyz',
        'https://apply.workable.com/foo/j/abc',
        'https://example.com/?ref=linkedin.com',  // substring in query, not host
    ]) {
        assert.equal(isLinkedInApplyUrl(u), false, `should NOT match: ${u}`);
    }
});

test('isLinkedInApplyUrl: false for falsy / non-strings / malformed', () => {
    assert.equal(isLinkedInApplyUrl(''), false);
    assert.equal(isLinkedInApplyUrl(null), false);
    assert.equal(isLinkedInApplyUrl(undefined), false);
    assert.equal(isLinkedInApplyUrl(42), false);
});

test('isLinkedInApplyUrl: malformed URL falls back to substring check', () => {
    // Not parseable as URL but clearly LinkedIn — defensive fallback catches it.
    assert.equal(isLinkedInApplyUrl('not-a-url-but-linkedin.com/jobs/123'), true);
});
