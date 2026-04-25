// summarizeProfile: the Phase 5 entry point. Turns a ProfileModel (+ optional
// resume) into a full SearchIntent that downstream phases use to drive
// JobRight search and relevance filtering.
//
// Pipeline:
//   1. Build user prompt (deterministic — identical profile = identical key).
//   2. Ask gpt-4o-mini for AiIntent using json_schema strict mode.
//   3. Validate with the zod schema for belt-and-suspenders safety.
//   4. Fuse with authoritative exclusions from the dashboard so the AI has
//      no say over what's blocked.
//
// Cost : one cached call per (profile + resume + model) tuple. The underlying
//        openaiClient already hashes the prompt to key the disk cache.
//
// Input  : { ai, profile, resume?, exclusions?, clientEmail? }
// Output : Result<{ intent:SearchIntent, cacheHit:boolean, key:string }>

import { ok, err } from '../../clients/common/result.js';
import {
    AiIntent,
    SearchIntent,
    AI_INTENT_JSON_SCHEMA,
} from './schema.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';

// normaliseExclusionSet: lowercase + trim + dedupe — match the convention
// `getExclusions` returns so downstream comparisons are symmetric.
function normaliseExclusionSet(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    for (const item of list) {
        if (typeof item !== 'string') continue;
        const v = item.trim().toLowerCase();
        if (v) seen.add(v);
    }
    return [...seen];
}

export async function summarizeProfile({
    ai,
    profile,
    resume = null,
    exclusions = { companies: [], locations: [] },
    clientEmail = '',
} = {}) {
    if (!ai || typeof ai.completeJson !== 'function') {
        return err('BAD_INPUT', 'ai.completeJson is required');
    }
    if (!profile || typeof profile !== 'object') {
        return err('BAD_INPUT', 'profile is required');
    }

    const user = buildUserPrompt({ profile, resume, clientEmail });
    const aiRes = await ai.completeJson({
        system: SYSTEM_PROMPT,
        user,
        schema: AI_INTENT_JSON_SCHEMA,
        schemaName: 'AiIntent',
        zodSchema: AiIntent,
    });
    if (!aiRes.ok) return aiRes;

    const aiValue = aiRes.value.value;
    // Defensive: if the model omits aboutCandidate despite the schema, fall
    // back to the narrative so downstream never sees an empty framing.
    const aboutCandidate =
        typeof aiValue.aboutCandidate === 'string' && aiValue.aboutCandidate.trim()
            ? aiValue.aboutCandidate.trim()
            : (typeof aiValue.narrative === 'string' ? aiValue.narrative.trim() : '');
    const fused = {
        ...aiValue,
        aboutCandidate,
        exclusions: {
            companies: normaliseExclusionSet(exclusions.companies),
            locations: normaliseExclusionSet(exclusions.locations),
        },
    };

    // Double-validate the fused object so nothing surprises Phase 9.
    const finalParse = SearchIntent.safeParse(fused);
    if (!finalParse.success) {
        return err('BAD_SHAPE', 'fused SearchIntent failed validation', {
            cause: finalParse.error,
        });
    }

    return ok({
        intent: finalParse.data,
        cacheHit: aiRes.value.cacheHit,
        key: aiRes.value.key,
        usage: aiRes.value.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
}
