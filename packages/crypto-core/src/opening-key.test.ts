import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "@noble/hashes/utils";
import {
  combineOpeningKey,
  splitOpeningKey,
  OpeningKeyError,
  type FieldHolder,
  type FieldShare,
} from "./opening-key.js";

/**
 * The claim under test is "the control room's part is mandatory and two
 * institutions must turn up". Every test here is one way of trying to open a
 * packet without satisfying both halves of that sentence.
 */

const INSTITUTIONS: Record<FieldHolder, string> = {
  superintendent: "Kendriya Vidyalaya Jaipur",
  observer: "Rajasthan Board of Secondary Education",
  police_escort: "Rajasthan Police",
};

async function freshSplit(key = randomBytes(32)) {
  const split = await splitOpeningKey(key, INSTITUTIONS);
  return { key, split };
}

function share(split: Awaited<ReturnType<typeof freshSplit>>["split"], holder: FieldHolder) {
  const found = split.fieldShares.find((s) => s.holder === holder);
  assert.ok(found, `no share for ${holder}`);
  return found;
}

function commitments(split: Awaited<ReturnType<typeof freshSplit>>["split"]) {
  return { controlCommitment: split.controlCommitment, keyCommitment: split.keyCommitment };
}

test("the control room's part and any two field shares reconstruct the key", async () => {
  const { key, split } = await freshSplit();
  const pairs: [FieldHolder, FieldHolder][] = [
    ["superintendent", "observer"],
    ["superintendent", "police_escort"],
    ["observer", "police_escort"],
  ];
  for (const [a, b] of pairs) {
    const out = await combineOpeningKey(
      split.controlPart,
      [share(split, a), share(split, b)],
      commitments(split),
    );
    assert.deepEqual(out, key, `${a} + ${b} should open`);
  }
});

test("all three field shares also work, with the control part", async () => {
  const { key, split } = await freshSplit();
  const out = await combineOpeningKey(split.controlPart, split.fieldShares, commitments(split));
  assert.deepEqual(out, key);
});

test("two field shares without the control room's part open nothing", async () => {
  const { split } = await freshSplit();
  await assert.rejects(
    () =>
      combineOpeningKey(
        undefined,
        [share(split, "superintendent"), share(split, "observer")],
        commitments(split),
      ),
    (err: unknown) => err instanceof OpeningKeyError && err.reason === "control_part_missing",
  );
});

test("the control room's part alone opens nothing", async () => {
  const { split } = await freshSplit();
  await assert.rejects(
    () => combineOpeningKey(split.controlPart, [], commitments(split)),
    (err: unknown) => err instanceof OpeningKeyError && err.reason === "too_few_field_shares",
  );
});

test("one field share plus the control part is not enough", async () => {
  const { split } = await freshSplit();
  await assert.rejects(
    () => combineOpeningKey(split.controlPart, [share(split, "observer")], commitments(split)),
    (err: unknown) => err instanceof OpeningKeyError && err.reason === "too_few_field_shares",
  );
});

test("two officials from the same institution are refused", async () => {
  const key = randomBytes(32);
  const split = await splitOpeningKey(key, {
    superintendent: "Rajasthan Board of Secondary Education",
    observer: "Rajasthan Board of Secondary Education",
    police_escort: "Rajasthan Police",
  });
  await assert.rejects(
    () =>
      combineOpeningKey(
        split.controlPart,
        [share(split, "superintendent"), share(split, "observer")],
        commitments(split),
      ),
    (err: unknown) => err instanceof OpeningKeyError && err.reason === "same_institution_pair",
  );

  // ...and the same packet still opens for a pair that does span two bodies.
  const out = await combineOpeningKey(
    split.controlPart,
    [share(split, "observer"), share(split, "police_escort")],
    commitments(split),
  );
  assert.deepEqual(out, key);
});

test("institution matching ignores case and surrounding spaces", async () => {
  const split = await splitOpeningKey(randomBytes(32), {
    superintendent: "  rajasthan police ",
    observer: "Rajasthan Board of Secondary Education",
    police_escort: "RAJASTHAN POLICE",
  });
  await assert.rejects(
    () =>
      combineOpeningKey(
        split.controlPart,
        [share(split, "superintendent"), share(split, "police_escort")],
        commitments(split),
      ),
    (err: unknown) => err instanceof OpeningKeyError && err.reason === "same_institution_pair",
  );
});

test("the same official twice is not two officials", async () => {
  const { split } = await freshSplit();
  const one = share(split, "superintendent");
  await assert.rejects(
    () => combineOpeningKey(split.controlPart, [one, { ...one }], commitments(split)),
    (err: unknown) => err instanceof OpeningKeyError && err.reason === "duplicate_share",
  );
});

test("a corrupted share is named rather than silently producing a wrong key", async () => {
  const { split } = await freshSplit();
  const bad: FieldShare = {
    ...share(split, "police_escort"),
    share: randomBytes(share(split, "police_escort").share.length),
  };
  await assert.rejects(
    () => combineOpeningKey(split.controlPart, [share(split, "observer"), bad], commitments(split)),
    (err: unknown) =>
      err instanceof OpeningKeyError &&
      err.reason === "share_commitment_mismatch" &&
      err.suspectHolders.includes("police_escort"),
  );
});

test("a tampered control part is caught before reconstruction", async () => {
  const { split } = await freshSplit();
  const tampered = Uint8Array.from(split.controlPart);
  tampered[0] = tampered[0]! ^ 0xff;
  await assert.rejects(
    () =>
      combineOpeningKey(
        tampered,
        [share(split, "superintendent"), share(split, "observer")],
        commitments(split),
      ),
    (err: unknown) => err instanceof OpeningKeyError && err.reason === "control_part_corrupted",
  );
});

test("shares from two different splits of the same packet do not combine", async () => {
  const key = randomBytes(32);
  const first = await splitOpeningKey(key, INSTITUTIONS);
  const second = await splitOpeningKey(key, INSTITUTIONS);
  await assert.rejects(
    () =>
      combineOpeningKey(
        first.controlPart,
        [
          first.fieldShares.find((s) => s.holder === "superintendent")!,
          second.fieldShares.find((s) => s.holder === "observer")!,
        ],
        { controlCommitment: first.controlCommitment, keyCommitment: first.keyCommitment },
      ),
    (err: unknown) => err instanceof OpeningKeyError && err.reason === "reconstruction_mismatch",
  );
});

test("a split refuses to happen without an institution for every holder", async () => {
  await assert.rejects(
    () =>
      splitOpeningKey(randomBytes(32), {
        superintendent: "Kendriya Vidyalaya Jaipur",
        observer: "   ",
        police_escort: "Rajasthan Police",
      }),
    RangeError,
  );
});

test("the key must be 32 bytes", async () => {
  await assert.rejects(() => splitOpeningKey(randomBytes(16), INSTITUTIONS), RangeError);
});

test("no part of the split reveals the key on its own", async () => {
  const { key, split } = await freshSplit();
  const hex = Buffer.from(key).toString("hex");
  for (const part of [split.controlPart, ...split.fieldShares.map((s) => s.share)]) {
    assert.notEqual(Buffer.from(part).toString("hex"), hex);
  }
});
