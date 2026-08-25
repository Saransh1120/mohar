import { split, combine } from "shamir-secret-sharing";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { timingSafeEqualBytes } from "./merkle.js";

/**
 * Shamir 3-of-4 over the content key, per docs/03-crypto-design.md.
 *
 * Built on `shamir-secret-sharing` (Privy) — GF(2^8), zero dependencies, and
 * independently audited by Cure53 and Zellic. It is the only JavaScript Shamir
 * implementation with a public audit trail, which is why it was chosen over the
 * several more popular but unaudited alternatives.
 *
 * ── The sharp edge this module exists to blunt ──
 *
 * The library explicitly does NOT verify reconstruction. Feed it three shares
 * where one is corrupted and it returns a wrong secret with no error. In our
 * setting that is dangerous in a specific way: a wrong content key does not fail
 * loudly, it produces AEAD decryption failure minutes before an exam with no
 * indication of *which* share holder supplied bad material.
 *
 * So every share carries a commitment, and reconstruction is verified against a
 * commitment to the secret itself. We can then name the bad share.
 */

export const SHARE_COUNT = 4;
export const SHARE_THRESHOLD = 3;

export type ShareHolder = "authority" | "timelock" | "superintendent" | "observer";

/** Index → holder. Fixed, because share order is meaningful in the audit trail. */
export const SHARE_HOLDERS: readonly ShareHolder[] = Object.freeze([
  "authority",
  "timelock",
  "superintendent",
  "observer",
]);

export interface CommittedShare {
  index: number; // 1-based, matches SHARE_HOLDERS position
  holder: ShareHolder;
  share: Uint8Array;
  commitment: string; // sha256(share), hex
}

export interface SplitResult {
  shares: CommittedShare[];
  /** sha256(secret). Lets reconstruction be checked without holding the secret. */
  secretCommitment: string;
}

export class ShareIntegrityError extends Error {
  override readonly name = "ShareIntegrityError";
  constructor(
    message: string,
    readonly suspectHolders: ShareHolder[],
  ) {
    super(message);
  }
}

export async function splitContentKey(secret: Uint8Array): Promise<SplitResult> {
  if (secret.length !== 32) {
    throw new RangeError(`content key must be 32 bytes, got ${secret.length}`);
  }
  const raw = await split(secret, SHARE_COUNT, SHARE_THRESHOLD);
  return {
    secretCommitment: bytesToHex(sha256(secret)),
    shares: raw.map((share, i) => ({
      index: i + 1,
      holder: SHARE_HOLDERS[i]!,
      share,
      commitment: bytesToHex(sha256(share)),
    })),
  };
}

/**
 * Reconstruct, verifying every step.
 *
 * Checks each share against its own commitment first so a corrupted share is
 * named directly. Only if all supplied shares are individually intact — and the
 * result still fails to match the secret commitment — do we report the set as
 * jointly suspect, which would indicate mismatched shares from different splits.
 */
export async function combineContentKey(
  shares: readonly CommittedShare[],
  secretCommitment: string,
): Promise<Uint8Array> {
  if (shares.length < SHARE_THRESHOLD) {
    throw new ShareIntegrityError(
      `need at least ${SHARE_THRESHOLD} shares, got ${shares.length}`,
      [],
    );
  }

  const corrupted = shares.filter(
    (s) => bytesToHex(sha256(s.share)) !== s.commitment,
  );
  if (corrupted.length > 0) {
    throw new ShareIntegrityError(
      `share commitment mismatch from: ${corrupted.map((c) => c.holder).join(", ")}`,
      corrupted.map((c) => c.holder),
    );
  }

  const seen = new Set<number>();
  for (const s of shares) {
    if (seen.has(s.index)) {
      throw new ShareIntegrityError(
        `share index ${s.index} (${s.holder}) supplied more than once`,
        [s.holder],
      );
    }
    seen.add(s.index);
  }

  const secret = await combine(shares.map((s) => s.share));

  if (!timingSafeEqualBytes(sha256(secret), hexToBytes32(secretCommitment))) {
    throw new ShareIntegrityError(
      "reconstructed key does not match its commitment — shares are individually " +
        "intact but do not belong to the same split",
      shares.map((s) => s.holder),
    );
  }

  return secret;
}

function hexToBytes32(hex: string): Uint8Array {
  if (hex.length !== 64) {
    throw new RangeError(`expected a 32-byte hex commitment, got ${hex.length / 2} bytes`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
