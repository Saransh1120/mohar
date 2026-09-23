import { split, combine } from "shamir-secret-sharing";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { timingSafeEqualBytes } from "./merkle.js";

/**
 * ── The opening key ──────────────────────────────────────────────────────────
 *
 *     openingKey  =  controlPart  XOR  fieldKey
 *     fieldKey    →  Shamir 2-of-3  →  superintendent · observer · police escort
 *
 * Two properties fall out of that shape, and both are the point.
 *
 * **The control room cannot be left out.** The XOR makes its part mandatory
 * rather than merely likely: three officials standing in a room with all three
 * field shares still hold nothing, because the field shares reconstruct
 * `fieldKey` and `fieldKey` alone opens nothing. The control room's part is
 * time-locked to a public beacon round (`timelock.ts`), so "mandatory" does not
 * translate into "someone at headquarters must be awake and answer the phone".
 *
 * **Two officials are needed, and they must come from two institutions.** A
 * 2-of-3 split over three officials who all report to the same office is a
 * one-signature scheme wearing a disguise. `combineOpeningKey` refuses a pair
 * from one institution, which is why every share carries the institution it was
 * issued to rather than only the role.
 *
 * This replaces the earlier 3-of-4 split (`shamir.ts`), which treated the
 * authority as one holder among four and could therefore be outvoted. That
 * module stays for packages already sealed under it: their share commitments
 * are on the chain and re-splitting a sealed packet is not a thing that can be
 * done.
 */

export type FieldHolder = "superintendent" | "observer" | "police_escort";

/** Index → holder. Fixed, because share order is meaningful in the audit trail. */
export const FIELD_HOLDERS: readonly FieldHolder[] = Object.freeze([
  "superintendent",
  "observer",
  "police_escort",
]);

/** Two of the three field holders, never fewer. */
export const FIELD_THRESHOLD = 2;

export const OPENING_KEY_BYTES = 32;

export interface FieldShare {
  index: number; // 1-based, matches FIELD_HOLDERS position
  holder: FieldHolder;
  /**
   * The body the holder answers to — a board, a state police force, a district
   * administration. Two shares from one institution do not open a packet.
   */
  institution: string;
  share: Uint8Array;
  commitment: string; // sha256(share), hex
}

export interface OpeningKeySplit {
  /** Held by the control room, time-locked before it is issued. Mandatory. */
  controlPart: Uint8Array;
  controlCommitment: string;
  fieldShares: FieldShare[];
  /** sha256(openingKey). Lets reconstruction be checked without the key. */
  keyCommitment: string;
}

export type OpeningKeyFailure =
  | "control_part_missing"
  | "control_part_corrupted"
  | "too_few_field_shares"
  | "share_commitment_mismatch"
  | "duplicate_share"
  | "same_institution_pair"
  | "reconstruction_mismatch";

export class OpeningKeyError extends Error {
  override readonly name = "OpeningKeyError";
  constructor(
    message: string,
    readonly reason: OpeningKeyFailure,
    readonly suspectHolders: FieldHolder[] = [],
  ) {
    super(message);
  }
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i]! ^ b[i]!;
  return out;
}

