// Per-run logger.
//
// Why : any failed run needs enough forensic data on disk to reproduce
//       WITHOUT re-running it live against JR. We tee every log line into
//       both the shared stdout logger (so operators watching the dev
//       console see it in context) AND a per-run file at
//       `runs/<id>/run.log`. The file is newline-delimited JSON — grep-
//       friendly + loadable by any log viewer.
//
// A companion helper writes `runs/<id>/error.json` with the frozen state
// on failure so the UI / a human can inspect without reading the
// full log.

import { createWriteStream } from 'node:fs';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pino from 'pino';

const RUN_DIR_MODE = 0o700;   // HARs + state.json may carry cookies — tight
const RUN_LOG_MODE = 0o600;

// ensureRunDir: create <runsDir>/<runId> with restrictive perms. Idempotent.
// input  : runDir (absolute path)
// output : Promise<void>
export async function ensureRunDir(runDir) {
    await mkdir(runDir, { recursive: true });
    try {
        await chmod(runDir, RUN_DIR_MODE);
    } catch {
        // non-POSIX filesystem or insufficient perms — not fatal
    }
}

// createRunLogger: returns a pino logger that writes to stdout AND to
// `<runDir>/run.log`. Child-derived from the root logger so the redaction
// rules + service metadata flow through.
//
// input  : { runDir, runId, rootLogger?, level? }
// output : { logger, closeStream }
//          closeStream: Promise<void> — call on run-terminal to flush.
export async function createRunLogger({
    runDir,
    runId,
    rootLogger = null,
    level = 'debug',
} = {}) {
    if (!runDir) throw new TypeError('createRunLogger: runDir is required');
    if (!runId) throw new TypeError('createRunLogger: runId is required');
    await ensureRunDir(runDir);
    const logPath = join(runDir, 'run.log');
    const fileStream = createWriteStream(logPath, { flags: 'a', mode: RUN_LOG_MODE });

    // Tee: child of the root (keeps redactors) + a separate pino instance
    // piped to the file. We return a thin wrapper that forwards every call
    // to both.
    const fileLogger = pino({ level, base: { runId } }, fileStream);
    const child = rootLogger ? rootLogger.child({ runId }) : null;

    function tee(levelName) {
        return (...args) => {
            fileLogger[levelName](...args);
            child?.[levelName]?.(...args);
        };
    }

    const logger = {
        level,
        trace: tee('trace'),
        debug: tee('debug'),
        info: tee('info'),
        warn: tee('warn'),
        error: tee('error'),
        fatal: tee('fatal'),
    };

    async function closeStream() {
        await new Promise((resolve) => {
            fileStream.end(() => resolve());
        });
    }

    return { logger, closeStream, logPath };
}

// writeErrorArtifact: dumps the full run state snapshot to `error.json`.
// Stays best-effort — never throws, so a failing artifact dump can't mask
// a real run failure.
export async function writeErrorArtifact(runDir, state) {
    try {
        await ensureRunDir(runDir);
        await writeFile(
            join(runDir, 'error.json'),
            JSON.stringify({ capturedAt: new Date().toISOString(), state }, null, 2),
            'utf8',
        );
    } catch {
        /* swallow */
    }
}

// writeSummaryArtifact: dumps a compact end-of-run summary to `summary.json`.
// Used for successful runs — makes `runs/<id>/` a drop-in "what happened"
// export without requiring the full state.json.
export async function writeSummaryArtifact(runDir, summary) {
    try {
        await ensureRunDir(runDir);
        await writeFile(
            join(runDir, 'summary.json'),
            JSON.stringify(summary, null, 2),
            'utf8',
        );
    } catch {
        /* swallow */
    }
}
