import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";
import { bodyHash, canonicalBytes, assertNoNulls } from "./canonical.js";

/**
 * Ed25519 over the canonical body.
 *
 * Ed25519 rather than ECDSA because it is deterministic — no per-signature
 * nonce to get wrong. A field app producing signatures offline, on a cheap
 * phone, is exactly the setting where a bad RNG leaks a private key through
 * ECDSA nonce reuse. Ed25519 removes that failure mode entirely.
 *
 * We sign the canonical bytes directly rather than a pre-hash: Ed25519 already
 * hashes internally, and signing a hash we computed ourselves would let a caller
 * substitute an arbitrary 32-byte value for a real message.
 */

export interface Keypair {
  privateKeyHex: string;
  publicKeyHex: string;
}

export function generateKeypair(): Keypair {
  const priv = ed25519.utils.randomPrivateKey();
  return {
    privateKeyHex: bytesToHex(priv),
    publicKeyHex: bytesToHex(ed25519.getPublicKey(priv)),
  };
}

export function signBody(body: unknown, privateKeyHex: string): string {
  assertNoNulls(body);
  return bytesToHex(ed25519.sign(canonicalBytes(body), hexToBytes(privateKeyHex)));
}

/**
 * Verify a device signature over a body.
 *
 * Never throws on malformed input — a client sending a truncated key or a
 * garbage signature must produce a clean `false` and a logged denial, not a 500
 * that hides the attempt.
 */
export function verifyBodySignature(
  body: unknown,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    return ed25519.verify(
      hexToBytes(signatureHex),
      canonicalBytes(body),
      hexToBytes(publicKeyHex),
    );
  } catch {
    return false;
  }
}

/** Convenience for callers that already hold the body hash. */
export function bodyHashOf(body: unknown): string {
  return bytesToHex(bodyHash(body));
}

/**
 * A challenge nonce for session binding. 32 bytes from the platform CSPRNG.
 * Used by `access` so an assertion captured once cannot be replayed later.
 */
export function newNonce(): string {
  return bytesToHex(randomBytes(32));
}
