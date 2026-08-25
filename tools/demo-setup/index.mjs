#!/usr/bin/env node
/**
 * Build a package the access engine can actually grant.
 *
 *   node tools/demo-setup/index.mjs --lat 26.9124 --lon 75.7873
 *
 * The seeded data cannot be granted, and that is correct rather than broken:
 * every seeded custody window has closed, and two of the five centres were
 * seeded specifically to demonstrate refusal. An engine that granted them would
 * be an engine that had stopped checking.
 *
 * So this makes a fresh centre, package, roster and custody key with an open
 * window, and provisions a station device bound to that centre. Nothing here
 * weakens a check: the geofence radius stays at its default, the custody window
 * is real, and the key expires with the epoch like any other. The one thing you
 * must supply is where you actually are — the centre is registered at those
 * coordinates because the geofence check exists to prove the device is at the
 * centre, and a demo that fudged that would be demonstrating nothing.
 *
 * Read your coordinates off the Ceremony page, which shows the browser's fix.
 */

import pg from "pg";
import { randomUUID, generateKeyPairSync, createHash } from "node:crypto";

const API = process.env["LEDGER_URL"] ?? "http://localhost:8081";
const DB =
  process.env["SEED_DATABASE_URL"] ??
  process.env["DATABASE_URL"] ??
  "postgres://mohar_app:change_me_in_deployment@localhost:5432/mohar";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (k?.startsWith("--")) args.set(k.slice(2), process.argv[i + 1]);
}

const lat = Number(args.get("lat") ?? 26.9124);
const lon = Number(args.get("lon") ?? 75.7873);
const code = args.get("code") ?? "DEMO-01";

if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.error("--lat and --lon must be numbers");
  process.exit(1);
}

const client = new pg.Client({ connectionString: DB });
await client.connect();

const hash = (s) => createHash("sha256").update(s).digest();

function ed25519Keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyHex: privateKey.export({ type: "pkcs8", format: "der" }).subarray(16).toString("hex"),
    publicKeyHex: publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex"),
  };
}

try {
  // ── an exam to hang it off ────────────────────────────────────────────────
  const { rows: authRows } = await client.query("select id from ref.authority limit 1");
  if (!authRows[0]) throw new Error("no authority row — run the seed tool first");

  const examId = randomUUID();
  await client.query(
    `insert into ref.exam (id, authority_id, name, mode, starts_at, drand_round, sides_per_copy)
     values ($1,$2,$3,'digital', now() + interval '2 hours', 1, 12)`,
    [examId, authRows[0].id, `Bench demo — ${new Date().toISOString().slice(0, 16)}`],
  );

  // ── the centre, where you actually are ────────────────────────────────────
  // Default geofence, untouched. If the fix is outside it the engine refuses,
  // which is the check doing its job rather than a setup failure.
  const centreId = randomUUID();
  await client.query(
    `insert into ref.centre (id, exam_id, code, lat, lon, capacity, printers, has_genset, accredited_at)
     values ($1,$2,$3,$4,$5,240,3,true, now())`,
    [centreId, examId, code, lat, lon],
  );

  // ── two officials, on the roster for this centre ──────────────────────────
  // The whole cast the package passes through, not only the two who open it.
  // A journey demonstration needs somebody to hand it over and somebody to
  // receive it at each stage; without them the handoff events have no roles to
  // name and the transport half of the workflow cannot be shown at all.
  const people = [
    { id: randomUUID(), name: "A. Nair", role: "district_officer" },
    { id: randomUUID(), name: "M. Khan", role: "courier" },
    { id: randomUUID(), name: "P. Rao", role: "custodian" },
    { id: randomUUID(), name: "R. Verma", role: "superintendent" },
    { id: randomUUID(), name: "S. Iyer", role: "observer" },
  ];
  for (const p of people) {
    await client.query(
      `insert into ref.person (id, display_name, role, govt_id_hash) values ($1,$2,$3,$4)`,
      [p.id, p.name, p.role, hash(p.id)],
    );
    await client.query(
      `insert into ref.roster (exam_id, centre_id, person_id, valid_from, valid_to)
       values ($1,$2,$3, now() - interval '1 day', now() + interval '30 days')`,
      [examId, centreId, p.id],
    );
  }

  // ── the package, with a window that is open now ───────────────────────────
  const packageId = randomUUID();
  const sealSerial = `SEAL-${code}-${Math.floor(10000 + Math.random() * 89999)}`;
  await client.query(
    `insert into ref.package
       (id, exam_id, centre_id, seal_serial, copies, state, custody_from, custody_to)
     values ($1,$2,$3,$4,240,'at_centre', now() - interval '1 hour', now() + interval '12 hours')`,
    [packageId, examId, centreId, sealSerial],
  );

  // ── the station, bound to this centre ─────────────────────────────────────
  const kp = ed25519Keypair();
  const res = await fetch(`${API}/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "monitor", pubkeyHex: kp.publicKeyHex, centreId }),
  });
  const device = await res.json();
  if (!res.ok) throw new Error(`device enrolment failed: ${JSON.stringify(device)}`);

  // ── the custody key for the unlock stage ──────────────────────────────────
  const keyRes = await fetch(`${API}/keys/issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packageId, stage: "unlock", personId: people[0].id }),
  });
  const issued = await keyRes.json();
  const custodyKey = issued?.key?.key ?? "";

  // ── output ────────────────────────────────────────────────────────────────
  const line = "─".repeat(76);
  console.log();
  console.log(line);
  console.log("  Paste into firmware/arduino-ide/WitnessNode/node_config.h");
  console.log(line);
  console.log();
  console.log(`#define DEVICE_ID       "${device.id}"`);
  console.log(`#define DEVICE_PRIVKEY  "${kp.privateKeyHex}"`);
  console.log(`#define DEVICE_PUBKEY   "${kp.publicKeyHex}"`);
  console.log();
  console.log(`#define EXAM_ID         "${examId}"`);
  console.log(`#define CENTRE_ID       "${centreId}"`);
  console.log(`#define PACKAGE_ID      "${packageId}"`);
  console.log();
  console.log(line);
  console.log();
  console.log(`  centre        ${code} at ${lat}, ${lon} (150 m geofence, untouched)`);
  console.log(`  package       ${packageId}`);
  console.log(`  seal serial   ${sealSerial}`);
  console.log(`  custody       open until ${new Date(Date.now() + 12 * 3600_000).toISOString()}`);
  console.log(`  custody key   ${custodyKey || "(not issued — issue it on the Keys page)"}`);
  console.log();
  console.log("  On the roster for this centre:");
  for (const p of people) console.log(`    ${p.name.padEnd(10)} ${p.role}`);
  console.log();
  console.log("  Still to do, and each one is a check that will otherwise refuse:");
  console.log("    1. Enrol a finger per person on the station (serial: e).");
  console.log("    2. Register both slots on the Slots page against these two people.");
  console.log("    3. On the Ceremony page, enter the seal serial and the custody key.");
  console.log();
  console.log("  The key is printed once and is not stored anywhere.");
  console.log();
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exitCode = 1;
} finally {
  await client.end();
}
