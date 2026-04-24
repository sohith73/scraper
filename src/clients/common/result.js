// Discriminated-union Result<T, E> helpers.
// Using a tagged object lets callers `if (r.ok)` and avoids the
// exception-vs-return ambiguity of domain errors. Transport-level errors
// (network, parse) and domain-level errors (BLOCKED_COMPANY) both live in
// the same `error` channel so callers handle one shape.

// ok: wraps a success value.
// input  : T
// output : { ok:true, value:T }
export function ok(value) {
    return { ok: true, value };
}

// err: wraps a domain/transport failure.
// input  : string code, string message, optional extras ({status, cause, bodyJson})
// output : { ok:false, error:{code,message,...extras} }
export function err(code, message, extras = {}) {
    return { ok: false, error: { code, message, ...extras } };
}

// isOk / isErr: narrow discriminators for assertion-light callsites.
export const isOk = (r) => r && r.ok === true;
export const isErr = (r) => r && r.ok === false;
