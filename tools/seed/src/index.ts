#!/usr/bin/env node
/**
 * Seeds a pilot-shaped dataset and drives it through the real custody workflow.
 *
 * Reference data goes in over a direct Postgres connection; every custody event
 * goes in through `POST /events` as a properly signed body, exactly as a field
 * app would send it. Nothing here writes to `led.event` directly — if the ledger
 * would reject an event from a real device, it rejects it from this tool too,
 * which is the only way seeding is worth anything as a test.
 *
 * The five centres are chosen to cover the paths the control room has to handle:
 * one clean run, and four different ways custody goes wrong.
 *
 *   Usage:  node dist/index.js
 */

import pg from "pg";
import { randomUUID } from "node:crypto";
import { generateKeypair, signBody } from "@mohar/crypto-core";
import type { EventBody, PackageState, PersonRole } from "@mohar/contracts";

const API = process.env["LEDGER_URL"] ?? "http://localhost:8081";
const DB =
  process.env["SEED_DATABASE_URL"] ??
  process.env["DATABASE_URL"] ??
  "postgres://mohar_app:change_me_in_deployment@localhost:5432/mohar";

const client = new pg.Client({ connectionString: DB });

// ── helpers ─────────────────────────────────────────────────────────────────

/** RFC 3339 UTC with exactly 3 fractional digits — what `Timestamp` demands. */
const ts = (d: Date): string => d.toISOString();
const minutes = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);

/** SHA-256 hex of a string, for the photo hashes the payloads require. */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Device {
  id: string;
  privateKeyHex: string;
}

async function enrolDevice(kind: string, centreId?: string): Promise<Device> {
  const kp = generateKeypair();
  const res = await fetch(`${API}/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, pubkeyHex: kp.publicKeyHex, ...(centreId ? { centreId } : {}) }),
  });
  if (!res.ok) throw new Error(`enrol ${kind} failed: ${res.status} ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  return { id, privateKeyHex: kp.privateKeyHex };
}

interface EmitResult {
  status: string;
  seq?: string;
  [k: string]: unknown;
}

/**
 * Sign and post one event. Fails loudly: a rejected event during seeding means
 * the seed data is wrong or the ledger's rules changed, and silently continuing
 * would leave a chain that does not represent anything.
 */
async function emit(
  body: EventBody,
  signer: Device,
  cosigner?: Device,
): Promise<EmitResult> {
  const payload: Record<string, unknown> = {
    body,
    deviceSig: signBody(body, signer.privateKeyHex),
  };
  if (cosigner) {
    payload["cosignDeviceId"] = cosigner.id;
    payload["cosignSig"] = signBody(body, cosigner.privateKeyHex);
  }
  const res = await fetch(`${API}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const out = (await res.json()) as EmitResult;
  if (res.status >= 400) {
    throw new Error(`event ${body.kind} rejected (${res.status}): ${JSON.stringify(out)}`);
  }
  return out;
}

interface IssuedKey {
  id: string;
  fingerprint: string;
  epoch: number;
  /** Returned exactly once, by the issuing call. Never retrievable again. */
  key: string;
}

/** Ask the service to mint the custody key for one stage of one package. */
async function issueKey(
  packageId: string,
  stage: string,
  personId?: string,
  epoch?: number,
): Promise<IssuedKey> {
  // A specific past epoch is only reachable directly, because the API will not
  // mint a key that is already expired — which is the correct refusal, and the
  // reason this back door exists only in the seeder.
  if (epoch !== undefined) {
    const { rows } = await client.query(
      `select k.id from led.access_key k where k.package_id=$1 and k.stage=$2 and k.epoch=$3`,
      [packageId, stage, epoch],
    );
    if (rows[0]) throw new Error("stale key already minted for this epoch");
    return mintStaleKey(packageId, stage, epoch, personId);
  }

  const res = await fetch(`${API}/keys/issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packageId, stage, ...(personId ? { personId } : {}) }),
  });
  if (!res.ok) throw new Error(`key issue failed: ${res.status} ${await res.text()}`);
  const { key } = (await res.json()) as { key: IssuedKey };
  if (!key.key) throw new Error("issue response carried no plaintext key");
  return key;
}

