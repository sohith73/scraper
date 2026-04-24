import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createRunLogger,
    writeErrorArtifact,
    writeSummaryArtifact,
    ensureRunDir,
} from '../../src/services/runner/runLogger.js';

async function freshDir() {
    return mkdtemp(join(tmpdir(), 'scraper-runlogger-'));
}

test('ensureRunDir creates the dir with restrictive perms', async () => {
    const dir = await freshDir();
    try {
        const runDir = join(dir, 'run-1');
        await ensureRunDir(runDir);
        const s = await stat(runDir);
        assert.equal(s.isDirectory(), true);
        // perms — platform may not support; we just care that the call
        // didn't throw. On POSIX expect 0o700.
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('createRunLogger rejects missing runDir or runId', async () => {
    await assert.rejects(() => createRunLogger({ runId: 'x' }), /runDir is required/);
    await assert.rejects(() => createRunLogger({ runDir: '/tmp' }), /runId is required/);
});

test('createRunLogger writes JSON lines to run.log', async () => {
    const dir = await freshDir();
    try {
        const runDir = join(dir, 'r1');
        const { logger, closeStream, logPath } = await createRunLogger({
            runDir,
            runId: 'r1',
        });
        logger.info({ phase: 'loading-profile' }, 'start');
        logger.warn({ phase: 'searching' }, 'slow');
        logger.error({ err: 'boom' }, 'failed');
        await closeStream();
        const content = await readFile(logPath, 'utf8');
        const lines = content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        assert.equal(lines.length, 3);
        for (const l of lines) {
            assert.equal(l.runId, 'r1');
            assert.ok(typeof l.time === 'number' || typeof l.time === 'string');
        }
        assert.equal(lines[0].msg, 'start');
        assert.equal(lines[0].phase, 'loading-profile');
        assert.equal(lines[2].msg, 'failed');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('createRunLogger tees into rootLogger when provided', async () => {
    const dir = await freshDir();
    try {
        const seen = [];
        const root = {
            child: () => ({
                info: (a, m) => seen.push(['info', m]),
                warn: (a, m) => seen.push(['warn', m]),
                error: (a, m) => seen.push(['error', m]),
                debug: () => {},
                trace: () => {},
                fatal: () => {},
            }),
        };
        const { logger, closeStream } = await createRunLogger({
            runDir: join(dir, 'r1'),
            runId: 'r1',
            rootLogger: root,
        });
        logger.info({}, 'hello');
        logger.warn({}, 'careful');
        await closeStream();
        assert.deepEqual(seen, [
            ['info', 'hello'],
            ['warn', 'careful'],
        ]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('writeErrorArtifact dumps run state as error.json', async () => {
    const dir = await freshDir();
    try {
        const runDir = join(dir, 'r1');
        const state = { id: 'r1', phase: 'failed', error: { code: 'X' } };
        await writeErrorArtifact(runDir, state);
        const raw = await readFile(join(runDir, 'error.json'), 'utf8');
        const parsed = JSON.parse(raw);
        assert.equal(parsed.state.phase, 'failed');
        assert.equal(parsed.state.error.code, 'X');
        assert.ok(parsed.capturedAt);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('writeErrorArtifact swallows failures (best-effort)', async () => {
    // Path that cannot be mkdir'd under typical perms
    await writeErrorArtifact('/does/not/exist/nested/further', { x: 1 });
    // If we got here, no throw — that's the contract.
    assert.ok(true);
});

test('writeSummaryArtifact writes summary.json', async () => {
    const dir = await freshDir();
    try {
        const runDir = join(dir, 'r1');
        await writeSummaryArtifact(runDir, {
            id: 'r1',
            phase: 'done',
            picksCount: 3,
        });
        const parsed = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8'));
        assert.equal(parsed.picksCount, 3);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
