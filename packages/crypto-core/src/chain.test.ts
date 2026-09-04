import test from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { bodyHashHex } from "./canonical.js";
import {
  GENESIS_HASH,
  GENESIS_HASH_HEX,
  chainHash,
  chainHashFromHashes,
  verifyChain,
  type ChainLink,
} from "./chain.js";

/**
 * These tests exercise the property the ledger actually depends on: that a
 * recomputation of the chain notices any edit to an accepted event, and that it
 * says *where* and *how* the chain broke rather than just refusing the whole
 * run. Nothing here pins a hash to a literal — the values are derived by the
 * same functions under test — so what is being checked is behaviour under
 * tampering, not the digest algorithm, which `merkle.test.ts` already covers
 * against independently produced vectors.
 */

/** Build a well-formed chain over `bodies`, starting from genesis. */
function buildChain(bodies: readonly unknown[]): ChainLink[] {
  const links: ChainLink[] = [];
  let prev: Uint8Array<ArrayBufferLike> = GENESIS_HASH;

  for (const [i, body] of bodies.entries()) {
    const hash = chainHash(prev, body);
    links.push({
      seq: String(i + 1),
      bodyHash: bodyHashHex(body),
      prevHash: bytesToHex(prev),
      hash: bytesToHex(hash),
    });
    prev = hash;
  }

  return links;
}

const BODIES = [
  { type: "package.sealed", packageId: "PKG-1", centre: "C-001" },
  { type: "package.dispatched", packageId: "PKG-1", vehicle: "V-77" },
  { type: "package.received", packageId: "PKG-1", centre: "C-014" },
  { type: "package.opened", packageId: "PKG-1", seat: "S-31" },
];

test("genesis is thirty-two zero bytes", () => {
  assert.equal(GENESIS_HASH.length, 32);
  assert.ok(GENESIS_HASH.every((b) => b === 0));
  assert.equal(GENESIS_HASH_HEX, "0".repeat(64));
});

test("chainHash refuses a predecessor that is not a 32-byte hash", () => {
  assert.throws(() => chainHash(new Uint8Array(31), BODIES[0]), RangeError);
  assert.throws(() => chainHash(new Uint8Array(33), BODIES[0]), RangeError);
});

test("chainHashFromHashes refuses either input at the wrong length", () => {
  const ok = hexToBytes(bodyHashHex(BODIES[0]));
  assert.throws(() => chainHashFromHashes(new Uint8Array(16), ok), RangeError);
  assert.throws(() => chainHashFromHashes(GENESIS_HASH, new Uint8Array(16)), RangeError);
});

test("the same body in the same position always yields the same link", () => {
  const first = buildChain(BODIES);
  const second = buildChain(BODIES);
  assert.deepEqual(first, second);
});

test("an untouched chain verifies with no breaks", () => {
  assert.deepEqual(verifyChain(buildChain(BODIES)), []);
});

test("an empty run of links verifies", () => {
  assert.deepEqual(verifyChain([]), []);
});

test("editing an event body is caught as a hash mismatch", () => {
  const links = buildChain(BODIES);
  const target = links[2];
  assert.ok(target, "fixture should have a third link");

  // The seat is rewritten after the fact — the attributability claim the whole
  // system rests on. The stored chain hash still refers to the original body.
  links[2] = { ...target, bodyHash: bodyHashHex({ ...BODIES[2], seat: "S-99" }) };

  const breaks = verifyChain(links);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0]?.seq, "3");
  assert.equal(breaks[0]?.reason, "hash_mismatch");
  assert.notEqual(breaks[0]?.expected, breaks[0]?.actual);
});

test("re-pointing a link at a different predecessor is caught", () => {
  const links = buildChain(BODIES);
  const target = links[1];
  assert.ok(target, "fixture should have a second link");

  links[1] = { ...target, prevHash: GENESIS_HASH_HEX };

  const breaks = verifyChain(links);
  const reasons = breaks.map((b) => b.reason);
  assert.ok(reasons.includes("prev_hash_mismatch"));
  assert.equal(breaks[0]?.seq, "2");
});

test("dropping an event from the middle is caught", () => {
  const links = buildChain(BODIES);
  links.splice(1, 1);

  const breaks = verifyChain(links);
  assert.ok(breaks.length > 0, "a removed event must not go unnoticed");
});

test("one break does not cascade into a break at every later link", () => {
  const long = buildChain([...BODIES, ...BODIES, ...BODIES]);
  const target = long[1];
  assert.ok(target, "fixture should have a second link");

  long[1] = { ...target, bodyHash: bodyHashHex({ tampered: true }) };

  const breaks = verifyChain(long);
  // Verification continues from what each link claims, so the damage stays
  // local. If this ever reports a break per link, the shape of the damage is
  // lost and an investigator cannot tell corruption from a rewrite.
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0]?.seq, "2");
});

test("a run verified from a later anchor does not need genesis", () => {
  const links = buildChain(BODIES);
  const anchor = links[1];
  assert.ok(anchor, "fixture should have a second link");

  const tail = links.slice(2);
  assert.deepEqual(verifyChain(tail, hexToBytes(anchor.hash)), []);

  // The same tail against the wrong anchor must not pass.
  const breaks = verifyChain(tail, GENESIS_HASH);
  assert.ok(breaks.length > 0);
  assert.equal(breaks[0]?.reason, "prev_hash_mismatch");
});
