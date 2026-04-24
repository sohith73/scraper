// Unit tests for the env loader. No external services touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../../src/config/env.js';

test('loadEnv: applies defaults when raw env is empty', () => {
    const cfg = loadEnv({});
    assert.equal(cfg.PORT, 8092);
    assert.equal(cfg.NODE_ENV, 'development');
    assert.equal(cfg.LOG_LEVEL, 'info');
    assert.equal(cfg.HEADLESS, true);
    assert.equal(cfg.STEALTH, false);
    assert.equal(cfg.DRY_RUN, false);
    assert.equal(cfg.DASHBOARD_BASE, 'http://localhost:8086');
    assert.equal(cfg.RESUME_BASE, 'http://localhost:8001');
    assert.equal(cfg.OPENAI_MODEL, 'gpt-4o-mini');
    assert.equal(cfg.JOBRIGHT_BASE, 'https://jobright.ai');
    assert.equal(cfg.JOBRIGHT_COOLDOWN_MS, 900_000);
});

test('loadEnv: coerces boolean-ish values', () => {
    const cfg = loadEnv({ HEADLESS: 'false', STEALTH: '1', DRY_RUN: 'yes' });
    assert.equal(cfg.HEADLESS, false);
    assert.equal(cfg.STEALTH, true);
    assert.equal(cfg.DRY_RUN, true);
});

test('loadEnv: rejects garbage boolean values with a clear message', () => {
    assert.throws(
        () => loadEnv({ HEADLESS: 'maybe' }),
        (err) => {
            assert.equal(err.code, 'ENV_VALIDATION_FAILED');
            assert.match(err.message, /HEADLESS/);
            assert.match(err.message, /1\/0\/true\/false/);
            return true;
        },
    );
});

test('loadEnv: rejects non-integer PORT', () => {
    assert.throws(
        () => loadEnv({ PORT: 'eighty-ninety-two' }),
        (err) => {
            assert.equal(err.code, 'ENV_VALIDATION_FAILED');
            assert.match(err.message, /PORT/);
            return true;
        },
    );
});

test('loadEnv: rejects out-of-range PORT', () => {
    assert.throws(
        () => loadEnv({ PORT: '70000' }),
        (err) => {
            assert.match(err.message, /PORT.*<= 65535/);
            return true;
        },
    );
});

test('loadEnv: rejects invalid URL for DASHBOARD_BASE', () => {
    assert.throws(
        () => loadEnv({ DASHBOARD_BASE: 'not a url' }),
        (err) => {
            assert.match(err.message, /DASHBOARD_BASE/);
            assert.match(err.message, /valid URL/);
            return true;
        },
    );
});

test('loadEnv: NODE_ENV is restricted to dev|prod|test', () => {
    assert.throws(() => loadEnv({ NODE_ENV: 'staging' }));
    const cfg = loadEnv({ NODE_ENV: 'production' });
    assert.equal(cfg.NODE_ENV, 'production');
});

test('loadEnv: result is frozen (tamper-proof)', () => {
    const cfg = loadEnv({});
    assert.throws(() => {
        cfg.PORT = 9999;
    }, /read only|Cannot assign/i);
});
