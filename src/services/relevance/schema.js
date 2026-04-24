// Relevance filter schemas.
//
// Decision: one model output per job. The model only sees a compact form
// of the job (see prompts.js → compactJobForPrompt) — never the full
// description — so the prompt stays small and batches of 20 fit well
// within gpt-4o-mini's context.

import { z } from 'zod';

export const DecisionSchema = z.object({
    id: z.string().min(1),
    pick: z.boolean(),
    score: z.number().int().min(0).max(100),
    reason: z.string(),
});

export const BatchDecisionsSchema = z.object({
    decisions: z.array(DecisionSchema),
});

// JSON Schema mirror for OpenAI Structured Outputs (strict mode).
// Must stay in sync with BatchDecisionsSchema — tests enforce it.
export const BATCH_DECISIONS_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['decisions'],
    properties: {
        decisions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'pick', 'score', 'reason'],
                properties: {
                    id: { type: 'string' },
                    pick: { type: 'boolean' },
                    score: { type: 'integer', minimum: 0, maximum: 100 },
                    reason: { type: 'string' },
                },
            },
        },
    },
};
