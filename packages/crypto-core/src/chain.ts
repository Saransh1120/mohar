import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";
import { bodyHash } from "./canonical.js";
import { timingSafeEqualBytes } from "./merkle.js";

/**
 * The hash chain over accepted events.
 *
 *   bodyHash  = SHA256(JCS(body))                  ← what the device signs
 *   chainHash = SHA256(prevChainHash || bodyHash)  ← what fixes it in sequence
 *
 * Two hashes rather than one, because they answer different questions. The
 * device cannot know `prevChainHash` at signing time: the chain is global and the
 * device may have been offline for hours. So the signature covers only the body,
 * and the ledger binds that body to a position when it accepts it.
 *
 * Anyone can then verify two independent things: that the authoring device really
 * produced this content (signature over bodyHash), and that the ledger has not
 * reordered, inserted, or removed anything since (chain recomputation).
 */

/** Genesis predecessor: 32 zero bytes. The first event in a chain uses this. */
export const GENESIS_HASH = new Uint8Array(32);
export const GENESIS_HASH_HEX = bytesToHex(GENESIS_HASH);

export function chainHash(prevChainHash: Uint8Array, body: unknown): Uint8Array {
  if (prevChainHash.length !== 32) {
    throw new RangeError(`prevChainHash must be 32 bytes, got ${prevChainHash.length}`);
  }
  return sha256(concatBytes(prevChainHash, bodyHash(body)));
}

export function chainHashFromHashes(
  prevChainHash: Uint8Array,
  bodyHashBytes: Uint8Array,
): Uint8Array {
  if (prevChainHash.length !== 32 || bodyHashBytes.length !== 32) {
    throw new RangeError("both inputs must be 32-byte hashes");
  }
  return sha256(concatBytes(prevChainHash, bodyHashBytes));
}

export interface ChainLink {
  seq: string;
  bodyHash: string;
  prevHash: string;
  hash: string;
}

export interface ChainBreak {
  seq: string;
  reason: "prev_hash_mismatch" | "hash_mismatch";
  expected: string;
  actual: string;
}

/**
 * Recompute a contiguous run of links and report every break.
 *
 * Returns all breaks rather than throwing on the first, because during an
 * investigation the *shape* of the damage matters: a single bad link suggests
 * corruption, while a run of them from one point onward suggests a rewrite.
 */
export function verifyChain(
  links: readonly ChainLink[],
  startingFrom: Uint8Array = GENESIS_HASH,
): ChainBreak[] {
  const breaks: ChainBreak[] = [];
  let expectedPrev = startingFrom;

  for (const link of links) {
    const declaredPrev = hexToBytes(link.prevHash);
    if (!timingSafeEqualBytes(declaredPrev, expectedPrev)) {
      breaks.push({
        seq: link.seq,
        reason: "prev_hash_mismatch",
        expected: bytesToHex(expectedPrev),
        actual: link.prevHash,
      });
      // Continue from what this link *claims*, so one break does not cascade
      // into a false break at every subsequent link.
      expectedPrev = declaredPrev;
    }

    const recomputed = chainHashFromHashes(expectedPrev, hexToBytes(link.bodyHash));
    const recomputedHex = bytesToHex(recomputed);
    if (recomputedHex !== link.hash) {
      breaks.push({
        seq: link.seq,
        reason: "hash_mismatch",
        expected: recomputedHex,
        actual: link.hash,
      });
    }

    expectedPrev = hexToBytes(link.hash);
  }

  return breaks;
}
