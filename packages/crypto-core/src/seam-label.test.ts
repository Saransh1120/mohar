import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "@noble/hashes/utils";
import {
  combineScannedPair,
  combineSeamShares,
  encodeSeamQr,
  generateSeamLabel,
  parseSeamQr,
  seamLabelCommitment,
  seamLabelMatches,
  SeamQrFormatError,
  SEAM_SECRET_BYTES,
} from "./seam-label.js";

const HOST = "https://verify.mohar.example";

test("both halves rebuild the secret the label was made with", () => {
  const label = generateSeamLabel();
  assert.deepEqual(combineSeamShares(label.shareA, label.shareB), label.seamSecret);
  assert.deepEqual(combineSeamShares(label.shareB, label.shareA), label.seamSecret);
});

test("one half alone does not satisfy the commitment", () => {
  const label = generateSeamLabel();
  assert.ok(seamLabelMatches(label.seamId, label.seamSecret, label.commitment));
  assert.ok(!seamLabelMatches(label.seamId, label.shareA, label.commitment));
  assert.ok(!seamLabelMatches(label.seamId, label.shareB, label.commitment));
});

test("a tampered share produces a secret that fails the commitment", () => {
  const label = generateSeamLabel();
  const tampered = Uint8Array.from(label.shareB);
  tampered[3] = tampered[3]! ^ 0x01;
  const wrong = combineSeamShares(label.shareA, tampered);
  assert.ok(!seamLabelMatches(label.seamId, wrong, label.commitment));
});

test("the commitment binds the secret to its own seam id", () => {
  const first = generateSeamLabel();
  const second = generateSeamLabel();
  // The right secret under the wrong id is the label-swap attack, and it fails.
  assert.ok(!seamLabelMatches(second.seamId, first.seamSecret, first.commitment));
});

test("the commitment is domain separated from a plain hash of the same bytes", async () => {
  const { sha256 } = await import("@noble/hashes/sha256");
  const { bytesToHex, utf8ToBytes, concatBytes } = await import("@noble/hashes/utils");
  const label = generateSeamLabel();
  const plain = bytesToHex(
    sha256(concatBytes(utf8ToBytes(label.seamId), label.seamSecret)),
  );
  assert.notEqual(label.commitment, plain);
});

test("seam ids differ between labels", () => {
  const ids = new Set(Array.from({ length: 50 }, () => generateSeamLabel().seamId));
  assert.equal(ids.size, 50);
});

test("a QR round trips through encode and parse", () => {
  const label = generateSeamLabel();
  const a = parseSeamQr(encodeSeamQr(HOST, "A", label.seamId, label.shareA));
  const b = parseSeamQr(encodeSeamQr(HOST, "B", label.seamId, label.shareB));
  assert.equal(a.which, "A");
  assert.equal(b.which, "B");
  assert.equal(a.seamId, label.seamId);
  assert.deepEqual(combineScannedPair(a, b).seamSecret, label.seamSecret);
});

test("scanning the two codes in either order gives the same secret", () => {
  const label = generateSeamLabel();
  const a = parseSeamQr(encodeSeamQr(HOST, "A", label.seamId, label.shareA));
  const b = parseSeamQr(encodeSeamQr(HOST, "B", label.seamId, label.shareB));
  assert.deepEqual(combineScannedPair(a, b).seamSecret, combineScannedPair(b, a).seamSecret);
});

test("the share never leaves the URL fragment", () => {
  const label = generateSeamLabel();
  const url = encodeSeamQr(HOST, "A", label.seamId, label.shareA);
  const beforeFragment = url.slice(0, url.indexOf("#"));
  assert.equal(beforeFragment, `${HOST}/s`);
  assert.ok(!beforeFragment.includes(label.seamId));
});

test("scanning the same code twice is refused, and says so", () => {
  const label = generateSeamLabel();
  const a = parseSeamQr(encodeSeamQr(HOST, "A", label.seamId, label.shareA));
  assert.throws(() => combineScannedPair(a, { ...a }), SeamQrFormatError);
});

test("two halves from different packets are refused", () => {
  const first = generateSeamLabel();
  const second = generateSeamLabel();
  const a = parseSeamQr(encodeSeamQr(HOST, "A", first.seamId, first.shareA));
  const b = parseSeamQr(encodeSeamQr(HOST, "B", second.seamId, second.shareB));
  assert.throws(() => combineScannedPair(a, b), SeamQrFormatError);
});

test("a code that is not our shape is refused rather than salvaged", () => {
  const label = generateSeamLabel();
  const good = encodeSeamQr(HOST, "A", label.seamId, label.shareA);
  assert.throws(() => parseSeamQr(`${HOST}/s`), SeamQrFormatError);
  assert.throws(() => parseSeamQr(good.replace("#A.", "#C.")), SeamQrFormatError);
  assert.throws(() => parseSeamQr(good.replace(label.seamId, "not!base32")), SeamQrFormatError);
  assert.throws(() => parseSeamQr(`${good}.extra`), SeamQrFormatError);
});

test("a share of the wrong length is refused", () => {
  const label = generateSeamLabel();
  const short = encodeSeamQr(HOST, "A", label.seamId, randomBytes(SEAM_SECRET_BYTES - 1));
  assert.throws(() => parseSeamQr(short), SeamQrFormatError);
});

test("the seam id is read case-insensitively by the commitment", () => {
  const label = generateSeamLabel();
  assert.equal(
    seamLabelCommitment(label.seamId.toLowerCase(), label.seamSecret),
    label.commitment,
  );
});
