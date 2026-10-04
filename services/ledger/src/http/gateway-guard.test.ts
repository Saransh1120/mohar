import test from "node:test";
import assert from "node:assert/strict";
import { VERIFIED_DEVICE_HEADER, deviceProof, stationProof } from "./gateway-guard.js";

/**
 * ── What an engine may say about who signed a request ───────────────────────
 *
 * The gateway verifies the signature; the engine records that it was verified.
 * These are the four things the engine can truthfully say, and when.
 */

const DEVICE = "9f364af2-6a0a-4c36-8478-a68c93a030ec";
const OTHER = "08b60b3e-3214-46ad-ad1f-2208488739ea";
const SECRET = { GATEWAY_SECRET: "shared-between-the-two" };

test("no header: the ledger was reached directly or the route took a session, and nothing is claimed", () => {
  const p = deviceProof({}, SECRET, DEVICE);
  assert.equal(p.passed, undefined);
  assert.match(p.evidence, /^not evaluated/);
});

test("a header on a ledger that shares no secret with its gateway is not believed", () => {
  const p = deviceProof({ [VERIFIED_DEVICE_HEADER]: DEVICE }, {}, DEVICE);
  assert.equal(p.passed, undefined, "any process on the machine could have written it");
  assert.match(p.evidence, /cannot tell it from another process/);
});

test("from the gateway, for the device the request names: verified", () => {
  const p = deviceProof({ [VERIFIED_DEVICE_HEADER]: DEVICE.toUpperCase() }, SECRET, DEVICE);
  assert.equal(p.passed, true);
  assert.match(p.evidence, /enrolled key/);
});

test("from the gateway, for a different device than the request names: refused, naming both", () => {
  const p = deviceProof({ [VERIFIED_DEVICE_HEADER]: OTHER }, SECRET, DEVICE);
  assert.equal(p.passed, false);
  assert.ok(p.evidence.includes(OTHER) && p.evidence.includes(DEVICE));
});

test("an empty or repeated header is treated as no header", () => {
  assert.equal(deviceProof({ [VERIFIED_DEVICE_HEADER]: "" }, SECRET, DEVICE).passed, undefined);
  assert.equal(deviceProof({ [VERIFIED_DEVICE_HEADER]: [DEVICE, OTHER] }, SECRET, DEVICE).passed, undefined);
});

test("a later opening step is held to the station that began the ceremony", () => {
  const own = stationProof({ [VERIFIED_DEVICE_HEADER]: DEVICE }, SECRET, DEVICE);
  assert.equal(own.passed, true);
  assert.match(own.evidence, /began this ceremony/);
  const other = stationProof({ [VERIFIED_DEVICE_HEADER]: OTHER }, SECRET, DEVICE);
  assert.equal(other.passed, false);
  assert.ok(other.evidence.includes(OTHER) && other.evidence.includes(DEVICE));
});

test("with no station on record, or no way to believe the header, nothing is claimed about a later step", () => {
  assert.equal(stationProof({ [VERIFIED_DEVICE_HEADER]: DEVICE }, SECRET, null).passed, undefined);
  assert.equal(stationProof({ [VERIFIED_DEVICE_HEADER]: OTHER }, {}, DEVICE).passed, undefined);
  assert.equal(stationProof({}, SECRET, DEVICE).passed, undefined);
});
