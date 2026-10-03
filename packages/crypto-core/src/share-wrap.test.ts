import { test } from "node:test";
import assert from "node:assert/strict";
import type { webcrypto } from "node:crypto";
import { randomBytes } from "@noble/hashes/utils";
import {
  generateWrapKeypair,
  shareContext,
  ShareUnwrapError,
  unwrapShare,
  unwrapShareWithSecret,
  wrapShare,
} from "./share-wrap.js";

/**
 * The claim under test is "once a share is wrapped to a station, only that
 * station can read it, and only as the share it was wrapped as".
 */

const PKG = "bbbbbbbb-0000-4000-8000-000000000001";
const PERSON = "eeeeeeee-0000-4000-8000-000000000001";
const ctx = shareContext(PKG, "superintendent", PERSON);

test("the station it was wrapped to unwraps it", () => {
  const station = generateWrapKeypair();
  const share = randomBytes(33);
  const wrapped = wrapShare(share, station.publicKeyHex, ctx);
  assert.deepEqual(unwrapShare(wrapped, station.privateKeyHex, ctx), share);
});

test("the ciphertext does not contain the share", () => {
  const station = generateWrapKeypair();
  const share = randomBytes(33);
  const wrapped = wrapShare(share, station.publicKeyHex, ctx);
  assert.equal(wrapped.ciphertextHex.includes(Buffer.from(share).toString("hex")), false);
  // 33 bytes of share and a 16-byte tag.
  assert.equal(wrapped.ciphertextHex.length, (33 + 16) * 2);
});

test("another station cannot unwrap it", () => {
  const station = generateWrapKeypair();
  const other = generateWrapKeypair();
  const wrapped = wrapShare(randomBytes(33), station.publicKeyHex, ctx);
  assert.throws(() => unwrapShare(wrapped, other.privateKeyHex, ctx), ShareUnwrapError);
});

test("a share wrapped for one holder does not open as another's", () => {
  const station = generateWrapKeypair();
  const wrapped = wrapShare(randomBytes(33), station.publicKeyHex, ctx);
  assert.throws(
    () => unwrapShare(wrapped, station.privateKeyHex, shareContext(PKG, "observer", PERSON)),
    ShareUnwrapError,
  );
});

test("a share wrapped for one packet does not open as another packet's", () => {
  const station = generateWrapKeypair();
  const wrapped = wrapShare(randomBytes(33), station.publicKeyHex, ctx);
  const elsewhere = shareContext("cccccccc-0000-4000-8000-000000000009", "superintendent", PERSON);
  assert.throws(() => unwrapShare(wrapped, station.privateKeyHex, elsewhere), ShareUnwrapError);
});

test("a flipped bit in the ciphertext is refused", () => {
  const station = generateWrapKeypair();
  const wrapped = wrapShare(randomBytes(33), station.publicKeyHex, ctx);
  const first = wrapped.ciphertextHex[0] === "0" ? "1" : "0";
  const tampered = { ...wrapped, ciphertextHex: first + wrapped.ciphertextHex.slice(1) };
  assert.throws(() => unwrapShare(tampered, station.privateKeyHex, ctx), ShareUnwrapError);
});

test("wrapping the same share twice gives different ciphertext", () => {
  const station = generateWrapKeypair();
  const share = randomBytes(33);
  const a = wrapShare(share, station.publicKeyHex, ctx);
  const b = wrapShare(share, station.publicKeyHex, ctx);
  assert.notEqual(a.ciphertextHex, b.ciphertextHex);
  assert.notEqual(a.ephemeralPublicHex, b.ephemeralPublicHex);
});

test("a non-extractable WebCrypto key unwraps through its shared secret", async () => {
  // What a browser station does: the private key stays inside WebCrypto, and
  // only the result of the key agreement is handed to this library.
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ])) as webcrypto.CryptoKeyPair;
  const publicHex = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("hex");
  const share = randomBytes(33);
  const wrapped = wrapShare(share, publicHex, ctx);

  const ephemeral = await crypto.subtle.importKey(
    "raw",
    Buffer.from(wrapped.ephemeralPublicHex, "hex"),
    { name: "X25519" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "X25519", public: ephemeral }, pair.privateKey, 256),
  );
  assert.deepEqual(unwrapShareWithSecret(wrapped, shared, publicHex, ctx), share);
  assert.equal(pair.privateKey.extractable, false);
});

test("a malformed recipient key is refused before anything is encrypted", () => {
  assert.throws(() => wrapShare(randomBytes(33), "not-a-key", ctx), RangeError);
});
