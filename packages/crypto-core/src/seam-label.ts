import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import { timingSafeEqualBytes } from "./merkle.js";

/**
 * ── The two-code seam label ──────────────────────────────────────────────────
 *
 * One destructible-vinyl label goes across the closure flap carrying two QR
 * codes. The tear line runs between and through both, clipping a finder pattern
 * on each, so opening the packet destroys both codes rather than one.
 *
 * The secret behind the label is split 2-of-2 across the codes:
 *
 *     shareA  = random 16 bytes
 *     shareB  = seamSecret XOR shareA
 *
 * XOR is enough here and Shamir would be worse: this is a 2-of-2 with no
 * threshold to choose, and the operation has to be reproducible by a phone with
 * a cracked screen in a truck yard. Either half alone is uniform noise, so a
 * photograph of one code — the failure mode of a label that is half peeled —
 * reveals nothing at all.
 *
 * ── Why the shares live in the URL fragment ──
 *
 * A browser never sends anything after `#` to the server. A curious person who
 * scans a code with an ordinary camera app therefore reaches a page that says
 * only that the package is under custody, and the share material never appears
 * in an access log, a proxy, or a referrer header on the way. The server can
 * only learn a share if an attested device deliberately sends it.
 *
 * ── Naming ──
 *
 * `seam.ts` holds the *seam token* — the single 32-byte value committed at
 * sealing time, already on the chain for live packages. This module is the
 * printed label that carries a secret in two halves. They are separate on
 * purpose: changing the meaning of a commitment that exists in production
 * records would silently invalidate every one of them.
 */

export const SEAM_ID_BYTES = 16;
export const SEAM_SECRET_BYTES = 16;

/** Domain separation. A hash of the same bytes under another label is a different value. */
const COMMITMENT_DOMAIN = "MOHAR-SEAM-v1";

// Crockford base32: no I, L, O, U — the characters people mis-read when they
// are typing the printed seam id off a torn label at four in the morning.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export type SeamCodeHalf = "A" | "B";

export interface SeamLabel {
  /** Opaque 128-bit handle, base32. Not the serial, not sequential, not derivable. */
  seamId: string;
  seamSecret: Uint8Array;
  shareA: Uint8Array;
  shareB: Uint8Array;
  /** What the sealing event records. The secret itself is never stored. */
  commitment: string;
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i]! ^ b[i]!;
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

/** Generate a label: an id, a secret, and the two halves that are printed. */
export function generateSeamLabel(): SeamLabel {
  const seamId = toBase32(randomBytes(SEAM_ID_BYTES));
  const seamSecret = randomBytes(SEAM_SECRET_BYTES);
  const shareA = randomBytes(SEAM_SECRET_BYTES);
  const shareB = xor(seamSecret, shareA);
  return {
    seamId,
    seamSecret,
    shareA,
    shareB,
    commitment: seamLabelCommitment(seamId, seamSecret),
  };
}

/** Rebuild the secret from both halves. Either half alone is noise. */
export function combineSeamShares(shareA: Uint8Array, shareB: Uint8Array): Uint8Array {
  if (shareA.length !== SEAM_SECRET_BYTES || shareB.length !== SEAM_SECRET_BYTES) {
    throw new RangeError(`each seam share must be ${SEAM_SECRET_BYTES} bytes`);
  }
  return xor(shareA, shareB);
}

/**
 * `sha256("MOHAR-SEAM-v1" ‖ seamId ‖ seamSecret)`.
 *
 * The id is inside the hash so a secret lifted from one packet cannot be
 * presented as another packet's: a commitment is only satisfied by the pair.
 */
export function seamLabelCommitment(seamId: string, seamSecret: Uint8Array): string {
  const id = utf8ToBytes(seamId.trim().toUpperCase());
  const domain = utf8ToBytes(COMMITMENT_DOMAIN);
  const buf = new Uint8Array(domain.length + id.length + seamSecret.length);
  buf.set(domain, 0);
  buf.set(id, domain.length);
  buf.set(seamSecret, domain.length + id.length);
  return bytesToHex(sha256(buf));
}

/** Constant-time check of a presented secret against a recorded commitment. */
export function seamLabelMatches(
  seamId: string,
  seamSecret: Uint8Array,
  commitmentHex: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(commitmentHex)) return false;
  return timingSafeEqualBytes(
    hexToBytes(seamLabelCommitment(seamId, seamSecret)),
    hexToBytes(commitmentHex),
  );
}

/**
 * What one QR code encodes.
 *
 * Everything that matters is after `#`, so scanning this with an ordinary
 * camera app sends the host nothing but a request for the landing page.
 */
export function encodeSeamQr(
  verifyHost: string,
  which: SeamCodeHalf,
  seamId: string,
  share: Uint8Array,
): string {
  const host = verifyHost.replace(/\/+$/, "");
  return `${host}/s#${which}.${seamId}.${toBase64Url(share)}`;
}

export interface ParsedSeamQr {
  which: SeamCodeHalf;
  seamId: string;
  share: Uint8Array;
}

/**
 * Parse a scanned code, refusing anything that is not exactly our shape.
 *
 * A label that decodes to something almost right is a label to be suspicious
 * of, so this throws rather than salvaging what it can.
 */
export function parseSeamQr(url: string): ParsedSeamQr {
  const hash = url.indexOf("#");
  if (hash < 0) throw new SeamQrFormatError("no fragment in the scanned code");

  const parts = url.slice(hash + 1).split(".");
  if (parts.length !== 3) {
    throw new SeamQrFormatError(`expected 3 fragment parts, got ${parts.length}`);
  }

  const [which, seamId, encoded] = parts as [string, string, string];
  if (which !== "A" && which !== "B") {
    throw new SeamQrFormatError(`unknown code half ${JSON.stringify(which)}`);
  }
  if (!new RegExp(`^[${ALPHABET}]{20,32}$`).test(seamId)) {
    throw new SeamQrFormatError("seam id is not base32 of the expected length");
  }

  const share = fromBase64Url(encoded);
  if (share.length !== SEAM_SECRET_BYTES) {
    throw new SeamQrFormatError(`share is ${share.length} bytes, expected ${SEAM_SECRET_BYTES}`);
  }
  return { which, seamId, share };
}

export class SeamQrFormatError extends Error {
  override readonly name = "SeamQrFormatError";
}

/**
 * Both halves, in either order, from the same label.
 *
 * Scanning the same code twice is a distinct failure from scanning two codes
 * that belong to different packets, and neither is "the seal is broken", so
 * they are separate refusals rather than one.
 */
export function combineScannedPair(
  first: ParsedSeamQr,
  second: ParsedSeamQr,
): { seamId: string; seamSecret: Uint8Array } {
  if (first.which === second.which) {
    throw new SeamQrFormatError(`code ${first.which} was scanned twice; both halves are needed`);
  }
  if (first.seamId !== second.seamId) {
    throw new SeamQrFormatError("the two codes carry different seam ids — labels from two packets");
  }
  const a = first.which === "A" ? first.share : second.share;
  const b = first.which === "A" ? second.share : first.share;
  return { seamId: first.seamId, seamSecret: combineSeamShares(a, b) };
}
