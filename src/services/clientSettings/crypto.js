// Per-client JR credential encryption.
//
// Why : we store each client's JR password so the scraper can log in as
//       that client and pull JR's own personalised recommendations
//       (instead of fighting the shared-account filter manipulation).
//       Plain-text in Mongo is unacceptable — anyone with a Mongo dump
//       gets every JR password. AES-256-GCM with an env-supplied key
//       gives confidentiality + integrity. Rotating the key requires
//       re-encrypting every doc; we'll handle that via a one-shot
//       script when needed.
//
// Format on disk (base64-encoded JSON):
//   { v: 1, iv: <12-byte b64>, tag: <16-byte b64>, ct: <ciphertext b64> }
//
// Env: JR_CRED_KEY — 32 random bytes, base64 OR hex (auto-detected).
// Generate: `openssl rand -base64 32`

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;       // 96-bit nonce per NIST recommendation
const KEY_LEN = 32;      // 256-bit
const VERSION = 1;

// loadKey: decode the env value as base64 first, then hex if it looks hex,
// then UTF-8 if it's exactly 32 bytes long. Throws on any other length so
// misconfiguration fails loud at boot.
function loadKey(rawEnvValue) {
    if (!rawEnvValue || typeof rawEnvValue !== 'string') {
        throw new Error('JR_CRED_KEY env var is required for client-credential encryption (32 random bytes, base64 or hex)');
    }
    const trimmed = rawEnvValue.trim();
    let buf;
    // Try base64 first (most common for openssl rand -base64 32).
    try {
        const decoded = Buffer.from(trimmed, 'base64');
        if (decoded.length === KEY_LEN) buf = decoded;
    } catch { /* fall through */ }
    // Hex (openssl rand -hex 32 → 64 chars).
    if (!buf && /^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_LEN * 2) {
        buf = Buffer.from(trimmed, 'hex');
    }
    // Raw 32-byte UTF-8 (rare; tolerated for ad-hoc dev).
    if (!buf && Buffer.byteLength(trimmed, 'utf8') === KEY_LEN) {
        buf = Buffer.from(trimmed, 'utf8');
    }
    if (!buf || buf.length !== KEY_LEN) {
        throw new Error(`JR_CRED_KEY must decode to exactly ${KEY_LEN} bytes (got ${buf ? buf.length : 'invalid'})`);
    }
    return buf;
}

// createCredCrypto: factory taking the raw env key. Returns
// `{ encrypt, decrypt, ready }`. `ready === false` when no key is configured
// — callers should refuse to save creds in that mode rather than fall back
// to plaintext.
export function createCredCrypto(envKey) {
    if (!envKey) {
        return {
            ready: false,
            encrypt: () => { throw new Error('JR_CRED_KEY not configured — cannot store creds'); },
            decrypt: () => { throw new Error('JR_CRED_KEY not configured — cannot read creds'); },
        };
    }
    const key = loadKey(envKey);

    function encrypt(plaintext) {
        if (typeof plaintext !== 'string' || plaintext.length === 0) {
            throw new Error('encrypt: plaintext must be a non-empty string');
        }
        const iv = randomBytes(IV_LEN);
        const cipher = createCipheriv(ALGO, key, iv);
        const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        const blob = JSON.stringify({
            v: VERSION,
            iv: iv.toString('base64'),
            tag: tag.toString('base64'),
            ct: ct.toString('base64'),
        });
        return Buffer.from(blob, 'utf8').toString('base64');
    }

    function decrypt(envelope) {
        if (typeof envelope !== 'string' || envelope.length === 0) {
            throw new Error('decrypt: envelope must be a non-empty string');
        }
        let blob;
        try {
            blob = JSON.parse(Buffer.from(envelope, 'base64').toString('utf8'));
        } catch {
            throw new Error('decrypt: malformed envelope — not base64-JSON');
        }
        if (blob.v !== VERSION) {
            throw new Error(`decrypt: unsupported version ${blob.v}`);
        }
        const iv = Buffer.from(blob.iv, 'base64');
        const tag = Buffer.from(blob.tag, 'base64');
        const ct = Buffer.from(blob.ct, 'base64');
        if (iv.length !== IV_LEN || tag.length !== 16) {
            throw new Error('decrypt: bad iv/tag length');
        }
        const decipher = createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return pt.toString('utf8');
    }

    return { ready: true, encrypt, decrypt };
}
