import test from "node:test";
import assert from "node:assert/strict";
import { utf8ToBytes } from "@noble/hashes/utils";
import { generateKeypair, signBody, verifyBodySignature } from "./signing.js";
import {
  REQUEST_SIGNATURE_HEADERS,
  requestSigningBytes,
  signRequest,
  signedRequestHeaders,
  verifyRequestSignature,
  type SignableRequest,
} from "./request-signature.js";

const kp = generateKeypair();
const body = utf8ToBytes('{"deviceId":"d","packetSerialTyped":"PKT-1"}');

function request(over: Partial<SignableRequest> = {}): SignableRequest {
  return {
    method: "POST",
    path: "/legs/7d0e/dispatch",
    timestamp: "2026-10-02T09:30:00.000Z",
    nonce: "00112233445566778899aabbccddeeff",
    body,
    ...over,
  };
}

test("a request signed by a key verifies under that key and no other", () => {
  const sig = signRequest(request(), kp.privateKeyHex);
  assert.equal(verifyRequestSignature(request(), sig, kp.publicKeyHex), true);
  assert.equal(verifyRequestSignature(request(), sig, generateKeypair().publicKeyHex), false);
});

test("every signed field is bound: changing any one of them breaks the signature", () => {
  const sig = signRequest(request(), kp.privateKeyHex);
  const changed: Partial<SignableRequest>[] = [
    { method: "GET" },
    { path: "/legs/7d0e/receive" },
    { path: "/legs/7d0e/dispatch?x=1" },
    { timestamp: "2026-10-02T09:30:01.000Z" },
    { nonce: "ffeeddccbbaa99887766554433221100" },
    { body: utf8ToBytes('{"deviceId":"d","packetSerialTyped":"PKT-2"}') },
    { body: new Uint8Array(0) },
  ];
  for (const c of changed) {
    assert.equal(
      verifyRequestSignature(request(c), sig, kp.publicKeyHex),
      false,
      `still verified after changing ${Object.keys(c).join(",")}`,
    );
  }
});

test("the method is compared upper case, so post and POST are one request", () => {
  const sig = signRequest(request({ method: "post" }), kp.privateKeyHex);
  assert.equal(verifyRequestSignature(request(), sig, kp.publicKeyHex), true);
});

test("a request signature is not an event signature, and the other way round", () => {
  // The same key signs both. What is signed must not overlap, or a captured
  // request could be replayed into the chain as an event.
  const asRequest = signRequest(request(), kp.privateKeyHex);
  const event = { v: 1, kind: "HANDOFF_DISPATCHED" };
  assert.equal(verifyBodySignature(event, asRequest, kp.publicKeyHex), false);
  const asEvent = signBody(event, kp.privateKeyHex);
  assert.equal(verifyRequestSignature(request(), asEvent, kp.publicKeyHex), false);
  assert.notEqual(requestSigningBytes(request())[0], "{".charCodeAt(0));
});

test("garbage in the signature or the key is a clean false, never a throw", () => {
  assert.equal(verifyRequestSignature(request(), "not hex", kp.publicKeyHex), false);
  assert.equal(verifyRequestSignature(request(), "", kp.publicKeyHex), false);
  const sig = signRequest(request(), kp.privateKeyHex);
  assert.equal(verifyRequestSignature(request(), sig, "abcd"), false);
});

test("signedRequestHeaders produces four headers that verify against the body sent", () => {
  const sent = '{"deviceId":"d"}';
  const now = new Date("2026-10-02T09:30:00.000Z");
  const h = signedRequestHeaders(
    "device-1",
    kp.privateKeyHex,
    { method: "POST", path: "/rooms/r/entry", body: sent },
    now,
  );
  assert.equal(h[REQUEST_SIGNATURE_HEADERS.device], "device-1");
  assert.equal(h[REQUEST_SIGNATURE_HEADERS.timestamp], now.toISOString());
  assert.match(h[REQUEST_SIGNATURE_HEADERS.nonce]!, /^[0-9a-f]{32}$/);
  assert.equal(
    verifyRequestSignature(
      {
        method: "POST",
        path: "/rooms/r/entry",
        timestamp: h[REQUEST_SIGNATURE_HEADERS.timestamp]!,
        nonce: h[REQUEST_SIGNATURE_HEADERS.nonce]!,
        body: utf8ToBytes(sent),
      },
      h[REQUEST_SIGNATURE_HEADERS.signature]!,
      kp.publicKeyHex,
    ),
    true,
  );
});

test("two requests signed in the same millisecond carry different nonces", () => {
  const now = new Date();
  const a = signedRequestHeaders("d", kp.privateKeyHex, { method: "GET", path: "/legs" }, now);
  const b = signedRequestHeaders("d", kp.privateKeyHex, { method: "GET", path: "/legs" }, now);
  assert.notEqual(a[REQUEST_SIGNATURE_HEADERS.nonce], b[REQUEST_SIGNATURE_HEADERS.nonce]);
});
