import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkTransferKey,
  generateTransferKey,
  normaliseTransferKey,
  transferKeyFingerprint,
  transferKeyHash,
  transferKeyMatches,
  TRANSFER_KEY_LENGTH,
} from "./transfer-key.js";

const SEAM = "9KQ4M2R7TZ8XA3VB5C6D";
const LEG = "6f0b9c2e-1111-4000-8000-000000000001";
const HOUR = 60 * 60 * 1000;

function issued(expiresInMs = HOUR) {
  return generateTransferKey(SEAM, LEG, new Date(Date.now() + expiresInMs));
}

test("a key is eight characters of Crockford base32", () => {
  for (let i = 0; i < 200; i += 1) {
    const { key } = issued();
    assert.equal(key.length, TRANSFER_KEY_LENGTH);
    assert.match(key, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    // I, L, O and U are the characters people mis-read, and must never appear.
    assert.ok(!/[ILOU]/.test(key));
  }
});

test("keys do not repeat across a run of issues", () => {
  const keys = new Set(Array.from({ length: 500 }, () => issued().key));
  assert.ok(keys.size > 495, `expected near-unique keys, got ${keys.size} of 500`);
});

test("the stored value is a hash, never the key", () => {
  const { key, keyHashHex } = issued();
  assert.match(keyHashHex, /^[0-9a-f]{64}$/);
  assert.ok(!keyHashHex.includes(key.toLowerCase()));
});

test("the right key closes the leg it was issued for", () => {
  const { key, keyHashHex, expiresAt } = issued();
  const result = checkTransferKey(key, { seamId: SEAM, legId: LEG, keyHashHex, expiresAt });
  assert.equal(result.matches, true);
  assert.equal(result.expired, false);
  assert.equal(result.wellFormed, true);
});

test("the same key does not close a different leg", () => {
  const { key, keyHashHex, expiresAt } = issued();
  const otherLeg = "6f0b9c2e-1111-4000-8000-000000000002";
  assert.equal(
    checkTransferKey(key, { seamId: SEAM, legId: otherLeg, keyHashHex, expiresAt }).matches,
    false,
  );
});

test("the same key does not close a leg of a different packet", () => {
  const { key, keyHashHex, expiresAt } = issued();
  const otherSeam = "1AB2CD3EF4GH5JK6MN7P";
  assert.equal(
    checkTransferKey(key, { seamId: otherSeam, legId: LEG, keyHashHex, expiresAt }).matches,
    false,
  );
});

test("case and spacing are forgiven, because refusing for cosmetics teaches the wrong lesson", () => {
  const { key, keyHashHex, expiresAt } = issued();
  const typedAtFourAm = ` ${key.slice(0, 4).toLowerCase()}-${key.slice(4).toLowerCase()} `;
  assert.equal(normaliseTransferKey(typedAtFourAm), key);
  assert.equal(
    checkTransferKey(typedAtFourAm, { seamId: SEAM, legId: LEG, keyHashHex, expiresAt }).matches,
    true,
  );
});

test("an expired key is reported as expired even when it is the right key", () => {
  const { key, keyHashHex, expiresAt } = issued(-HOUR);
  const result = checkTransferKey(key, { seamId: SEAM, legId: LEG, keyHashHex, expiresAt });
  assert.equal(result.matches, true, "the key itself is still the right one");
  assert.equal(result.expired, true, "and it is still too late to use it");
});

test("expiry is judged against the moment asked about", () => {
  const { key, keyHashHex, expiresAt } = issued(HOUR);
  const later = new Date(Date.now() + 2 * HOUR);
  assert.equal(
    checkTransferKey(key, { seamId: SEAM, legId: LEG, keyHashHex, expiresAt }, later).expired,
    true,
  );
});

test("a malformed key is refused and reported as malformed", () => {
  const { keyHashHex, expiresAt } = issued();
  const result = checkTransferKey("ILOU!!", { seamId: SEAM, legId: LEG, keyHashHex, expiresAt });
  assert.equal(result.matches, false);
  assert.equal(result.wellFormed, false);
});

test("a well-formed wrong key is refused but not called malformed", () => {
  const { keyHashHex, expiresAt } = issued();
  const result = checkTransferKey("2H4K6M8P", { seamId: SEAM, legId: LEG, keyHashHex, expiresAt });
  assert.equal(result.matches, false);
  assert.equal(result.wellFormed, true);
});

test("the hash binds key, seam and leg together", () => {
  const key = "2H4K6M8P";
  const base = transferKeyHash(key, SEAM, LEG);
  assert.notEqual(transferKeyHash("2H4K6M8Q", SEAM, LEG), base);
  assert.notEqual(transferKeyHash(key, "1AB2CD3EF4GH5JK6MN7P", LEG), base);
  assert.notEqual(transferKeyHash(key, SEAM, `${LEG.slice(0, -1)}2`), base);
  assert.equal(transferKeyHash(key, SEAM.toLowerCase(), LEG.toUpperCase()), base);
});

test("a mismatched hash length is refused rather than compared", () => {
  assert.equal(transferKeyMatches("2H4K6M8P", SEAM, LEG, "abc"), false);
});

test("the fingerprint is short, stable and not the key", () => {
  const { key, keyHashHex } = issued();
  const fp = transferKeyFingerprint(keyHashHex);
  assert.equal(fp.length, 12);
  assert.ok(keyHashHex.startsWith(fp));
  assert.ok(!fp.toUpperCase().includes(key));
});
