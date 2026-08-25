#!/usr/bin/env node
/**
 * Provision one ESP32 and print the header block to paste into its firmware.
 *
 *   node tools/provision-device/index.mjs --kind monitor
 *   node tools/provision-device/index.mjs --kind monitor --centre JPR-001
 *
 * What it does, in order:
 *
 *   1. generates an Ed25519 keypair on this machine;
 *   2. enrols the PUBLIC half with `POST /devices`, which returns the device id;
 *   3. prints the private half exactly once, formatted as C defines.
 *
 * The private key is never sent anywhere and never written to disk by this
 * script. If you lose it, revoke the device with `POST /devices/:id/revoke` and
 * provision a new one — that is cheaper than any recovery mechanism would be,
 * and a recovery mechanism is itself a way to steal a device identity.
 *
 * Zero dependencies on purpose: `node:crypto` can do Ed25519, and a provisioning
 * step that runs before `pnpm install` has finished is one less thing that can
 * go wrong on the morning of a deployment.
 */

import { generateKeyPairSync } from "node:crypto";

const LEDGER = process.env["LEDGER_URL"] ?? "http://localhost:8081";

// ── arguments ───────────────────────────────────────────────────────────────

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (!k?.startsWith("--")) continue;
  args.set(k.slice(2), process.argv[i + 1]);
}

const kind = args.get("kind") ?? "monitor";
const centreCode = args.get("centre");
const examName = args.get("exam");

if (!["monitor", "field", "centre_pc", "service"].includes(kind)) {
  console.error(`--kind must be one of monitor, field, centre_pc, service (got "${kind}")`);
  process.exit(1);
}

// ── keys ────────────────────────────────────────────────────────────────────

/**
 * Ed25519 keys, as raw 32-byte values.
 *
 * Node hands them over in DER wrappers. Both the PKCS#8 private key and the SPKI
 * public key put the 32 raw bytes at the very end of a fixed-length prefix for
 * this curve, so slicing the tail is exact rather than a heuristic — and the
 * assertion below catches it if a future Node version changes the encoding.
 */
function ed25519Keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const spki = publicKey.export({ type: "spki", format: "der" });

  if (pkcs8.length !== 48 || spki.length !== 44) {
    throw new Error(
      `unexpected DER lengths (${pkcs8.length}/${spki.length}); refusing to guess at the key bytes`,
    );
  }
  return {
    privateKeyHex: pkcs8.subarray(16).toString("hex"),
    publicKeyHex: spki.subarray(12).toString("hex"),
  };
}

// ── ledger ──────────────────────────────────────────────────────────────────

async function get(path) {
  const res = await fetch(`${LEDGER}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function resolveCentre() {
  if (!centreCode) return undefined;
  const { centres } = await get("/centres");
  const match = centres.find((c) => c.code === centreCode || c.id === centreCode);
  if (!match) {
    console.error(`No centre "${centreCode}". Known codes: ${centres.map((c) => c.code).join(", ")}`);
    process.exit(1);
  }
  return match;
}

async function resolveExam() {
  const { exams } = await get("/exams");
  if (exams.length === 0) return undefined;
  if (!examName) return exams[0];
  const match = exams.find((e) => e.name === examName || e.id === examName);
  if (!match) {
    console.error(`No exam "${examName}". Known: ${exams.map((e) => e.name).join(", ")}`);
    process.exit(1);
  }
  return match;
}

async function enrol(pubkeyHex, centreId) {
  const res = await fetch(`${LEDGER}/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, pubkeyHex, ...(centreId ? { centreId } : {}) }),
  });
  const body = await res.json();
  if (res.status === 409) {
    // Refusing a duplicate public key is the ledger doing its job: one key
    // enrolled as two devices would let a single board sign as both parties to
    // a two-person act.
    console.error("That public key is already enrolled. Generate a fresh one.");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Enrolment failed (${res.status}): ${JSON.stringify(body)}`);
    process.exit(1);
  }
  return body;
}

// ── output ──────────────────────────────────────────────────────────────────

const NIL = "00000000-0000-4000-8000-000000000000";

function printBlock({ device, keys, centre, exam }) {
  const line = "─".repeat(74);
  console.log();
  console.log(line);
  console.log("  Paste into src/monitor_config.h or src/station_config.h");
  console.log(line);
  console.log();
  console.log(`#define DEVICE_ID       "${device.id}"`);
  console.log(`#define DEVICE_PRIVKEY  "${keys.privateKeyHex}"`);
  console.log(`#define DEVICE_PUBKEY   "${keys.publicKeyHex}"`);
  console.log();
  console.log(`#define EXAM_ID         "${exam?.id ?? NIL}"`);
  console.log(`#define CENTRE_ID       "${centre?.id ?? NIL}"`);
  console.log();
  console.log(line);
  console.log();
  console.log(`  kind        ${device.kind}`);
  console.log(`  exam        ${exam ? exam.name : "none found — pass --exam"}`);
  console.log(`  centre      ${centre ? `${centre.code} (${centre.name ?? ""})` : "not bound"}`);
  console.log(`  ledger      ${LEDGER}`);
  console.log();
  console.log("  The private key is printed once and is not stored anywhere.");
  console.log("  Copy it now. To retire this device:");
  console.log(`    curl -X POST ${LEDGER}/devices/${device.id}/revoke`);
  console.log();
}

// ── main ────────────────────────────────────────────────────────────────────

try {
  const keys = ed25519Keypair();
  const centre = await resolveCentre();
  const exam = await resolveExam();
  const device = await enrol(keys.publicKeyHex, centre?.id);
  printBlock({ device, keys, centre, exam });
} catch (err) {
  console.error(`\n${err.message}`);
  console.error(`Is the ledger running at ${LEDGER}? See RUNNING.md.`);
  process.exit(1);
}
