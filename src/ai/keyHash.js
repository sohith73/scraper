// Pure cache-key derivation for AI calls.
//
// Why : we want "same prompt twice in a row" to hit $0. The cache key must
//       include the model and the schema name so (a) upgrading the model
//       invalidates the cache automatically and (b) two prompts that look
//       identical but use different json-schemas don't collide.
// Input  : { model, system, user, schemaName? }
// Output : 64-char lowercase hex sha256

import { createHash } from 'node:crypto';

export function hashPromptKey({ model, system, user, schemaName = '' }) {
    if (typeof model !== 'string' || model.length === 0) {
        throw new TypeError('hashPromptKey: model must be a non-empty string');
    }
    if (typeof system !== 'string') {
        throw new TypeError('hashPromptKey: system must be a string');
    }
    if (typeof user !== 'string') {
        throw new TypeError('hashPromptKey: user must be a string');
    }
    const hash = createHash('sha256');
    // Delimit parts with \x1f (ASCII Unit Separator) so no user content can
    // forge a boundary and collide with a different logical key.
    hash.update(model);
    hash.update('\x1f');
    hash.update(schemaName);
    hash.update('\x1f');
    hash.update(system);
    hash.update('\x1f');
    hash.update(user);
    return hash.digest('hex');
}
