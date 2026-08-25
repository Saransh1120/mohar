import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

/**
 * Time-bounded custody access keys.
 *
 * A key authorises one stage of one package for one six-hour epoch. Three
 * properties matter, in this order:
 *
 *  1. **It expires by arithmetic, not by a job.** The epoch is derived from the
 *     clock, so a key for a past epoch has no window in which it verifies even
 *     if every rotation task in the system has failed. Expiry that depends on a
 *     cron job running is expiry that silently stops happening.
 *
 *  2. **It is never stored.** We keep SHA-256 of it. The holder sees it once.
 *     A database dump yields fingerprints, not usable keys.
 *
 *  3. **It can be read aloud over a bad phone line.** The people using this are
 *     under time pressure in a room with a printer running. Crockford base32
 *     excludes I, L, O and U, so there is no 0/O or 1/l ambiguity, and decoding
 *     is case-insensitive and forgiving of the grouping dashes.
 */

/** Six hours. Long enough to cover a custody leg, short enough that a copied
 *  key is worthless by the next shift. */
export const EPOCH_SECONDS = 6 * 60 * 60;

/**
 * Overlap either side of an epoch boundary.
 *
 * Without it, a courier mid-handoff at the stroke of an epoch would be refused
 * by a key that was valid when they started reading it out. Thirty minutes is
 * enough for a human operation to finish; it is not enough to be a second key.
 */
export const EPOCH_GRACE_SECONDS = 30 * 60;

export const epochAt = (d: Date = new Date()): number =>
  Math.floor(d.getTime() / 1000 / EPOCH_SECONDS);

export const epochStart = (epoch: number): Date =>
  new Date(epoch * EPOCH_SECONDS * 1000);

export const epochEnd = (epoch: number): Date =>
  new Date((epoch + 1) * EPOCH_SECONDS * 1000);

/** The window a key is actually accepted in, grace included. */
export function epochWindow(epoch: number): { validFrom: Date; validTo: Date } {
  return {
    validFrom: new Date(epochStart(epoch).getTime() - EPOCH_GRACE_SECONDS * 1000),
    validTo: new Date(epochEnd(epoch).getTime() + EPOCH_GRACE_SECONDS * 1000),
  };
}

// Crockford base32: no I, L, O, U — the characters people mis-hear or mis-read.
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

/**
 * Generate a key for one (package, stage, epoch).
 *
 * 16 bytes — 128 bits. The key is only ever valid inside a six-hour window for
 * one stage of one package, so the exhaustive-search budget an attacker has is
 * six hours against a rate-limited endpoint, not the lifetime of the system.
 */
export function generateCustodyKey(stage: string): {
  key: string;
  keyHashHex: string;
  fingerprint: string;
} {
  const raw = randomBytes(16);
  const body = toBase32(raw); // 26 chars
  // Grouped for reading aloud, and prefixed with the stage so a key found on a
  // desk announces what it opens without having to be tried against anything.
  const grouped = (body.match(/.{1,4}/g) ?? []).join("-");
  const key = `MHR-${stage.toUpperCase()}-${grouped}`;
  return { key, ...digestKey(key) };
}

/** Hash and fingerprint a key. The fingerprint is safe to log and display. */
export function digestKey(key: string): { keyHashHex: string; fingerprint: string } {
  const hash = sha256(utf8ToBytes(normaliseKey(key)));
  const hex = bytesToHex(hash);
  return { keyHashHex: hex, fingerprint: hex.slice(0, 12) };
}

/**
 * Canonical form before hashing.
 *
 * Someone typing a key on a phone at 04:00 will get the case or the dashes
 * wrong. Normalising here means those are not authentication failures — which
 * matters, because a system that denies for cosmetic reasons trains its
 * operators to treat denials as noise.
 */
export function normaliseKey(key: string): string {
  return key.trim().toUpperCase().replace(/[\s-]/g, "");
}

/** Constant-time comparison of two hex digests. */
export function keyMatches(presentedKey: string, storedHashHex: string): boolean {
  const { keyHashHex } = digestKey(presentedKey);
  if (keyHashHex.length !== storedHashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < keyHashHex.length; i++) {
    diff |= keyHashHex.charCodeAt(i) ^ storedHashHex.charCodeAt(i);
  }
  return diff === 0;
}
