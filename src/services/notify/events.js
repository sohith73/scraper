// Event-specific formatters on top of the generic discord sender.
//
// Each helper produces a ready-to-send embed payload for one canonical
// scraper event. Keeping the formatting here means:
//   - the pipeline never constructs Discord-shaped payloads inline
//   - adding a new alert type touches one file
//   - tests can assert embed shape cheaply without mocking a notifier
//
// Every helper MUST accept a `notifier` and MUST swallow its result —
// ops alerts are best-effort and must never bubble up into pipeline code.

import { DISCORD_COLORS } from './discord.js';

function fmtMs(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function runIdShort(id) {
    return typeof id === 'string' ? id.slice(0, 8) : '—';
}

// notifyRunDone: fire when a run terminates with phase=done.
// Green embed with counts, top 3 picks, duration.
export async function notifyRunDone({ notifier, run, logger = null } = {}) {
    if (!notifier?.enabled) return;
    const pushed = run.progress?.pushed?.pushed ?? 0;
    const target = run.requestedCount ?? 0;
    const searched = run.progress?.searched?.totalNormalized ?? 0;
    const picks = Array.isArray(run.picks) ? run.picks : [];

    const fields = [
        { name: 'Client', value: run.clientEmail || '—', inline: true },
        { name: 'Pushed', value: `${pushed} / ${target}`, inline: true },
        { name: 'Duration', value: fmtMs(run.durationMs), inline: true },
        {
            name: 'Scanned on JR',
            value: `${searched} jobs · ${run.progress?.searched?.pages ?? 0} pages`,
            inline: true,
        },
        {
            name: 'AI filter',
            value: `${run.progress?.filtered?.picked ?? 0} picked · ${run.progress?.filtered?.skipped ?? 0} skipped · ${run.progress?.filtered?.borderline ?? 0} borderline`,
            inline: false,
        },
    ];

    if (picks.length > 0) {
        const preview = picks.slice(0, 3)
            .map((p, i) => `${i + 1}. **${p.title || '—'}** @ ${p.company || '—'}`)
            .join('\n');
        fields.push({ name: `Top ${Math.min(3, picks.length)} pick${picks.length === 1 ? '' : 's'}`, value: preview });
    }

    if (Array.isArray(run.progress?.appliedRelaxations) && run.progress.appliedRelaxations.length) {
        fields.push({
            name: 'Filters widened',
            value: run.progress.appliedRelaxations
                .map((a) => `${a.label}: ${a.from} → ${a.to}`)
                .join('\n'),
        });
    }

    try {
        await notifier.send({
            title: pushed > 0
                ? `✅ Scrape complete — ${pushed} job${pushed === 1 ? '' : 's'} pushed`
                : `⚠ Scrape complete — 0 jobs pushed`,
            description: `Run \`${runIdShort(run.id)}\` for **${run.clientName || run.clientEmail}**`,
            color: pushed > 0 ? DISCORD_COLORS.success : DISCORD_COLORS.warning,
            fields,
        });
    } catch (e) {
        logger?.warn?.({ err: e.message }, 'discord: notifyRunDone failed');
    }
}

// notifyRunFailed: fire when a run terminates with phase=failed.
// Red embed with error code + human message.
export async function notifyRunFailed({ notifier, run, logger = null } = {}) {
    if (!notifier?.enabled) return;
    const err = run.error || { code: 'UNKNOWN', message: 'no error detail' };
    const fields = [
        { name: 'Client', value: run.clientEmail || '—', inline: true },
        { name: 'Code', value: `\`${err.code || 'UNKNOWN'}\``, inline: true },
        { name: 'Phase at failure', value: run.phase, inline: true },
        { name: 'Message', value: err.message ? `\`\`\`${err.message}\`\`\`` : '—' },
    ];

    // Add hints the ops team can act on directly.
    if (err.code === 'RESUME_MISSING') {
        fields.push({
            name: 'Action',
            value: 'Attach a resume in gemini-resume for this client, then re-run.',
        });
    } else if (err.code === 'NEEDS_REAUTH') {
        fields.push({
            name: 'Action',
            value: 'Run `POST /api/admin/login` or `npm run first-login` to refresh the JR session.',
        });
    } else if (err.code === 'COOLDOWN') {
        fields.push({
            name: 'Action',
            value: 'JR has throttled us; wait for the cooldown to expire before retrying.',
        });
    }

    try {
        await notifier.send({
            title: `🔴 Scrape failed — ${err.code || 'UNKNOWN'}`,
            description: `Run \`${runIdShort(run.id)}\` for **${run.clientName || run.clientEmail}**`,
            color: DISCORD_COLORS.failure,
            fields,
        });
    } catch (e) {
        logger?.warn?.({ err: e.message }, 'discord: notifyRunFailed failed');
    }
}

// notifyNoJobs: fire when phase=done but JR returned 0 jobs + no picks
// pushed. The operator's filters collectively eliminated everything.
// Distinct from a "scrape complete with 0 picks" (generic warning) —
// this variant names the culprit filters.
export async function notifyNoJobs({ notifier, run, culprits = [], logger = null } = {}) {
    if (!notifier?.enabled) return;
    const intent = run.progress?.intent || {};
    const fields = [
        { name: 'Client', value: run.clientEmail || '—', inline: true },
        { name: 'Requested', value: String(run.requestedCount || 0), inline: true },
        { name: 'Roles', value: (intent.roles || []).slice(0, 4).join(', ') || '—' },
    ];
    if (culprits.length) {
        fields.push({
            name: 'Most likely culprits',
            value: culprits.slice(0, 5).map((c) => `• ${c}`).join('\n'),
        });
    }
    if (Array.isArray(run.progress?.appliedRelaxations) && run.progress.appliedRelaxations.length) {
        fields.push({
            name: 'Widened during run',
            value: run.progress.appliedRelaxations
                .map((a) => `${a.label}: ${a.from} → ${a.to}`)
                .join('\n'),
        });
    }
    try {
        await notifier.send({
            title: `⚠ No jobs found for this client`,
            description: `Run \`${runIdShort(run.id)}\` for **${run.clientName || run.clientEmail}** — the filter combination produced 0 matches on JobRight.`,
            color: DISCORD_COLORS.warning,
            fields,
        });
    } catch (e) {
        logger?.warn?.({ err: e.message }, 'discord: notifyNoJobs failed');
    }
}

// notifyCooldown: fire when the pipeline sets a cooldown (JR 429 / 403 /
// NEEDS_REAUTH). Separate from notifyRunFailed because COOLDOWN affects
// the next run too — ops team needs to know.
export async function notifyCooldown({ notifier, run, cooldown, logger = null } = {}) {
    if (!notifier?.enabled || !cooldown) return;
    try {
        await notifier.send({
            title: `🛑 Cooldown activated — ${cooldown.code || 'UNKNOWN'}`,
            description: `JR has throttled the scraper. Next run will be refused until cooldown expires.`,
            color: DISCORD_COLORS.failure,
            fields: [
                { name: 'Trigger run', value: `\`${runIdShort(run?.id)}\``, inline: true },
                { name: 'Client', value: run?.clientEmail || '—', inline: true },
                { name: 'Reason', value: cooldown.reason ? `\`\`\`${cooldown.reason}\`\`\`` : '—' },
                { name: 'Expires', value: cooldown.expiresAt || '—' },
            ],
        });
    } catch (e) {
        logger?.warn?.({ err: e.message }, 'discord: notifyCooldown failed');
    }
}

// computeCulprits: mirrors the UI's 0-jobs hint logic. Kept here so the
// Discord message stays in sync with what operators see on screen.
export function computeCulprits(intent) {
    if (!intent || typeof intent !== 'object') return [];
    const out = [];
    if (Number.isInteger(intent.daysAgo) && intent.daysAgo <= 3) {
        out.push(`Date posted = past ${intent.daysAgo}d (widen to past week+)`);
    }
    if (Array.isArray(intent.workModels) && intent.workModels.length === 1) {
        out.push(`Work model = ${intent.workModels[0]} only`);
    }
    if (Number.isInteger(intent.minYearsOfExperience) && Number.isInteger(intent.maxYearsOfExperience)) {
        const span = intent.maxYearsOfExperience - intent.minYearsOfExperience;
        if (span <= 3) out.push(`YoE = ${intent.minYearsOfExperience}–${intent.maxYearsOfExperience} (narrow band)`);
    }
    if (Number.isInteger(intent.salaryMinimumUsd) && intent.salaryMinimumUsd >= 150000) {
        out.push(`Min salary = $${intent.salaryMinimumUsd.toLocaleString()} (too high)`);
    }
    if (Array.isArray(intent.locations) && intent.locations.length > 0 && intent.locations.length <= 4) {
        out.push(`Locations limited to ${intent.locations.length} cities (add Remote or clear)`);
    }
    return out;
}
