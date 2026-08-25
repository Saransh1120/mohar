import canonicalize from "canonicalize";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

/**
 * Canonical byte form for anything we sign.
 *
 * We use RFC 8785 (JSON Canonicalization Scheme) rather than `JSON.stringify`
 * because stringify preserves *insertion* order. A body that round-trips through
 * Postgres `jsonb`, a message queue, or a client-side clone can come back with
 * its keys reordered — same object, different bytes, and every signature over it
 * silently stops verifying. JCS sorts keys by UTF-16 code unit and pins number
 * formatting, so the bytes are a function of the value alone.
 */
export function canonicalBytes(value: unknown): Uint8Array {
  const s = canonicalize(value);
  if (s === undefined) {
    // canonicalize returns undefined for `undefined` and for functions/symbols.
    throw new CanonicalisationError("value is not representable as canonical JSON");
  }
  return utf8ToBytes(s);
}

export function canonicalString(value: unknown): string {
  const s = canonicalize(value);
  if (s === undefined) {
    throw new CanonicalisationError("value is not representable as canonical JSON");
  }
  return s;
}

export class CanonicalisationError extends Error {
  override readonly name = "CanonicalisationError";
}

/**
 * Reject values that canonicalise ambiguously *before* they are signed.
 *
 * JCS has no representation for `undefined`, and `null` is a distinct value from
 * an absent key — `{"a":null}` and `{}` are different byte strings. Our contract
 * is that optional fields are omitted, so a `null` anywhere in a signed body is
 * almost always a client that filled in a blank and is about to produce a
 * signature nobody can verify. Fail loudly at the boundary instead.
 */
export function assertNoNulls(value: unknown, path = "$"): void {
  if (value === null) {
    throw new CanonicalisationError(
      `null at ${path}: omit optional fields instead of setting them to null`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNulls(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertNoNulls(v, `${path}.${k}`);
    }
  }
}

/** SHA-256 over the canonical form. This is the value a device signature covers. */
export function bodyHash(body: unknown): Uint8Array {
  assertNoNulls(body);
  return sha256(canonicalBytes(body));
}

export function bodyHashHex(body: unknown): string {
  return bytesToHex(bodyHash(body));
}
