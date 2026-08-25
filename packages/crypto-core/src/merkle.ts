import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";

/**
 * Merkle tree exactly as specified in RFC 6962 §2.1 (Certificate Transparency).
 *
 * The domain-separation prefixes are the point. A naive tree that hashes leaves
 * and internal nodes the same way admits a second-preimage attack: an attacker
 * presents an internal node as though it were a leaf, and an inclusion proof for
 * a value that was never logged verifies. Prefixing leaves with 0x00 and internal
 * nodes with 0x01 makes the two domains disjoint.
 *
 *   MTH({})       = SHA256("")
 *   MTH({d0})     = SHA256(0x00 || d0)
 *   MTH(D[n])     = SHA256(0x01 || MTH(D[0:k]) || MTH(D[k:n]))
 *
 * where k is the largest power of two strictly less than n. Note k is *not*
 * ceil(n/2): CT deliberately fills the left subtree to a power of two so that
 * the tree shape depends only on n, which is what makes consistency proofs
 * between two tree sizes possible.
 */

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

export function leafHash(data: Uint8Array): Uint8Array {
  return sha256(concatBytes(LEAF_PREFIX, data));
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(concatBytes(NODE_PREFIX, left, right));
}

/** Largest power of two strictly less than n. Requires n > 1. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * Root over already-hashed leaves (i.e. the output of `leafHash` for each entry).
 * Taking pre-hashed leaves keeps this function independent of how a caller
 * serialises its records.
 */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha256(new Uint8Array(0));
  if (leaves.length === 1) return leaves[0]!;
  const k = splitPoint(leaves.length);
  return nodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

export function merkleRootHex(leaves: readonly Uint8Array[]): string {
  return bytesToHex(merkleRoot(leaves));
}

/**
 * Inclusion proof for leaf `index` in a tree of `leaves`, per RFC 6962 §2.1.1.
 * Returns the sibling hashes from the bottom up.
 */
export function inclusionProof(
  leaves: readonly Uint8Array[],
  index: number,
): Uint8Array[] {
  if (index < 0 || index >= leaves.length) {
    throw new RangeError(`index ${index} out of range for ${leaves.length} leaves`);
  }
  if (leaves.length === 1) return [];
  const k = splitPoint(leaves.length);
  if (index < k) {
    return [...inclusionProof(leaves.slice(0, k), index), merkleRoot(leaves.slice(k))];
  }
  return [...inclusionProof(leaves.slice(k), index - k), merkleRoot(leaves.slice(0, k))];
}

/**
 * Verify an inclusion proof without holding the tree.
 *
 * This is what `verify-portal` runs in the browser: a candidate or a journalist
 * has one event, its proof, and a published root, and needs no access to the
 * rest of the log to check that the event was in it.
 */
export function verifyInclusion(
  leaf: Uint8Array,
  index: number,
  treeSize: number,
  proof: readonly Uint8Array[],
  expectedRoot: Uint8Array,
): boolean {
  if (index < 0 || index >= treeSize) return false;

  // Descend from the root recording, at each level, whether our node is the LEFT
  // child. We cannot combine hashes on the way down because the leaf hash only
  // enters at the bottom — so we collect the shape first.
  //
  // The split is not index parity: CT fills the left subtree to a power of two,
  // so the branch decision must come from splitPoint(size), not from `index & 1`.
  const goesLeft: boolean[] = [];
  let i = index;
  let size = treeSize;
  while (size > 1) {
    const k = splitPoint(size);
    if (i < k) {
      goesLeft.push(true);
      size = k;
    } else {
      goesLeft.push(false);
      i -= k;
      size -= k;
    }
  }

  // `goesLeft[0]` is the topmost decision; `proof[0]` is the *deepest* sibling,
  // because inclusionProof appends this level's sibling after recursing. Walk the
  // two in opposite directions.
  if (goesLeft.length !== proof.length) return false;

  let hash = leaf;
  for (let depth = goesLeft.length - 1, p = 0; depth >= 0; depth--, p++) {
    const sibling = proof[p]!;
    hash = goesLeft[depth]! ? nodeHash(hash, sibling) : nodeHash(sibling, hash);
  }

  return timingSafeEqualBytes(hash, expectedRoot);
}

export const proofToHex = (proof: readonly Uint8Array[]): string[] =>
  proof.map((p) => bytesToHex(p));

export const proofFromHex = (proof: readonly string[]): Uint8Array[] =>
  proof.map((p) => hexToBytes(p));

/** Constant-time comparison. Not security-critical here, but cheap and correct. */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
