import test from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import {
  leafHash,
  nodeHash,
  merkleRoot,
  merkleRootHex,
  inclusionProof,
  verifyInclusion,
} from "./merkle.js";

/**
 * The expected roots below were produced by an independent re-implementation of
 * RFC 6962 §2.1 written directly from the spec (a PowerShell/.NET script, so it
 * shares no code, no library, and no language with this implementation). If both
 * agree, a shared bug is very unlikely.
 *
 * The two fixed vectors are the ones published with the standard:
 *   MTH({})   = SHA256("")
 *   MTH({""}) = SHA256(0x00)
 */

const leavesFor = (n: number) =>
  Array.from({ length: n }, (_, j) => leafHash(utf8ToBytes(`event-${j}`)));

const PINNED_ROOTS: Record<number, string> = {
  1: "6734db3b19b64dc83703f9a1f4aee7697dfb292fb4e0827cc63f8a351b1b3609",
  2: "3fd1d5a059ab171a345f9912c83c2dd8b7933b4e950e6749bc83dbb1f43ccbde",
  3: "db2effe64d36352bcd4c260bde0e1138310c9f77b89d4c57578652f9b185b630",
  4: "330157348b2985bd1c4657e44f3628ae9176dd82811ffb31a8e011b9dea8b9a1",
  5: "0b74d4300e798056cd48728b4fb01e9f15ad3e0a7950fbc58974ff6753271d24",
  8: "37dd16ebf683d96c0e244084d5cd76e022d00c6a092f6008cc8ac7abcd2b6f12",
  17: "1054356c8fbea9200453c74e52cfd34276314ac865c159e6d986a7bffab1f717",
};

test("empty tree root is SHA256 of the empty string", () => {
  assert.equal(
    merkleRootHex([]),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("single empty leaf is SHA256(0x00)", () => {
  assert.equal(
    merkleRootHex([leafHash(new Uint8Array(0))]),
    "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  );
});

test("roots match the independent implementation", () => {
  for (const [n, expected] of Object.entries(PINNED_ROOTS)) {
    assert.equal(merkleRootHex(leavesFor(Number(n))), expected, `n=${n}`);
  }
});

test("every inclusion proof round-trips for n = 1..17", () => {
  let checked = 0;
  for (let n = 1; n <= 17; n++) {
    const leaves = leavesFor(n);
    const root = merkleRoot(leaves);
    for (let i = 0; i < n; i++) {
      const proof = inclusionProof(leaves, i);
      assert.ok(
        verifyInclusion(leaves[i]!, i, n, proof, root),
        `proof failed for n=${n} index=${i}`,
      );
      checked++;
    }
  }
  assert.equal(checked, 153);
});

test("proof depth follows the CT split, not a balanced split", () => {
  // n=5 splits as 4 + 1, so index 4 sits at depth 1 while index 0 sits at depth 3.
  // A tree that split as ceil(n/2) would give both the same depth — this is the
  // assertion that catches an implementer "simplifying" splitPoint.
  const leaves = leavesFor(5);
  assert.equal(inclusionProof(leaves, 0).length, 3);
  assert.equal(inclusionProof(leaves, 4).length, 1);
});

test("rejects a proof for the wrong index", () => {
  const leaves = leavesFor(8);
  const root = merkleRoot(leaves);
  const proof = inclusionProof(leaves, 3);
  assert.equal(verifyInclusion(leaves[3]!, 4, 8, proof, root), false);
});

test("rejects a proof presented with the wrong leaf", () => {
  const leaves = leavesFor(8);
  const root = merkleRoot(leaves);
  const proof = inclusionProof(leaves, 3);
  assert.equal(verifyInclusion(leaves[5]!, 3, 8, proof, root), false);
});

test("rejects a tampered proof", () => {
  const leaves = leavesFor(8);
  const root = merkleRoot(leaves);
  const proof = inclusionProof(leaves, 3);
  proof[0] = leafHash(utf8ToBytes("forged"));
  assert.equal(verifyInclusion(leaves[3]!, 3, 8, proof, root), false);
});

test("rejects a truncated proof", () => {
  const leaves = leavesFor(8);
  const root = merkleRoot(leaves);
  const proof = inclusionProof(leaves, 3);
  assert.equal(verifyInclusion(leaves[3]!, 3, 8, proof.slice(0, 2), root), false);
});

test("rejects an out-of-range index", () => {
  const leaves = leavesFor(4);
  const root = merkleRoot(leaves);
  assert.equal(verifyInclusion(leaves[0]!, 4, 4, [], root), false);
  assert.equal(verifyInclusion(leaves[0]!, -1, 4, [], root), false);
});

test("leaf and internal domains are disjoint (second-preimage resistance)", () => {
  // Without the 0x00/0x01 prefixes an attacker could present an internal node as
  // a leaf and produce a valid-looking proof for data that was never logged.
  const a = leafHash(utf8ToBytes("a"));
  const b = leafHash(utf8ToBytes("b"));
  const internal = nodeHash(a, b);
  const asLeaf = leafHash(new Uint8Array([...a, ...b]));
  assert.notEqual(bytesToHex(internal), bytesToHex(asLeaf));
});
