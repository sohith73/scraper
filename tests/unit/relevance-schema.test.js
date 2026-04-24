import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DecisionSchema,
    BatchDecisionsSchema,
    BATCH_DECISIONS_JSON_SCHEMA,
} from '../../src/services/relevance/schema.js';

const VALID = { id: 'j1', pick: true, score: 85, reason: 'strong fit' };

test('DecisionSchema accepts valid decision', () => {
    assert.equal(DecisionSchema.safeParse(VALID).success, true);
});

test('rejects non-integer score', () => {
    const r = DecisionSchema.safeParse({ ...VALID, score: 85.5 });
    assert.equal(r.success, false);
});

test('rejects score < 0 or > 100', () => {
    assert.equal(DecisionSchema.safeParse({ ...VALID, score: -1 }).success, false);
    assert.equal(DecisionSchema.safeParse({ ...VALID, score: 101 }).success, false);
});

test('rejects missing fields', () => {
    const { id, ...rest } = VALID;
    assert.equal(DecisionSchema.safeParse(rest).success, false);
});

test('BatchDecisionsSchema requires decisions array', () => {
    assert.equal(BatchDecisionsSchema.safeParse({}).success, false);
    assert.equal(
        BatchDecisionsSchema.safeParse({ decisions: [VALID, VALID] }).success,
        true,
    );
});

test('BATCH_DECISIONS_JSON_SCHEMA required keys mirror zod keys', () => {
    const itemRequired = BATCH_DECISIONS_JSON_SCHEMA.properties.decisions.items.required;
    assert.deepEqual(itemRequired.slice().sort(), ['id', 'pick', 'reason', 'score']);
    assert.equal(BATCH_DECISIONS_JSON_SCHEMA.additionalProperties, false);
    assert.equal(
        BATCH_DECISIONS_JSON_SCHEMA.properties.decisions.items.additionalProperties,
        false,
    );
});
