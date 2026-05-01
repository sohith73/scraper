#!/usr/bin/env node
// Smoke test for the manual-capture pipeline.
//
// What it does:
//   1. POSTs a small synthetic batch of "captured" raw JR jobs to
//      /api/manual-runs.
//   2. Polls the run via /api/runs/:id until it reaches a terminal phase
//      (or 60s passes).
//   3. Prints the final state + key artifacts on disk.
//
// Use this to verify the route + pipeline are wired end-to-end without
// installing the actual extension. Set CLIENT_EMAIL to a real client your
// scraper has profile access to (otherwise you'll see profile-load errors).
//
// Env:
//   API_BASE      default http://localhost:8092
//   CLIENT_EMAIL  default first client returned from /api/clients
//   CLIENT_NAME   optional

import { setTimeout as sleep } from 'node:timers/promises';

const API_BASE = (process.env.API_BASE || 'http://localhost:8092').replace(/\/+$/, '');
let CLIENT_EMAIL = process.env.CLIENT_EMAIL || '';
let CLIENT_NAME = process.env.CLIENT_NAME || '';

async function pickClient() {
    if (CLIENT_EMAIL) return;
    const res = await fetch(`${API_BASE}/api/clients`);
    const body = await res.json();
    if (!body?.clients?.length) {
        console.error('no clients available — set CLIENT_EMAIL env explicitly');
        process.exit(2);
    }
    CLIENT_EMAIL = body.clients[0].email;
    CLIENT_NAME = body.clients[0].name || '';
    console.log('using client', CLIENT_EMAIL, '(', CLIENT_NAME, ')');
}

function fakeJob(i) {
    const id = `smoke-${Date.now()}-${i}`;
    return {
        impId: `imp-${id}`,
        displayScore: 80,
        rankDesc: 'Strong Match',
        jobResult: {
            jobId: id,
            jobTitle: `Senior Software Engineer ${i}`,
            jobLocation: 'Remote',
            workModel: 'Remote',
            isRemote: true,
            employmentType: 'Full-time',
            jobSeniority: 'Senior',
            minYearsOfExperience: 4,
            publishTime: new Date().toISOString(),
            publishTimeDesc: '1d',
            applicantsCount: 12,
            applyLink: `https://example.com/apply/${id}`,
            jobSummary:
                'Build distributed systems and ship features end-to-end. '.repeat(15),
            coreResponsibilities: ['Ship', 'Mentor'],
            qualifications: { mustHave: ['JS', 'Node'], preferredHave: ['TS'] },
            skillSummaries: ['JavaScript', 'Node'],
            isH1bSponsor: true,
            isCitizenOnly: false,
            isClearanceRequired: false,
            isWorkAuthRequired: false,
            recommendationTags: ['Smoke Test'],
            jobTags: [],
        },
        companyResult: {
            companyName: `SmokeCo${i}`,
            companySize: '51-200',
            companyDesc: 'Test company',
            companyCategories: 'SaaS',
            companyLinkedinURL: '',
            companyURL: 'https://smokeco.example.com',
            companyLocation: 'Remote',
            companyFoundYear: '2020',
            fundraisingCurrentStage: 'Seed',
            fundraisingTotalFunding: '$5M',
        },
    };
}

async function main() {
    await pickClient();
    const captured = [fakeJob(1), fakeJob(2), fakeJob(3)];
    console.log(`POST /api/manual-runs with ${captured.length} synthetic jobs…`);
    const res = await fetch(`${API_BASE}/api/manual-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            clientEmail: CLIENT_EMAIL,
            clientName: CLIENT_NAME,
            capturedJobs: captured,
        }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        console.error('FAILED', res.status, body);
        process.exit(1);
    }
    const runId = body.run?.id;
    console.log('run started:', runId);

    const deadline = Date.now() + 60_000;
    let last = null;
    while (Date.now() < deadline) {
        const r = await fetch(`${API_BASE}/api/runs/${runId}`);
        const j = await r.json();
        last = j.run;
        if (last && ['done', 'failed', 'aborted'].includes(last.phase)) break;
        await sleep(800);
    }
    if (!last) {
        console.error('no state read');
        process.exit(1);
    }
    console.log('terminal phase:', last.phase);
    console.log('picks:', last.picks?.length || 0);
    if (last.error) console.log('error:', last.error);
    console.log('progress.searched:', last.progress?.searched);
    console.log('progress.pushed:', last.progress?.pushed);
    if (last.phase !== 'done') process.exit(1);
}

main().catch((e) => {
    console.error('smoke crashed', e);
    process.exit(1);
});
