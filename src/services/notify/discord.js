// Discord webhook sender.
//
// Fire-and-forget by contract: never throws, never blocks the caller's
// control flow. Treat ops alerts as best-effort — they inform the team,
// but the pipeline must still succeed when Discord is unreachable.
//
// Why split from the business modules:
//   - URL is a capability token (anyone can post to the channel); contain
//     it in one place so a mistaken log-redact rule can cover everything.
//   - Rate-limit handling (429 with Retry-After) in one spot.
//   - Tests inject a `fetchImpl` to capture payloads without network I/O.
//
// Discord embed colours (decimal-encoded hex) used below:
//   0x3FB950  ≈  4176720   success  (green)
//   0xF85149  ≈ 16265545   failure  (red)
//   0xD29922  ≈ 13801250   warning  (amber)
//   0x2F81F7  ≈  3112951   info     (blue)

const DEFAULT_TIMEOUT_MS = 5000;

const COLORS = Object.freeze({
    success: 0x3FB950,
    failure: 0xF85149,
    warning: 0xD29922,
    info: 0x2F81F7,
});

// truncate: Discord enforces 2048-char embed description + 256-char title.
// We cap lower so long titles don't eat the whole embed.
function truncate(v, cap) {
    if (typeof v !== 'string') return '';
    if (v.length <= cap) return v;
    return `${v.slice(0, cap - 1)}…`;
}

// createDiscordNotifier: factory.
// input  : { webhookUrl, logger?, fetchImpl?, timeoutMs? }
// output : { send({title, description, color, fields, username}), enabled }
export function createDiscordNotifier({
    webhookUrl = '',
    logger = null,
    fetchImpl = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const fetchFn = fetchImpl || globalThis.fetch;
    const url = typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
    const enabled = url.length > 0 && !!fetchFn;

    async function send({
        title = '',
        description = '',
        color = COLORS.info,
        fields = [],
        username = 'JobRight Scraper',
    } = {}) {
        if (!enabled) return { sent: false, reason: 'disabled' };
        const body = {
            username,
            embeds: [
                {
                    title: truncate(title, 200),
                    description: truncate(description, 1800),
                    color,
                    timestamp: new Date().toISOString(),
                    fields: (Array.isArray(fields) ? fields : []).slice(0, 25).map((f) => ({
                        name: truncate(f.name || '', 200),
                        value: truncate(f.value ?? '—', 900),
                        inline: !!f.inline,
                    })),
                },
            ],
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetchFn(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (res.status === 204 || res.ok) {
                return { sent: true, status: res.status };
            }
            // 429 = rate-limited. Read the retry hint but don't retry —
            // alerts are non-critical; let the next event fire fresh.
            if (res.status === 429) {
                logger?.warn?.({ status: 429 }, 'discord: rate-limited');
                return { sent: false, reason: 'rate-limited' };
            }
            const text = await res.text().catch(() => '');
            logger?.warn?.(
                { status: res.status, body: text.slice(0, 300) },
                'discord: webhook rejected',
            );
            return { sent: false, reason: `status-${res.status}` };
        } catch (e) {
            logger?.warn?.({ err: e.message }, 'discord: webhook transport error');
            return { sent: false, reason: 'error' };
        } finally {
            clearTimeout(timer);
        }
    }

    return { send, enabled, COLORS };
}

export const DISCORD_COLORS = COLORS;
