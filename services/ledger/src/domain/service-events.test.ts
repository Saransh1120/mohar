import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { generateKeypair, publicKeyHexOf } from "@mohar/crypto-core";

/**
 * ── The ledger's signing identity ────────────────────────────────────────────
 *
 * The key is read once per process, so each case loads the module afresh under
 * its own environment. What the module does against a real chain is exercised
 * by tools/e2e/journey.mjs.
 */

type ServiceEvents = typeof import("./service-events.js");

async function loadWith(key: string | undefined, tag: string): Promise<ServiceEvents> {
  if (key === undefined) delete process.env["LEDGER_SERVICE_KEY"];
  else process.env["LEDGER_SERVICE_KEY"] = key;
  const spec = `./service-events.js?${tag}`;
  return (await import(spec)) as ServiceEvents;
}

/** A transaction that fails the test if anything is asked of it. */
const untouched = {
  query: () => {
    throw new Error("the database was touched");
  },
} as unknown as PoolClient;

test("a configured key is the service's identity across restarts", async () => {
  const key = generateKeypair();
  const a = await loadWith(key.privateKeyHex, "configured-a");
  const b = await loadWith(key.privateKeyHex, "configured-b");
  assert.equal(a.servicePublicKeyHex(), publicKeyHexOf(key.privateKeyHex));
  assert.equal(b.servicePublicKeyHex(), a.servicePublicKeyHex());
});

test("with no key configured, each process makes its own", async () => {
  const a = await loadWith(undefined, "generated-a");
  const b = await loadWith(undefined, "generated-b");
  assert.match(a.servicePublicKeyHex() ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(a.servicePublicKeyHex(), b.servicePublicKeyHex());
});

test("a malformed key signs nothing, says why, and does not stop the engine", async () => {
  const m = await loadWith("not-a-key", "malformed");
  assert.equal(m.servicePublicKeyHex(), null);
  const outcome = await m.appendServiceEvent(untouched, {
    kind: "DWELL_EXCEEDED",
    examId: "00000000-0000-4000-8000-000000000001",
    payload: {
      visitId: "00000000-0000-4000-8000-000000000002",
      roomId: "00000000-0000-4000-8000-000000000003",
      dwellSeconds: 900,
      expectedSeconds: 240,
    },
  });
  assert.equal(outcome.recorded, false);
  assert.match(outcome.recorded ? "" : outcome.reason, /LEDGER_SERVICE_KEY/);
});

test("a check that was not run is written as not evaluated, never as passed", async () => {
  const m = await loadWith(undefined, "lines");
  const lines = m.checkLines([
    { check: "leg_known", passed: true, evidence: "leg 1" },
    { check: "packet_serial", passed: undefined, evidence: "the serial is typed by the receiver" },
    { check: "transfer_key", passed: false, evidence: "x".repeat(400) },
  ]);
  assert.equal(lines[0], "leg_known: passed. leg 1");
  assert.match(lines[1] ?? "", /^packet_serial: not evaluated\./);
  assert.match(lines[2] ?? "", /^transfer_key: failed\./);
  assert.ok(lines.every((l) => l.length <= 280));
});
