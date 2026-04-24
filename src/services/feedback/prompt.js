// Renders a CLIENT CALIBRATION block for the relevance-filter user prompt.
//
// Contract:
//   - Output is EMPTY when no signal-dense feedback is present. Empty
//     output means the cache key stays stable — no prompt noise for
//     clients with zero operator feedback.
//   - Output is deterministic for identical input (stable ordering, no
//     timestamps) so caching remains effective between runs with the
//     same feedback set.
//
// Sections (in priority order):
//   1. REJECTED — AI picked, operator disagreed.  (DO NOT pick these)
//   2. RESCUED  — AI skipped, operator overrode.   (DO pick these)
//   3. CONFIRMED — AI and operator agreed (optional, weaker signal).

// formatEntry: one line per calibration example. Compact + informative.
function formatEntry(e) {
    const parts = [];
    if (e.title) parts.push(`"${e.title}"`);
    if (e.company) parts.push(`@ ${e.company}`);
    const head = parts.join(' ');
    const meta = [];
    if (Number.isInteger(e.aiScore)) meta.push(`AI score ${e.aiScore}`);
    if (e.aiReason) meta.push(`AI said: "${e.aiReason}"`);
    if (e.note) meta.push(`operator note: "${e.note}"`);
    const suffix = meta.length ? ` — ${meta.join('; ')}` : '';
    return `- ${head}${suffix}`;
}

// buildCalibrationBlock: the only public export. Takes the output of
// feedbackStore.selectCalibration() and turns it into a prompt fragment.
// input  : { rejected, rescued, confirmedPick, confirmedSkip }
// output : string (possibly empty)
export function buildCalibrationBlock(groups) {
    if (!groups || typeof groups !== 'object') return '';
    const { rejected = [], rescued = [], confirmedPick = [], confirmedSkip = [] } = groups;
    const hasSignal = rejected.length > 0 || rescued.length > 0
        || confirmedPick.length > 0 || confirmedSkip.length > 0;
    if (!hasSignal) return '';

    const lines = [];
    lines.push('CLIENT CALIBRATION (historical operator feedback — HIGHEST-WEIGHT SIGNAL; override the rubric when a new job matches one of these patterns):');

    if (rejected.length) {
        lines.push('');
        lines.push(`Jobs the operator REJECTED (AI picked → operator said "wrong for this candidate"). DO NOT pick jobs that resemble these by title, company, or description pattern:`);
        for (const e of rejected) lines.push(formatEntry(e));
    }

    if (rescued.length) {
        lines.push('');
        lines.push(`Jobs the operator RESCUED (AI skipped → operator said "this is exactly right"). DO pick jobs that resemble these:`);
        for (const e of rescued) lines.push(formatEntry(e));
    }

    if (confirmedPick.length || confirmedSkip.length) {
        lines.push('');
        lines.push('Confirmations (operator validated AI decisions — weaker signal, keep consistent):');
        for (const e of confirmedPick) lines.push(`${formatEntry(e)}  [confirmed PICK]`);
        for (const e of confirmedSkip) lines.push(`${formatEntry(e)}  [confirmed SKIP]`);
    }

    lines.push('');
    lines.push('How to use: if the current job is strongly similar in title family / seniority / domain to a REJECTED example, treat it as hard-skip (score ≤ 30, mention the matching example in the reason). If strongly similar to a RESCUED example, treat it as pick (score ≥ 70, cite the match).');
    return lines.join('\n');
}
