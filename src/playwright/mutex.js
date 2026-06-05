// Minimal FIFO mutex. One shared JobRight account → every Playwright
// operation must serialise. p-queue would work but pulls in 20KB of deps
// for a 10-line primitive; we just hand-roll it.
//
// Usage:
//   const mutex = createMutex();
//   await mutex.run(async () => { ... critical section ... });
// Concurrent callers are queued in call order; exceptions from one caller
// never swallow another caller's execution.

// createMutex: returns `{ run, size }`.
//   run(fn)  resolves with fn()'s value (or rejects with its error) once
//            any earlier-queued fn settles.
//   size     number of queued calls still waiting (0 if idle / running).
export function createMutex() {
    let tail = Promise.resolve();
    let waiting = 0;

    // run(fn, opts?) — opts.timeoutMs (>0) makes the CALLER's promise reject
    // if fn hasn't settled in time, so a wedged navigation surfaces a clean
    // error to the HTTP handler instead of hanging it. The queue ordering is
    // unchanged: the next waiter still chains off `attempt` (the real fn), so
    // we never run two ops against the single Chromium context concurrently.
    // Playwright's own per-action timeouts bound how long the queue can stay
    // blocked behind a slow op; this guard just unblocks the caller.
    function run(fn, { timeoutMs = 0, label = '' } = {}) {
        waiting += 1;
        const attempt = tail.then(
            () => fn(),
            // Predecessor failed — still run this one so a crash doesn't
            // deadlock the queue.
            () => fn(),
        );
        // Swallow the chain's rejection for the NEXT waiter (not for the
        // caller — they still see their own rejection).
        tail = attempt.catch(() => {});
        // Decrement the counter on settle. Tie to `tail` so we don't
        // attach a new observer to the raw rejecting promise (which would
        // count as an unhandled rejection until the caller awaits it).
        tail.finally(() => {
            waiting -= 1;
        });
        if (timeoutMs > 0) {
            let timer;
            const guard = new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`mutex op timeout after ${timeoutMs}ms${label ? `: ${label}` : ''}`)),
                    timeoutMs,
                );
            });
            return Promise.race([
                attempt.finally(() => clearTimeout(timer)),
                guard,
            ]);
        }
        return attempt;
    }

    return {
        run,
        get size() {
            return waiting;
        },
    };
}
