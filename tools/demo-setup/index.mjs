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

/**
 * ── Reuse an existing centre ─────────────────────────────────────────────────
 *
 *   node tools/demo-setup/index.mjs --centre <centre-id> [--lat .. --lon ..]
 *
 * Adds a fresh package with an open window to a centre that already has a
 * station flashed and bound to it, so a new demo does not mean reflashing the
 * ESP32 with a new device identity. The station, its binding and its key are
 * left exactly as they are.
 *
 * Two things are refreshed, and both are said out loud when they happen:
 *  - the roster's end date, if it runs out within the next day, because an
 *    expired roster refuses every ceremony for `person_not_on_roster`;
 *  - the centre's coordinates, only if --lat and --lon are both given, for when
 *    the demo moves to a different building. The geofence radius is not touched.
 */
async function addPackageToCentre(centreId) {
  const { rows: cRows } = await client.query(
    "select id, exam_id, code, lat, lon from ref.centre where id = $1",
    [centreId],
  );
  const centre = cRows[0];
  if (!centre) throw new Error(`no centre ${centreId}`);

  if (args.has("lat") && args.has("lon")) {
    await client.query("update ref.centre set lat = $2, lon = $3 where id = $1", [centreId, lat, lon]);
    console.log(`\n  centre moved to ${lat}, ${lon} (was ${centre.lat}, ${centre.lon})`);
    centre.lat = lat;
    centre.lon = lon;
  }

  const { rowCount: extended } = await client.query(
    `update ref.roster set valid_to = now() + interval '30 days'
      where centre_id = $1 and valid_to < now() + interval '1 day'`,
    [centreId],
  );
  if (extended) console.log(`  roster end date extended for ${extended} person(s)`);

  const { rows: roster } = await client.query(
    `select p.id, p.display_name, p.role
       from ref.roster r join ref.person p on p.id = r.person_id
      where r.centre_id = $1 and now() between r.valid_from and r.valid_to
      order by p.role`,
    [centreId],
  );
  if (roster.length === 0) throw new Error("nobody is on this centre's roster");

  // One package per exam and centre is a schema rule. If the centre already has
  // one — which it will, since the station was flashed for it — reopen its
  // custody window rather than making another. That keeps the PACKAGE_ID the
  // firmware already carries, so nothing has to be reflashed. A package that
  // has been opened or marked compromised is not reopened: that would be
  // rewriting the one fact the demo exists to protect.
  const { rows: existing } = await client.query(
    "select id, seal_serial, state from ref.package where exam_id = $1 and centre_id = $2",
    [centre.exam_id, centreId],
  );
  let packageId, sealSerial;
  if (existing[0]) {
    const p = existing[0];
    if (p.state === "opened" || p.state === "compromised") {
      throw new Error(
        `package ${p.id} at this centre is ${p.state} and will not be reopened — ` +
          "run without --centre to make a fresh centre instead",
      );
    }
    await client.query(
      `update ref.package
          set custody_from = now() - interval '1 hour',
              custody_to   = now() + interval '12 hours',
              updated_at   = now()
        where id = $1`,
      [p.id],
    );
    packageId = p.id;
    sealSerial = p.seal_serial;
    console.log(`\n  reopened the custody window on existing package ${p.id} (${p.state})`);
  } else {
    packageId = randomUUID();
    sealSerial = `SEAL-${centre.code}-${Math.floor(10000 + Math.random() * 89999)}`;
    await client.query(
      `insert into ref.package
         (id, exam_id, centre_id, seal_serial, copies, state, custody_from, custody_to)
       values ($1,$2,$3,$4,240,'at_centre', now() - interval '1 hour', now() + interval '12 hours')`,
      [packageId, centre.exam_id, centreId, sealSerial],
    );
  }

  // No custody key is issued here. A key's plaintext is handed out once per
  // six-hour window, to whoever issues it first — and if that is this script,
  // the Live Demo's one-click run has to be told the key by hand. Leaving it
  // unissued means the run issues it itself and never has to ask.

  const { rows: devs } = await client.query(
    `select id, kind from ref.device where centre_id = $1 and revoked_at is null order by kind`,
    [centreId],
  );

  const line = "─".repeat(76);
  console.log();
  console.log(line);
  console.log("  In firmware/arduino-ide/WitnessNode/node_config.h, change only this line:");
  console.log(line);
  console.log();
  console.log(`#define PACKAGE_ID      "${packageId}"`);
  console.log();
  console.log(line);
  console.log();
  console.log(`  centre        ${centre.code} at ${centre.lat}, ${centre.lon}`);
  console.log(`  package       ${packageId}`);
  console.log(`  seal serial   ${sealSerial}`);
  console.log(`  custody       open until ${new Date(Date.now() + 12 * 3600_000).toISOString()}`);
  console.log("  custody key   not issued — the Live Demo's Run full demo issues it itself");
  console.log();
  console.log("  On the roster:");
  for (const p of roster) console.log(`    ${p.display_name.padEnd(10)} ${p.role}`);
  console.log();
  console.log("  Stations bound to this centre:");
  for (const d of devs) console.log(`    ${d.kind.padEnd(10)} ${d.id}`);
  console.log();
}

const reuseCentre = args.get("centre");
if (reuseCentre) {
  try {
    await addPackageToCentre(reuseCentre);
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
  process.exit(process.exitCode ?? 0);
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
