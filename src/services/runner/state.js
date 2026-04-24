// Run-state shape + legal phase transitions.
//
// Phases are a linear sequence, with two terminal states (done / failed)
// plus a lateral exit (aborted). Centralising this makes misuse loud —
// you can't accidentally update `phase: 'banana'` and discover months later
// that the UI renders "banana" as a label.

export const PHASES = Object.freeze({
    QUEUED: 'queued',
    LOADING_PROFILE: 'loading-profile',
    LOADING_EXCLUSIONS: 'loading-exclusions',
    LOADING_RESUME: 'loading-resume',
    SUMMARISING: 'summarising',
    SEARCHING: 'searching',
    FILTERING: 'filtering',
    ENRICHING: 'enriching',
    PREFLIGHT: 'preflight',
    PUSHING: 'pushing',
    // Non-terminal: pipeline has exhausted the current filter combo before
    // hitting the requested count. Waits for operator to pick a filter to
    // relax (or decline), then resumes with mutated intent.
    AWAITING_RELAXATION: 'awaiting-relaxation',
    DONE: 'done',
    FAILED: 'failed',
    ABORTED: 'aborted',
});

// isTerminal: run has reached an end state; no more transitions allowed.
export function isTerminal(phase) {
    return (
        phase === PHASES.DONE ||
        phase === PHASES.FAILED ||
        phase === PHASES.ABORTED
    );
}

// emptyProgress: the progress fields each phase fills. Kept as a factory
// so callers get a fresh object (no shared-reference bugs).
export function emptyProgress() {
    return {
        intent: null,
        searched: null,
        filtered: null,
        enriched: null,
        preflight: null,
        pushed: null,
    };
}

// makeInitialState: the shape a newly-created run has. runStore assigns
// the id + timestamps; everything else is the business input.
// input  : { id, clientEmail, clientName?, requestedCount }
// output : Run state object
export function makeInitialState({
    id,
    clientEmail,
    clientName = '',
    requestedCount,
}) {
    const now = new Date().toISOString();
    return {
        id,
        createdAt: now,
        updatedAt: now,
        phase: PHASES.QUEUED,
        clientEmail,
        clientName,
        requestedCount,
        abortRequested: false,
        progress: emptyProgress(),
        picks: [],
        error: null,
        durationMs: 0,
        eventSeq: 0,
    };
}
