import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

/**
 * ── The transfer key ─────────────────────────────────────────────────────────
 *
 * One hand-off, one key. It is created when the sender dispatches, held by the
 * system, and released to the receiver's device only after the receiver has
 * scanned both codes, typed the packet serial and given a fingerprint. The
 * sender never sees it, which is the point: a key the sender could read is a
 * key the sender could pass to someone who never stood next to the packet.
 *
 * Only `sha256(key ‖ seamId ‖ legId)` is stored. A database read therefore does
 * not hand anyone the means to close a hand-off, and a key overheard on one leg
 * cannot be replayed on the next because the hash is bound to both the packet's
 * seam id and that leg.
 *
 * Eight Crockford base32 characters — 40 bits. That is small enough to read
 * aloud when a device has to be replaced mid-route, and the exhaustive-search
 * budget is one leg against a rate-limited endpoint that raises an alert on the
 * third wrong answer, not a lifetime against a hash.
 */

// No I, L, O or U: the characters people mis-read and mis-hear.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const TRANSFER_KEY_LENGTH = 8;

/** Three wrong answers on one leg is an alert, not a silent refusal. */
export const TRANSFER_KEY_ATTEMPT_LIMIT = 3;

export interface IssuedTransferKey {
  /** Shown only on the receiver's attested device, and only after every check. */
  key: string;
  keyHashHex: string;
  expiresAt: Date;
}

/**
 * Draw the key from a CSPRNG, rejecting the byte values that would bias the
 * alphabet.
 *
 * With 32 characters the rejection never actually fires, since 256 divides
 * evenly by 32. It is here because the alphabet is a constant someone will
 * eventually shorten, and the bias that would introduce is invisible in the
 * output - keys would simply favour the first few characters forever.
 */
function drawKey(): string {
  let out = "";
  while (out.length < TRANSFER_KEY_LENGTH) {
    for (const byte of randomBytes(TRANSFER_KEY_LENGTH)) {
      if (byte >= 256 - (256 % ALPHABET.length)) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === TRANSFER_KEY_LENGTH) break;
    }
  }
  return out;
}

export function generateTransferKey(
  seamId: string,
  legId: string,
  expiresAt: Date,
): IssuedTransferKey {
  const key = drawKey();
  return { key, keyHashHex: transferKeyHash(key, seamId, legId), expiresAt };
}

/** `sha256(normalisedKey ‖ seamId ‖ legId)`, hex. */
export function transferKeyHash(key: string, seamId: string, legId: string): string {
  const material = `${normaliseTransferKey(key)}|${seamId.trim().toUpperCase()}|${legId.trim().toLowerCase()}`;
  return bytesToHex(sha256(utf8ToBytes(material)));
}

/**
 * Canonical form before hashing.
 *
 * Someone reading a key off a phone screen in a truck at 04:00 will get the
 * case or the spacing wrong. Those are not authentication failures — a system
 * that refuses for cosmetic reasons teaches its operators that refusals are
 * noise, which is the one lesson it must never teach.
 */
export function normaliseTransferKey(key: string): string {
  return key.trim().toUpperCase().replace(/[\s-]/g, "");
}

export interface TransferKeyCheck {
  matches: boolean;
  expired: boolean;
  /** Well-formed for this alphabet and length. A malformed key is a typo, not
   *  necessarily an attack, and the two are worth telling apart in the record. */
  wellFormed: boolean;
}

/**
 * Check a presented key against the stored hash for one leg.
 *
 * Expiry is evaluated and reported even when the key does not match, because
 * "wrong key" and "right key, four hours late" are different events and the
 * record has to be able to say which one happened. The caller decides what to
 * do with that; this function only reports.
 */
export function checkTransferKey(
  presented: string,
  binding: { seamId: string; legId: string; keyHashHex: string; expiresAt: Date },
  now: Date = new Date(),
): TransferKeyCheck {
  const normalised = normaliseTransferKey(presented);
  const wellFormed =
    normalised.length === TRANSFER_KEY_LENGTH &&
    [...normalised].every((c) => ALPHABET.includes(c));

  // Hashed and compared whatever its shape, so a malformed key and a
  // well-formed wrong one take the same path and the same time.
  const matches = transferKeyMatches(normalised, binding.seamId, binding.legId, binding.keyHashHex);

  return { matches, expired: now.getTime() > binding.expiresAt.getTime(), wellFormed };
}

/**
 * Constant-time comparison of a presented key against a stored hash.
 *
 * Takes the seam id and the leg id because the hash binds all three: a
 * comparison over the key alone would accept a key issued for another leg.
 */
export function transferKeyMatches(
  presented: string,
  seamId: string,
  legId: string,
  storedHashHex: string,
): boolean {
  const computed = transferKeyHash(presented, seamId, legId);
  if (computed.length !== storedHashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i += 1) {
    diff |= computed.charCodeAt(i) ^ storedHashHex.charCodeAt(i);
  }
  return diff === 0;
}

/** A short digest that is safe to show and log. Never the key itself. */
export function transferKeyFingerprint(keyHashHex: string): string {
  return keyHashHex.slice(0, 12);
}
