import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "@noble/hashes/utils";
import {
  policyCommitment,
  secondsUntilOpen,
  TimelockError,
  unwrapControlPart,
  wrapControlPart,
  type EnvelopePolicy,
} from "./timelock.js";
import { timeOfRound } from "./drand.js";

/**
 * Real quicknet beacons, fetched once from
 * https://api.drand.sh/v2/beacons/quicknet/rounds/<n> and pinned here.
 *
 * Pinned rather than fetched because a unit test that needs the internet is a
 * unit test that fails on the morning of a demonstration in a hall with no
 * Wi-Fi, and because a beacon the league has already published is a fixed
 * historical fact — there is nothing to keep fresh.
 */
const ROUND = 21_000_000;
const BEACON = {
  round: ROUND,
  signature:
    "971cbe88adc436f6411fd26d51887ede7ba144264cd05edec6645b5e170a7702d16082947a85d89c89cb47cd8eb7d817",
};
const EARLIER_BEACON = {
  round: ROUND - 1,
  signature:
    "842620e78f4395cfb79c779e5a7bef96a9d3827630a347244caabdcf55401ecdb6d55ca18439d3d1efd77936bd01a72a",
};

const POLICY: EnvelopePolicy = {
  packageId: "3f5d8bd1-0000-4000-8000-000000000001",
  centreId: "9d0f1b22-0000-4000-8000-000000000002",
  roomId: "5c2ae310-0000-4000-8000-000000000003",
  windowStart: "2026-09-20T03:45:00.000Z",
  windowEnd: "2026-09-20T04:30:00.000Z",
  eligibleRoles: ["superintendent", "observer", "police_escort"],
};

/** Wrap toward the pinned round by asking for the instant that round is emitted. */
async function envelopeForPinnedRound(part: Uint8Array) {
  const envelope = await wrapControlPart(part, timeOfRound(ROUND), POLICY);
  assert.equal(envelope.round, ROUND, "the pinned round must be the one chosen");
  return envelope;
}

test("an envelope opens with the beacon for its own round", async () => {
  const part = randomBytes(32);
  const envelope = await envelopeForPinnedRound(part);
  const out = await unwrapControlPart(envelope, BEACON);
  assert.deepEqual(out, part);
});

test("the beacon for an earlier round does not open it", async () => {
  const envelope = await envelopeForPinnedRound(randomBytes(32));
  await assert.rejects(
    () => unwrapControlPart(envelope, EARLIER_BEACON),
    (err: unknown) => err instanceof TimelockError && /round/.test((err as Error).message),
  );
});

test("a fabricated signature for the right round does not open it", async () => {
  const envelope = await envelopeForPinnedRound(randomBytes(32));
  const forged = { round: ROUND, signature: "00".repeat(48) };
  await assert.rejects(() => unwrapControlPart(envelope, forged));
});

test("the ciphertext is checked against the hash recorded when it was issued", async () => {
  const envelope = await envelopeForPinnedRound(randomBytes(32));
  const tampered = { ...envelope, ciphertextSha256: "ab".repeat(32) };
  await assert.rejects(
    () => unwrapControlPart(tampered, BEACON),
    (err: unknown) => err instanceof TimelockError && /hash/.test((err as Error).message),
  );
});

test("an envelope bound to another chain is refused outright", async () => {
  const envelope = await envelopeForPinnedRound(randomBytes(32));
  const other = { ...envelope, chainHash: "cd".repeat(32) };
  await assert.rejects(
    () => unwrapControlPart(other, BEACON),
    (err: unknown) => err instanceof TimelockError && /quicknet/.test((err as Error).message),
  );
});

test("the round chosen is the first at or after the instant asked for", async () => {
  const at = timeOfRound(ROUND);
  const justBefore = new Date(at.getTime() - 1000);
  const envelope = await wrapControlPart(randomBytes(32), justBefore, POLICY);
  assert.equal(envelope.round, ROUND);
  assert.ok(new Date(envelope.opensAt).getTime() >= justBefore.getTime());
});

test("wrapping the same part twice gives two different ciphertexts", async () => {
  const part = randomBytes(32);
  const first = await envelopeForPinnedRound(part);
  const second = await envelopeForPinnedRound(part);
  assert.notEqual(first.ciphertext, second.ciphertext);
  // ...and both still open to the same part.
  assert.deepEqual(await unwrapControlPart(first, BEACON), part);
  assert.deepEqual(await unwrapControlPart(second, BEACON), part);
});

test("the policy hash binds every field, and ignores the order of roles", async () => {
  const envelope = await envelopeForPinnedRound(randomBytes(32));
  assert.equal(envelope.policySha256, policyCommitment(POLICY));
  assert.equal(
    policyCommitment({ ...POLICY, eligibleRoles: ["observer", "police_escort", "superintendent"] }),
    envelope.policySha256,
  );
  assert.notEqual(policyCommitment({ ...POLICY, roomId: POLICY.centreId }), envelope.policySha256);
  assert.notEqual(
    policyCommitment({ ...POLICY, windowEnd: "2026-09-20T23:59:00.000Z" }),
    envelope.policySha256,
  );
});

test("a control part that is not 32 bytes is refused", async () => {
  await assert.rejects(() => wrapControlPart(randomBytes(16), timeOfRound(ROUND), POLICY), RangeError);
});

test("the countdown reaches zero once the round is in the past", async () => {
  const envelope = await envelopeForPinnedRound(randomBytes(32));
  const opensAt = timeOfRound(ROUND);
  assert.equal(secondsUntilOpen(envelope, new Date(opensAt.getTime() + 1000)), 0);
  assert.equal(secondsUntilOpen(envelope, new Date(opensAt.getTime() - 60_000)), 60);
});
