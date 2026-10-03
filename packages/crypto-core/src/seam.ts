import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";

/**
 * ── The seam seal ────────────────────────────────────────────────────────────
 *
 * `seal.ts` protects the paper's contents. This module protects the claim that
 * the envelope was never opened on the way, and it works by inversion: tamper is
 * proved not by a scanner reporting damage, but by the station being **unable to
 * produce a secret it could only have read from an intact seal**.
 *
 * A random 32-byte token is generated at sealing and printed, as a QR code,
 * across the package's opening flap. The ledger never sees the token at sealing
 * time — only `sha256(token ‖ packageId)`. Opening the flap tears the code
 * through its finder patterns, which carry no error correction, so the symbol
 * cannot be localised at all and no token can be read. At the ceremony the
 * station submits whatever it read; the engine recomputes the digest and
 * compares. See `docs/13` for the label geometry this depends on.
 *
 * ── Why the package id is bound in ──
 *
 * The same reason it is associated data in `seal.ts`. A commitment over the
 * token alone is portable: a token lifted from one package would satisfy the
 * check on another. Binding the id makes each commitment answerable by exactly
 * one package's seal.
 *
 * ── What this does not do ──
 *
 * The token is static data, and static data can be copied. Someone who
 * photographs the seam code before opening the package can reprint it on fresh
 * destructible stock and reseal. This module does not defend against that, and
 * nothing in the physical layer can — see `docs/13 §9`. It is one input among
 * twenty-two, and the two-person ceremony, the custody window and the committed
 * photograph are the checks that stand where this one falls.
 */

/** Length of the seam token in bytes. Sized to sit at a QR version 2 / ECC L
 *  payload of exactly 32 bytes, which is 100% capacity — see `docs/13 §1`. */
export const SEAM_TOKEN_BYTES = 32;

/** Hex length of a seam token, for boundary validation. */
export const SEAM_TOKEN_HEX_LENGTH = SEAM_TOKEN_BYTES * 2;

const SEAM_TOKEN_HEX = /^[0-9a-f]{64}$/;

export class SeamTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeamTokenError";
  }
}

/**
 * A fresh seam token. Generated where the package is sealed and never stored by
 * the ledger — only its commitment is. The plaintext token exists in exactly two
 * places: the label, and whatever renders the label.
 */
export function generateSeamToken(): Uint8Array {
  return randomBytes(SEAM_TOKEN_BYTES);
}

/**
 * `sha256(token ‖ packageId)`, hex.
 *
 * The token is concatenated as raw bytes and the package id as UTF-8, in that
 * order. Both are fixed-purpose and only one is variable-length, so no length
 * prefix is needed to keep the encoding unambiguous.
 */
export function seamCommitment(token: Uint8Array, packageId: string): string {
  if (token.length !== SEAM_TOKEN_BYTES) {
    throw new SeamTokenError(
      `seam token must be ${SEAM_TOKEN_BYTES} bytes, got ${token.length}`,
    );
  }
  if (packageId.length === 0) {
    throw new SeamTokenError("package id is required to bind the commitment");
  }

  const id = new TextEncoder().encode(packageId);
  const preimage = new Uint8Array(token.length + id.length);
  preimage.set(token, 0);
  preimage.set(id, token.length);
  return bytesToHex(sha256(preimage));
}

/** The same commitment from a hex token, as it arrives over HTTP. */
export function seamCommitmentFromHex(tokenHex: string, packageId: string): string {
  if (!SEAM_TOKEN_HEX.test(tokenHex)) {
    throw new SeamTokenError(
      `seam token must be ${SEAM_TOKEN_HEX_LENGTH} lowercase hex characters`,
    );
  }
  return seamCommitment(hexToBytes(tokenHex), packageId);
}

/**
 * Whether a presented token opens a commitment.
 *
 * Compared in constant time. The margin this buys is small — an attacker who can
 * time this endpoint still has to guess 32 bytes — but a comparison that leaks
 * its prefix has no reason to exist when one that does not is three lines.
 */
export function seamTokenMatches(
  tokenHex: string,
  packageId: string,
  commitmentHex: string,
): boolean {
  let computed: string;
  try {
    computed = seamCommitmentFromHex(tokenHex, packageId);
  } catch {
    return false;
  }
  if (computed.length !== commitmentHex.length) return false;

  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ commitmentHex.charCodeAt(i);
  }
  return diff === 0;
}

/** Hex form of a token, for handing to whatever renders the label. */
export function seamTokenToHex(token: Uint8Array): string {
  return bytesToHex(token);
}