/**
 * Mint a key directly into a past epoch, bypassing the API.
 *
 * This exists solely so the seeder can demonstrate what a stale credential looks
 * like when it reaches the engine. It is the one place in this tool that writes
 * a security record without going through the service, and it is confined to
 * epochs that are already expired so it cannot manufacture working access.
 */
async function mintStaleKey(
  packageId: string,
  stage: string,
  epoch: number,
  personId?: string,
): Promise<IssuedKey> {
  const { generateCustodyKey, epochWindow } = await import("@mohar/crypto-core");
  const { key, keyHashHex, fingerprint } = generateCustodyKey(stage);
  const { validFrom, validTo } = epochWindow(epoch);
  const { rows: stageRows } = await client.query(
    "select expected_role from led.custody_stage where stage = $1",
    [stage],
  );
  const { rows } = await client.query(
    `insert into led.access_key
       (package_id, stage, epoch, key_hash, fingerprint,
        issued_to_person, issued_to_role, valid_from, valid_to)
     values ($1,$2,$3, decode($4,'hex'), $5, $6, $7, $8, $9)
     returning id`,
    [
      packageId, stage, epoch, keyHashHex, fingerprint,
      personId ?? null, stageRows[0].expected_role, validFrom, validTo,
    ],
  );
  return { id: rows[0].id, fingerprint, epoch, key };
}

interface Decision {
  outcome: "granted" | "denied";
  sessionId: string;
  denyReasons: string[];
  checksPassed: string[];
  checks: { check: string; passed: boolean; evidence: string }[];
}

