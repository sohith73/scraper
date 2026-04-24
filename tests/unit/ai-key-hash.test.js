import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPromptKey } from '../../src/ai/keyHash.js';

test('same inputs → same hash (deterministic)', () => {
    const a = hashPromptKey({ model: 'gpt-4o-mini', system: 's', user: 'u' });
    const b = hashPromptKey({ model: 'gpt-4o-mini', system: 's', user: 'u' });
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
});

test('different model → different hash (model upgrade invalidates)', () => {
    const a = hashPromptKey({ model: 'gpt-4o-mini', system: 's', user: 'u' });
    const b = hashPromptKey({ model: 'gpt-4o', system: 's', user: 'u' });
    assert.notEqual(a, b);
});

test('different schemaName → different hash', () => {
    const a = hashPromptKey({ model: 'gpt-4o-mini', system: 's', user: 'u', schemaName: 'A' });
    const b = hashPromptKey({ model: 'gpt-4o-mini', system: 's', user: 'u', schemaName: 'B' });
    assert.notEqual(a, b);
});

test('no collision via boundary forgery (unit-separator protection)', () => {
    // If we concatenated without the unit separator, these would collide.
    const a = hashPromptKey({ model: 'gpt-4o-mini', system: 'foo', user: 'bar' });
    const b = hashPromptKey({ model: 'gpt-4o-mini', system: 'foobar', user: '' });
    assert.notEqual(a, b);
});

test('rejects non-string inputs', () => {
    assert.throws(() => hashPromptKey({ model: '', system: 's', user: 'u' }), /model/);
    assert.throws(() => hashPromptKey({ model: 'x', system: 42, user: 'u' }), /system/);
    assert.throws(() => hashPromptKey({ model: 'x', system: 's', user: null }), /user/);
});
