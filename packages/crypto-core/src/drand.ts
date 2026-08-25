/**
 * drand quicknet round arithmetic.
 *
 * Constants fetched from https://api.drand.sh/v2/beacons/quicknet/info and
 * recorded in docs/11-verified-dependencies.md. They are pinned here rather than
 * discovered at runtime: a beacon that reports a different genesis or period is
 * either a different chain or a hostile response, and in both cases we want a
 * loud failure rather than a silently retargeted time lock.
 */

export const QUICKNET = Object.freeze({
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  /** Seconds between rounds. */
  period: 3,
  /** Unix seconds at which round 1 was emitted. */
  genesisTime: 1_692_803_367,
  schemeID: "bls-unchained-g1-rfc9380",
  beaconID: "quicknet",
} as const);

/**
 * quicknet is the ONLY mainnet drand chain that supports timelock encryption.
 * The other chains returned by /v2/chains are chained rather than unchained,
 * which makes a future round's signature unpredictable and tlock impossible.
 */
export const TIMELOCK_CAPABLE_CHAIN_HASHES: ReadonlySet<string> = new Set([
  QUICKNET.chainHash,
]);

export class DrandChainError extends Error {
  override readonly name = "DrandChainError";
}

/** The round in effect at a given instant. Round 1 is emitted at genesis. */
export function roundAt(when: Date): number {
  const t = Math.floor(when.getTime() / 1000);
  if (t < QUICKNET.genesisTime) {
    throw new RangeError(
      `${when.toISOString()} precedes quicknet genesis (${QUICKNET.genesisTime})`,
    );
  }
  return Math.floor((t - QUICKNET.genesisTime) / QUICKNET.period) + 1;
}

/**
 * The first round emitted at or after `when`.
 *
 * This is the one to use for a time lock. `roundAt` returns the round already in
 * effect, whose signature may have been published *before* the exam start
 * instant — locking to it could open the paper up to `period` seconds early.
 * Rounding up costs at most 3 seconds and cannot open early.
 */
export function roundAtOrAfter(when: Date): number {
  const t = Math.floor(when.getTime() / 1000);
  if (t < QUICKNET.genesisTime) {
    throw new RangeError(
      `${when.toISOString()} precedes quicknet genesis (${QUICKNET.genesisTime})`,
    );
  }
  return Math.ceil((t - QUICKNET.genesisTime) / QUICKNET.period) + 1;
}

/** The instant a round is emitted. */
export function timeOfRound(round: number): Date {
  if (!Number.isInteger(round) || round < 1) {
    throw new RangeError(`round must be a positive integer, got ${round}`);
  }
  return new Date((QUICKNET.genesisTime + (round - 1) * QUICKNET.period) * 1000);
}

/**
 * Guard for chain info fetched at runtime. Call before every encrypt.
 *
 * A beacon whose parameters disagree with the pinned values is treated as a
 * hostile network, not a transient error — an attacker who can retarget the
 * chain can retarget the lock.
 */
export function assertPinnedChain(info: {
  hash?: string;
  public_key?: string;
  period?: number;
  genesis_time?: number;
}): void {
  const mismatches: string[] = [];
  if (info.hash !== undefined && info.hash !== QUICKNET.chainHash) {
    mismatches.push(`chain hash ${info.hash} != ${QUICKNET.chainHash}`);
  }
  if (info.public_key !== undefined && info.public_key !== QUICKNET.publicKey) {
    mismatches.push("public key does not match the pinned quicknet key");
  }
  if (info.period !== undefined && info.period !== QUICKNET.period) {
    mismatches.push(`period ${info.period} != ${QUICKNET.period}`);
  }
  if (info.genesis_time !== undefined && info.genesis_time !== QUICKNET.genesisTime) {
    mismatches.push(`genesis ${info.genesis_time} != ${QUICKNET.genesisTime}`);
  }
  if (mismatches.length > 0) {
    throw new DrandChainError(
      `refusing to use beacon: ${mismatches.join("; ")}. Treat as a hostile network.`,
    );
  }
}
