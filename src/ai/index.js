// Barrel — construct the AI client + cache once at boot, thread through
// services (profileSummariser, relevance filter) via DI.
//
// Example:
//   const cache = createAiCache({ dir: env.AI_CACHE_DIR });
//   const ai = createOpenAIClient({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL, cache, logger });
//   const r = await ai.completeJson({ system, user, zodSchema: Intent });

export { createAiCache } from './cache.js';
export { createOpenAIClient } from './openaiClient.js';
export { hashPromptKey } from './keyHash.js';