function hexToBytes32(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new RangeError("commitment must be 64 lowercase hex characters");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Split an opening key into the control room's part and three field shares.
 *
 * `institutions` names the body each official answers to. It is required rather
 * than optional because a share without it cannot be checked against the
 * two-institution rule at reconstruction, and a rule that is skipped whenever
 * the caller forgot a field is not a rule.
 */
export async function splitOpeningKey(
  openingKey: Uint8Array,
  institutions: Readonly<Record<FieldHolder, string>>,
): Promise<OpeningKeySplit> {
  if (openingKey.length !== OPENING_KEY_BYTES) {
    throw new RangeError(`opening key must be ${OPENING_KEY_BYTES} bytes, got ${openingKey.length}`);
  }
  for (const holder of FIELD_HOLDERS) {
    if (!institutions[holder]?.trim()) {
      throw new RangeError(`no institution given for ${holder}`);
    }
  }

  const controlPart = randomBytes(OPENING_KEY_BYTES);
  const fieldKey = xor(openingKey, controlPart);
  const raw = await split(fieldKey, FIELD_HOLDERS.length, FIELD_THRESHOLD);

  return {
    controlPart,
    controlCommitment: bytesToHex(sha256(controlPart)),
    keyCommitment: bytesToHex(sha256(openingKey)),
    fieldShares: raw.map((share, i) => {
      const holder = FIELD_HOLDERS[i]!;
      return {
        index: i + 1,
        holder,
        institution: institutions[holder],
        share,
        commitment: bytesToHex(sha256(share)),
      };
    }),
  };
}

/**
 * Reconstruct the opening key, checking every step and naming what went wrong.
 *
 * The Shamir library does not verify reconstruction: give it a corrupted share
 * and it returns a wrong secret silently. A wrong opening key fails as an AEAD
 * error minutes before an exam, with nothing to say which holder supplied bad
 * material — so each share is checked against its own commitment first, and the
 * assembled key against the key commitment.
 */
export async function combineOpeningKey(
  controlPart: Uint8Array | undefined,
  fieldShares: readonly FieldShare[],
  commitments: { controlCommitment: string; keyCommitment: string },
): Promise<Uint8Array> {
  if (!controlPart) {
    throw new OpeningKeyError(
      "the control room's part was not supplied; field shares alone open nothing",
      "control_part_missing",
    );
  }
  if (!timingSafeEqualBytes(sha256(controlPart), hexToBytes32(commitments.controlCommitment))) {
    throw new OpeningKeyError(
      "the control room's part does not match its commitment",
      "control_part_corrupted",
    );
  }
  if (fieldShares.length < FIELD_THRESHOLD) {
    throw new OpeningKeyError(
      `need at least ${FIELD_THRESHOLD} field shares, got ${fieldShares.length}`,
      "too_few_field_shares",
    );
  }

  const corrupted = fieldShares.filter((s) => bytesToHex(sha256(s.share)) !== s.commitment);
  if (corrupted.length > 0) {
    throw new OpeningKeyError(
      `share commitment mismatch from: ${corrupted.map((c) => c.holder).join(", ")}`,
      "share_commitment_mismatch",
      corrupted.map((c) => c.holder),
    );
  }

  const seen = new Set<number>();
  for (const s of fieldShares) {
    if (seen.has(s.index)) {
      throw new OpeningKeyError(
        `share index ${s.index} (${s.holder}) supplied more than once`,
        "duplicate_share",
        [s.holder],
      );
    }
    seen.add(s.index);
  }

  // Two shares, one institution. Refused before any reconstruction is attempted,
  // so the refusal is about who turned up rather than about whether the maths
  // happened to work.
  const byInstitution = new Map<string, FieldHolder[]>();
  for (const s of fieldShares) {
    const key = s.institution.trim().toLowerCase();
    byInstitution.set(key, [...(byInstitution.get(key) ?? []), s.holder]);
  }
  const distinctInstitutions = byInstitution.size;
  if (distinctInstitutions < FIELD_THRESHOLD) {
    const together = [...byInstitution.values()].flat();
    throw new OpeningKeyError(
      `all supplied shares come from one institution (${together.join(", ")}); ` +
        "the split exists to require two institutions, not two people",
      "same_institution_pair",
      together,
    );
  }

  const fieldKey = await combine(fieldShares.map((s) => s.share));
  const openingKey = xor(controlPart, fieldKey);

  if (!timingSafeEqualBytes(sha256(openingKey), hexToBytes32(commitments.keyCommitment))) {
    throw new OpeningKeyError(
      "the assembled key does not match its commitment — the parts are individually " +
        "intact but do not belong to the same split",
      "reconstruction_mismatch",
      fieldShares.map((s) => s.holder),
    );
  }

  return openingKey;
}
