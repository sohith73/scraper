// JobRight role-taxonomy catalog.
//
// Why : JR's `/swan/filter/update/filter` endpoint REQUIRES a non-empty
//       `jobTaxonomyList` of `{taxonomyId, title}` entries and uses it as
//       the primary role signal. Our free-text `jobTitle` is advisory.
//       If we don't supply matching taxonomy IDs, JR either rejects (400)
//       or returns whatever role the stale taxonomy IDs point to (the
//       original bug that caused all-skipped results).
//
// The catalog lives at `GET /swan/filter/support/titles` — a 3-level tree
// of `{id, display_name, taxonomy_name, [second_category|third_category]}`.
// We flatten to the leaves (third_category rows) and lookup by a fuzzy
// title match of intent.roles[].
//
// Cache: in-memory per process. The catalog is static for JR's lifetime;
// no need to refetch on every run.

import { pageFetch } from '../../playwright/pageFetch.js';

const CATALOG_PATH = '/swan/filter/support/titles';

let cachedEntries = null;      // [{ id, title }]
let lastFetchedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h, defensive

// flattenLeaves: pull every third-level { id, title } from JR's tree.
// input  : top-level tree from JR
// output : Array<{id, title, displayName}>
function flattenLeaves(tree) {
    const out = [];
    const walk = (nodes, level) => {
        if (!Array.isArray(nodes)) return;
        for (const n of nodes) {
            if (level === 3) {
                if (n?.id && (n.taxonomy_name || n.display_name)) {
                    out.push({
                        id: String(n.id),
                        title: String(n.taxonomy_name || n.display_name),
                        displayName: String(n.display_name || n.taxonomy_name),
                    });
                }
                continue;
            }
            walk(n.second_category || n.third_category, level + 1);
        }
    };
    walk(tree, 1);
    return out;
}

// fetchCatalog: fetch + parse + cache. Uses a Playwright `page` so we ride
// the logged-in cookie jar + avoid re-implementing JR's auth.
// input  : { page, env, force? }
// output : Array<{id, title, displayName}> (cached on success)
export async function fetchCatalog({ page, env, force = false } = {}) {
    const now = Date.now();
    if (!force && cachedEntries && now - lastFetchedAt < CACHE_TTL_MS) {
        return cachedEntries;
    }
    const base = env.JOBRIGHT_BASE.replace(/\/+$/, '');
    const r = await pageFetch(page, { url: `${base}${CATALOG_PATH}` });
    if (r.status !== 200 || !r.body?.success) {
        // On failure, fall back to whatever we had in cache. If nothing, []
        // — caller decides whether to proceed or error.
        return cachedEntries || [];
    }
    cachedEntries = flattenLeaves(r.body.result);
    lastFetchedAt = now;
    return cachedEntries;
}

// resetCache: test hook. Never called in production.
export function _resetCache() {
    cachedEntries = null;
    lastFetchedAt = 0;
}

// normalise: lowercase + strip punctuation for fuzzy compare.
function normalise(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// resolveRoles: for each input role string, find the best taxonomy match.
// Returns one { taxonomyId, title } per role (skipping unmatched ones).
// Matching strategy, in priority order:
//   1. exact normalised title equality
//   2. catalog title contains the role (or vice versa)
//   3. token overlap of ≥ 2 tokens
// input  : { catalog, roles }
// output : { resolved: [{taxonomyId, title}], unresolved: [role] }
export function resolveRoles({ catalog, roles } = {}) {
    if (!Array.isArray(catalog) || catalog.length === 0) {
        return { resolved: [], unresolved: Array.isArray(roles) ? [...roles] : [] };
    }
    const resolved = [];
    const seenIds = new Set();
    const unresolved = [];
    for (const raw of Array.isArray(roles) ? roles : []) {
        const role = normalise(raw);
        if (!role) continue;
        let match = null;
        // Pass 1: exact match.
        for (const c of catalog) {
            if (normalise(c.title) === role) { match = c; break; }
        }
        // Pass 2: substring.
        if (!match) {
            for (const c of catalog) {
                const ct = normalise(c.title);
                if (ct.includes(role) || role.includes(ct)) { match = c; break; }
            }
        }
        // Pass 3: acronym / abbreviation expansion. Many candidate profiles
        // use "ML Engineer" or "AI Engineer" short-hand — map to the
        // verbose canonical JR titles.
        if (!match) {
            const EXPANSIONS = {
                ml: 'machine learning',
                ai: 'artificial intelligence',
                sre: 'site reliability',
                qa: 'quality assurance',
                ux: 'ui ux',
            };
            const expanded = role
                .split(' ')
                .map((tok) => EXPANSIONS[tok] || tok)
                .join(' ');
            if (expanded !== role) {
                for (const c of catalog) {
                    const ct = normalise(c.title);
                    if (ct.includes(expanded) || expanded.includes(ct)) {
                        match = c; break;
                    }
                }
            }
        }
        // Pass 4: token overlap.
        if (!match) {
            const tokens = new Set(role.split(' ').filter((t) => t.length >= 2));
            let best = null;
            let bestScore = 0;
            for (const c of catalog) {
                const ctTokens = new Set(normalise(c.title).split(' ').filter((t) => t.length >= 2));
                let overlap = 0;
                for (const t of tokens) if (ctTokens.has(t)) overlap += 1;
                if (overlap >= 2 && overlap > bestScore) {
                    bestScore = overlap;
                    best = c;
                }
            }
            match = best;
        }
        if (match) {
            if (!seenIds.has(match.id)) {
                seenIds.add(match.id);
                resolved.push({ taxonomyId: match.id, title: match.title });
            }
        } else {
            unresolved.push(raw);
        }
    }
    return { resolved, unresolved };
}