/** Submit a request to the real engine and take whatever it rules. */
async function requestAccess(input: {
  packageId: string;
  stage: string;
  presentedKey?: string | undefined;
  deviceId: string;
  personId?: string;
  sealSerialRead?: string | undefined;
  geo?: { lat: number; lon: number; accuracyM: number };
}): Promise<Decision> {
  const res = await fetch(`${API}/access/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, sessionId: randomUUID() }),
  });
  if (!res.ok) throw new Error(`access request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Decision;
}

/**
 * The engine's deny codes are finer-grained than the contract's `DenyReason`
 * enum, which is a closed set so denials can be aggregated across a state-wide
 * sweep. Map onto it for the signed event; the engine's full set is preserved
 * verbatim on the access-attempt record, so nothing is lost.
 */
const DENY_MAP: Record<string, string> = {
  key_not_presented: "seal_photo_missing",
  key_unknown: "package_state_unexpected",
  key_expired: "assertion_stale",
  key_not_yet_valid: "assertion_stale",
  key_revoked: "device_revoked",
  key_wrong_stage: "package_state_unexpected",
  key_wrong_package: "package_state_unexpected",
  device_unknown: "device_unknown",
  device_revoked: "device_revoked",
  device_not_bound_to_centre: "device_attestation_invalid",
  person_not_on_roster: "person_not_on_roster",
  person_role_not_permitted: "person_role_not_permitted",
  outside_geofence: "outside_geofence",
  geo_missing: "geo_missing",
  geo_accuracy_insufficient: "geo_accuracy_insufficient",
  outside_custody_window: "outside_custody_window",
  clock_skew_excessive: "clock_skew_excessive",
  seal_serial_mismatch: "seal_serial_mismatch",
  seal_serial_not_read: "seal_photo_missing",
  package_compromised: "package_compromised",
  package_already_opened: "package_already_opened",
  package_state_unexpected: "package_state_unexpected",
  exam_suspended: "exam_suspended",
};

function mapDenyReasons(codes: string[]): string[] {
  const mapped = codes.map((c) => DENY_MAP[c] ?? "package_state_unexpected");
  return [...new Set(mapped)];
}

// ── reference data ──────────────────────────────────────────────────────────

interface Centre {
  id: string;
  code: string;
  lat: number;
  lon: number;
  packageId: string;
  sealSerial: string;
}

/** Five centres around Jaipur, spread far enough apart to be distinct on a map. */
const CENTRE_SPECS = [
  { code: "JPR-001", lat: 26.9124, lon: 75.7873, capacity: 240, printers: 3 },
  { code: "JPR-002", lat: 26.8505, lon: 75.8054, capacity: 180, printers: 2 },
  { code: "JPR-003", lat: 26.9855, lon: 75.7500, capacity: 300, printers: 4 },
  { code: "JPR-004", lat: 26.8800, lon: 75.6900, capacity: 150, printers: 2 },
  { code: "JPR-005", lat: 26.9400, lon: 75.8600, capacity: 200, printers: 3 },
];

const PERSON_SPECS: { name: string; role: PersonRole }[] = [
  { name: "A. Sharma", role: "district_officer" },
  { name: "R. Verma", role: "courier" },
  { name: "S. Iyer", role: "courier" },
  { name: "M. Khan", role: "custodian" },
  { name: "P. Nair", role: "custodian" },
  { name: "K. Reddy", role: "superintendent" },
  { name: "L. Bose", role: "observer" },
  { name: "T. Gupta", role: "control_room" },
];

async function seedReferenceData(examStart: Date) {
  await client.query("begin");

  const { rows: auth } = await client.query(
    "insert into ref.authority (name) values ($1) returning id",
    [`Rajasthan Examination Board (pilot ${Date.now()})`],
  );
  const authorityId = auth[0].id as string;

  const { rows: exam } = await client.query(
    `insert into ref.exam (authority_id, name, mode, starts_at, drand_round, sides_per_copy)
     values ($1,$2,'digital',$3,$4,$5) returning id`,
    [authorityId, "State Services Prelim 2026 — Paper I", examStart, 4_500_000, 12],
  );
  const examId = exam[0].id as string;

  const centres: Centre[] = [];
  for (const spec of CENTRE_SPECS) {
    const { rows } = await client.query(
      `insert into ref.centre (exam_id, code, lat, lon, capacity, printers, has_genset, accredited_at)
       values ($1,$2,$3,$4,$5,$6,true,now()) returning id`,
      [examId, spec.code, spec.lat, spec.lon, spec.capacity, spec.printers],
    );
    const centreId = rows[0].id as string;
    const sealSerial = `SEAL-${spec.code}-${Math.floor(Math.random() * 90000 + 10000)}`;

    // The custody window opens 3h before the exam (T-180m in the runbook) and
    // closes at the start bell.
    const { rows: pkg } = await client.query(
      `insert into ref.package
         (exam_id, centre_id, seal_serial, copies, state, custody_from, custody_to)
       values ($1,$2,$3,$4,'sealed',$5,$6) returning id`,
      [examId, centreId, sealSerial, spec.capacity, minutes(examStart, -180), examStart],
    );

    centres.push({
      id: centreId,
      code: spec.code,
      lat: spec.lat,
      lon: spec.lon,
      packageId: pkg[0].id as string,
      sealSerial,
    });
  }

  const persons: Record<string, string> = {};
  for (const p of PERSON_SPECS) {
    const { rows } = await client.query(
      `insert into ref.person (display_name, role, govt_id_hash)
       values ($1,$2,digest($3,'sha256')) returning id`,
      [p.name, p.role, `govt-id-${p.name}`],
    );
    persons[p.name] = rows[0].id as string;
  }

  // Roster: superintendent and observer are authorised at every centre for the
  // custody window. The access engine will check membership against this.
  for (const c of centres) {
    for (const name of ["K. Reddy", "L. Bose", "M. Khan"]) {
      await client.query(
        `insert into ref.roster (exam_id, centre_id, person_id, valid_from, valid_to)
         values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [examId, c.id, persons[name], minutes(examStart, -240), minutes(examStart, 120)],
      );
    }
  }

  await client.query("commit");
  return { examId, centres, persons };
}

// ── the custody workflow ────────────────────────────────────────────────────

async function main() {
  await client.connect();

  // There is deliberately no --reset. `led.event.actor_device` is a foreign key
  // into `ref.device`, and led.event grants no DELETE to anyone, so a device
  // that has ever signed an event cannot be removed — and neither can the centre
  // it was enrolled against. That is the append-only guarantee reaching back
  // into reference data, and working around it here would mean seeding through
  // a privilege the real system does not have. Each run therefore adds a new
  // exam alongside the previous ones, which is also what a second pilot would do.
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`Cannot reach the ledger at ${API}. Start it first.`);
    process.exit(1);
  }

  // The exam starts five minutes from now.
  //
  // This is not cosmetic. The engine evaluates the roster and the custody window
  // against real wall-clock time, so a scenario set hours in the future would be
  // refused for `outside_custody_window` on every centre — correctly, but that
  // refusal would drown the specific ones each centre is meant to demonstrate.
  // Placing the start just ahead of now puts the whole run inside a live custody
  // window, so the only refusals are the ones being illustrated.
  const examStart = minutes(new Date(), 5);
  console.log(`Seeding pilot exam starting ${ts(examStart)}\n`);

  const { examId, centres, persons } = await seedReferenceData(examStart);
  console.log(`  exam ${examId} with ${centres.length} centres\n`);

  // Devices. One service key for backend-derived events, one per courier and
  // per centre. Two-person acts need two distinct devices, which is the whole
  // reason the observer carries their own.
  console.log("enrolling devices…");
  const svc = await enrolDevice("service");
  const courierA = await enrolDevice("field");
  const courierB = await enrolDevice("field");
  const custodian = await enrolDevice("field");
  const observer = await enrolDevice("field");
  const centrePCs: Record<string, Device> = {};
  for (const c of centres) centrePCs[c.code] = await enrolDevice("centre_pc", c.id);
  console.log(`  ${5 + centres.length} devices enrolled\n`);

  // Which six-hour window we are in. Keys are scoped to it, so a key minted for
  // an earlier epoch is already dead by arithmetic — no expiry job involved.
  const epochRes = await fetch(`${API}/access/epoch`);
  const { epoch: currentEpoch, endsAt } = (await epochRes.json()) as {
    epoch: number;
    endsAt: string;
  };
  const minsLeft = Math.round((Date.parse(endsAt) - Date.now()) / 60_000);
  console.log(`custody key epoch ${currentEpoch} — rotates in ${minsLeft} minutes\n`);

  const base = {
    v: 1 as const,
    examId,
  };

  let emitted = 0;
  const say = (msg: string) => {
    emitted++;
    console.log(`  ${msg}`);
  };

  for (const [i, centre] of centres.entries()) {
    console.log(`${centre.code}:`);
    const pkgBase = { ...base, packageId: centre.packageId, centreId: centre.id };
    const geo = { lat: centre.lat, lon: centre.lon, accuracyM: 8 };
    const photo = await sha256Hex(`seal-photo-${centre.code}`);

    // ── 1. sealed at the authority (service-signed) ──
    await emit(
      {
        ...pkgBase,
        id: randomUUID(),
        kind: "PACKAGE_SEALED",
        occurredAt: ts(minutes(examStart, -2880)),
        actorDeviceId: svc.id,
        payload: {
          copies: 200,
          ciphertextSha256: await sha256Hex(`ciphertext-${centre.code}`),
          drandRound: 4_500_000,
          shareCommitments: await Promise.all(
            [1, 2, 3, 4].map((n) => sha256Hex(`share-${centre.code}-${n}`)),
          ),
        },
      } as EventBody,
      svc,
    );
    say("PACKAGE_SEALED");

    // ── 2. numbered plastic seal fitted ──
    await emit(
      {
        ...pkgBase,
        id: randomUUID(),
        kind: "SEAL_APPLIED",
        occurredAt: ts(minutes(examStart, -2870)),
        actorDeviceId: courierA.id,
        actorPersonId: persons["A. Sharma"],
        geo,
        payload: { sealSerial: centre.sealSerial, photoSha256: photo },
      } as EventBody,
      courierA,
    );
    say("SEAL_APPLIED");

    // ── 3. custody chain: officer → courier → custodian → centre ──
    // A normal run spends ~3h on the road. JPR-002 spends 18h, which is the
    // unexplained handling time the projection is meant to catch.
    const pickup = centre.code === "JPR-002" ? -1380 : -480;

    const hops: {
      at: number;
      from: string;
      to: string;
      fromRole: PersonRole;
      toRole: PersonRole;
      toState: PackageState;
      signer: Device;
      cosigner: Device;
    }[] = [
      {
        at: pickup,
        from: persons["A. Sharma"]!,
        to: persons["R. Verma"]!,
        fromRole: "district_officer",
        toRole: "courier",
        toState: "in_transit",
        signer: courierA,
        cosigner: observer,
      },
      {
        // Arrives at the custodian's strongroom. For JPR-002 this is 18h after
        // pickup instead of 3h — time on the road nobody can account for.
        at: -300,
        from: persons["R. Verma"]!,
        to: persons["M. Khan"]!,
        fromRole: "courier",
        toRole: "custodian",
        toState: "at_custodian",
        signer: courierB,
        cosigner: custodian,
      },
      {
        at: -170,
        from: persons["M. Khan"]!,
        to: persons["K. Reddy"]!,
        fromRole: "custodian",
        toRole: "superintendent",
        toState: "at_centre",
        signer: custodian,
        cosigner: observer,
      },
    ];

    for (const hop of hops) {
      await emit(
        {
          ...pkgBase,
          id: randomUUID(),
          kind: "HANDOFF",
          occurredAt: ts(minutes(examStart, hop.at)),
          actorDeviceId: hop.signer.id,
          actorPersonId: hop.from,
          geo,
          payload: {
            fromPersonId: hop.from,
            toPersonId: hop.to,
            fromRole: hop.fromRole,
            toRole: hop.toRole,
            sealSerial: centre.sealSerial,
            photoSha256: photo,
            toState: hop.toState,
          },
        } as EventBody,
        hop.signer,
        hop.cosigner,
      );
      const slowLeg = hop.toState === "at_custodian" && pickup < -600;
      say(`HANDOFF → ${hop.toState}${slowLeg ? "  (18h on the road, unaccounted)" : ""}`);
      await client.query("update ref.package set state = $2 where id = $1", [
        centre.packageId,
        hop.toState,
      ]);
    }


    // ── 4. the access engine decides. Nothing below asserts an outcome. ──
    //
    // Every scenario presents *something* to POST /access/request and the
    // engine rules on it. That is the whole point: a refusal here is a refusal
    // the policy engine produced from the evidence, not a line this file wrote.
    const pc = centrePCs[centre.code]!;
    const superintendent = persons["K. Reddy"]!;

    // Issue the unlock key for this epoch. The plaintext comes back exactly
    // once, here — the service keeps only its SHA-256.
    const unlockKey = await issueKey(centre.packageId, "unlock", superintendent);
    say(`key issued for stage "unlock" → ${unlockKey.fingerprint}`);

    /** What each centre presents when it asks to open the package. */
    let presented: string | undefined = unlockKey.key;
    let sealRead: string | undefined = centre.sealSerial;
    let attemptGeo = geo;

    if (centre.code === "JPR-003") {
      // The seal on the box does not match what was registered.
      sealRead = `SEAL-TAMPERED-${Math.floor(Math.random() * 9000 + 1000)}`;
    }

    if (centre.code === "JPR-004") {
      // A key from three epochs ago — 18 hours stale. Someone kept a key past
      // their shift and tried to use it.
      const stale = await issueKey(
        centre.packageId,
        "unlock",
        superintendent,
        currentEpoch - 3,
      );
      presented = stale.key;
      say(`presenting a key from epoch ${currentEpoch - 3} (18h stale)`);
    }

    if (centre.code === "JPR-005") {
      // A key that was never issued for this package at all.
      presented = "MHR-UNLOCK-9F2K-4TQX-8BVN-3MZP-7RHD-WY";
      // …and from 400 m away, outside the 150 m geofence.
      attemptGeo = { lat: centre.lat + 0.0036, lon: centre.lon, accuracyM: 12 };
      say("presenting a key nobody issued, from outside the geofence");
    }

    const decision = await requestAccess({
      packageId: centre.packageId,
      stage: "unlock",
      presentedKey: presented,
      deviceId: pc.id,
      personId: superintendent,
      sealSerialRead: sealRead,
      geo: attemptGeo,
    });

    // The engine ruled just now, so the events recording that ruling are
    // timestamped from now — not from the exam clock. An event claiming to have
    // occurred forty minutes before it was submitted would be flagged for clock
    // skew, and rightly so.
    const decidedAt = new Date();

    const passed = decision.checksPassed.length;
    const total = passed + decision.denyReasons.length;
    say(
      `access ${decision.outcome.toUpperCase()} — ${passed}/${total} checks passed` +
        (decision.denyReasons.length ? `; failed: ${decision.denyReasons.join(", ")}` : ""),
    );

    // The engine's ruling becomes a signed event. A refusal is recorded exactly
    // as faithfully as a grant.
    const sessionId = decision.sessionId;
    await emit(
      {
        ...pkgBase,
        id: randomUUID(),
        kind: "ACCESS_REQUESTED",
        occurredAt: ts(minutes(decidedAt, -3)),
        actorDeviceId: pc.id,
        actorPersonId: superintendent,
        geo: attemptGeo,
        payload: {
          sessionId,
          ...(sealRead ? { sealSerialRead: sealRead } : {}),
          photoSha256: photo,
        },
      } as EventBody,
      pc,
    );

    if (decision.outcome === "granted") {
      await emit(
        {
          ...pkgBase,
          id: randomUUID(),
          kind: "ACCESS_GRANTED",
          occurredAt: ts(minutes(decidedAt, -2)),
          actorDeviceId: svc.id,
          geo: attemptGeo,
          payload: {
            sessionId,
            receiptSha256: await sha256Hex(`receipt-${sessionId}`),
            checksPassed: decision.checksPassed,
          },
        } as EventBody,
        svc,
      );
    } else {
      await emit(
        {
          ...pkgBase,
          id: randomUUID(),
          kind: "ACCESS_DENIED",
          occurredAt: ts(minutes(decidedAt, -2)),
          actorDeviceId: svc.id,
          geo: attemptGeo,
          payload: {
            sessionId,
            // The contract's DenyReason enum is narrower than the engine's
            // codes; map to it, and keep the engine's full set on the attempt
            // record where nothing is lost.
            reasons: mapDenyReasons(decision.denyReasons),
          },
        } as EventBody,
        svc,
      );
    }

    // ── 5. what follows the ruling ──

    if (centre.code === "JPR-003") {
      // Seal mismatch. Runbook: stop, do not print, escalate.
      await emit(
        {
          ...pkgBase,
          id: randomUUID(),
          kind: "SEAL_MISMATCH",
          occurredAt: ts(minutes(decidedAt, -2)),
          actorDeviceId: pc.id,
          actorPersonId: superintendent,
          geo,
          payload: {
            expectedSerial: centre.sealSerial,
            observedSerial: sealRead!,
            photoSha256: photo,
          },
        } as EventBody,
        pc,
      );
      say("SEAL_MISMATCH — printing stops here");
      await client.query("update ref.package set state = 'compromised' where id = $1", [
        centre.packageId,
      ]);
      console.log("");
      continue;
    }

    if (centre.code === "JPR-004") {
      // Refused on a stale key. The centre stops and calls the control room
      // rather than proceeding — the correct outcome, and worth showing.
      say("centre stopped and escalated rather than overriding");
      await emit(
        {
          ...pkgBase,
          id: randomUUID(),
          kind: "EXCEPTION_RAISED",
          occurredAt: ts(minutes(decidedAt, -1)),
          actorDeviceId: pc.id,
          actorPersonId: superintendent,
          payload: {
            code: "STALE_KEY_ESCALATED",
            detail:
              "Unlock key had rotated out of validity. Superintendent stopped and " +
              "requested a re-issue from the control room rather than proceeding.",
          },
        } as EventBody,
        pc,
      );
      console.log("");
      continue;
    }

    if (centre.code === "JPR-005") {
      // Refused, and the superintendent proceeded anyway.
      await emit(
        {
          ...pkgBase,
          id: randomUUID(),
          kind: "OVERRIDE_USED",
          occurredAt: ts(minutes(decidedAt, -1)),
          actorDeviceId: pc.id,
          actorPersonId: superintendent,
          geo: attemptGeo,
          payload: {
            sessionId,
            deniedReasons: mapDenyReasons(decision.denyReasons),
            justification:
              "Control room instructed us by phone to proceed; the key reader on the " +
              "centre PC would not accept the issued key and the exam starts in 40 minutes.",
            photoSha256: photo,
          },
        } as EventBody,
        pc,
        observer,
      );
      say("OVERRIDE_USED — proceeded past the refusal, countersigned");
      await client.query("update ref.package set state = 'compromised' where id = $1", [
        centre.packageId,
      ]);
    }

    // ── 6. printing, for the centres that got this far ──
    await emit(
      {
        ...pkgBase,
        id: randomUUID(),
        kind: "PRINT_STARTED",
        occurredAt: ts(minutes(decidedAt, -1)),
        actorDeviceId: pc.id,
        actorPersonId: superintendent,
        payload: { copiesRequested: 200 },
      } as EventBody,
      pc,
    );

    await emit(
      {
        ...pkgBase,
        id: randomUUID(),
        kind: "PRINT_COMPLETED",
        occurredAt: ts(decidedAt),
        actorDeviceId: pc.id,
        actorPersonId: superintendent,
        payload: {
          copiesPrinted: 200,
          copiesSpoiled: i,
          firstSerial: `${centre.code}-000001`,
          lastSerial: `${centre.code}-000200`,
        },
      } as EventBody,
      pc,
    );
    say("PRINT_STARTED → PRINT_COMPLETED");

    // JPR-001 deliberately never zeroises: an unaccounted content key.
    if (centre.code !== "JPR-001") {
      await emit(
        {
          ...pkgBase,
          id: randomUUID(),
          kind: "KEY_DESTROYED",
          occurredAt: ts(decidedAt),
          actorDeviceId: pc.id,
          payload: { method: "zeroised_after_print" },
        } as EventBody,
        pc,
      );
      say("KEY_DESTROYED");
    } else {
      console.log("  (no KEY_DESTROYED — content key left unaccounted on purpose)");
    }

    if (centre.code !== "JPR-005") {
      await client.query("update ref.package set state = 'opened' where id = $1", [
        centre.packageId,
      ]);
    }
    console.log("");
  }

  console.log(`Done. ${emitted} acts recorded.\n`);
  console.log("Every refusal below was produced by the policy engine, not asserted here:\n");
  console.log("  JPR-001  granted on a valid key; content key never zeroised afterwards");
  console.log("  JPR-002  granted, but 18 unaccounted hours in transit beforehand");
  console.log("  JPR-003  refused — seal serial did not match the registered seal");
  console.log("  JPR-004  refused — key three epochs stale; centre escalated instead of overriding");
  console.log("  JPR-005  refused — unissued key, outside the geofence; overridden anyway\n");

  await client.end();
}

main().catch(async (err) => {
  console.error("\nSeeding failed:", err.message);
  await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
  process.exit(1);
});
