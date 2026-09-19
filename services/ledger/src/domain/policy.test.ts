import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { digestKey, generateSeamToken, seamCommitment, seamTokenToHex } from "@mohar/crypto-core";
import { decideAccess, type AccessRequest, type CheckName } from "./policy.js";

/**
 * ── The access engine, check by check ────────────────────────────────────────
 *
 * These run the real `decideAccess` against an in-memory stand-in for the
 * database: every row the engine reads is supplied by a fixture, so each test
 * can change exactly one fact and assert exactly what the engine does with it.
 *
 * What this proves is the decision logic — the 22 checks, deny by default,
 * no short-circuit, every refusal carrying its reason. What it does not prove is
 * the SQL: a query that selected the wrong column would pass here and fail
 * against Postgres. The live demo and the seed tool exercise that half.
 */

// ── fixtures ────────────────────────────────────────────────────────────────

const PKG = "11111111-1111-4111-8111-111111111111";
const EXAM = "22222222-2222-4222-8222-222222222222";
const CENTRE = "33333333-3333-4333-8333-333333333333";
const OTHER_CENTRE = "44444444-4444-4444-8444-444444444444";
const STATION = "55555555-5555-4555-8555-555555555555";
const FIELD_PHONE = "66666666-6666-4666-8666-666666666666";
const SUPT = "77777777-7777-4777-8777-777777777777";
const OBSERVER = "88888888-8888-4888-8888-888888888888";
const NOBODY = "99999999-9999-4999-8999-999999999999";

const KEY = "MHR-UNLOCK-TEST-KEY1-AAAA-BBBB-CCCC-DD";
const SEAL = "SEAL-TEST-00001";
const CENTRE_LAT = 26.9124;
const CENTRE_LON = 75.7873;

const H = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

interface PkgRow {
  id: string;
  state: string;
  seal_serial: string | null;
  seam_commitment: string | null;
  custody_from: Date | null;
  custody_to: Date | null;
  centre_id: string;
  exam_id: string;
  centre_code: string;
  lat: number;
  lon: number;
  geofence_m: number;
  suspended_at: Date | null;
  starts_at: Date;
}

interface DevRow {
  id: string;
  kind: string;
  centre_id: string | null;
  revoked_at: Date | null;
}

interface KeyRow {
  id: string;
  stage: string;
  epoch: number;
  key_hash: Buffer;
  fingerprint: string;
  valid_from: Date;
  valid_to: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  package_id: string;
}

interface EventRow {
  kind: string;
  occurred_at: Date;
  body: { actorDeviceId: string; payload: Record<string, unknown> };
}

interface World {
  pkg: PkgRow | null;
  stages: Record<string, string>;
  devices: DevRow[];
  persons: Record<string, string>;
  keys: KeyRow[];
  roster: { person_id: string; valid_from: Date; valid_to: Date }[];
  events: EventRow[];
  /** Whether this centre has ever had a witness station / room monitor report. */
  everWitness: number;
  everMonitor: number;
  enrolments: { slot: number; display_name: string; role: string }[];
}

function keyRow(over: Partial<KeyRow> = {}, key = KEY): KeyRow {
  const d = digestKey(key);
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    stage: "unlock",
    epoch: 1,
    key_hash: Buffer.from(d.keyHashHex, "hex"),
    fingerprint: d.fingerprint,
    valid_from: ago(H),
    valid_to: ahead(H),
    revoked_at: null,
    revoked_reason: null,
    package_id: PKG,
    ...over,
  };
}

const assertion = (role: string, slot: number, over: Record<string, unknown> = {}): EventRow => ({
  kind: "WITNESS_ASSERTED",
  occurred_at: ago(60_000),
  body: {
    actorDeviceId: STATION,
    payload: { role, templateSlot: slot, matchScore: 180, frameBytes: 0, ...over },
  },
});

const ceremony = (outcome = "two_person_confirmed"): EventRow => ({
  kind: "WITNESS_CEREMONY",
  occurred_at: ago(30_000),
  body: { actorDeviceId: STATION, payload: { outcome, windowSeconds: 120 } },
});

const frame = (): EventRow => ({
  kind: "WITNESS_FRAME",
  occurred_at: ago(50_000),
  body: { actorDeviceId: STATION, payload: { frameSha256: "ab".repeat(32), frameBytes: 1024 } },
});

const roomEntry = (enteredAtLeast: number, presence: boolean): EventRow => ({
  kind: "ROOM_ENTRY",
  occurred_at: ago(90_000),
  body: { actorDeviceId: STATION, payload: { enteredAtLeast, presence } },
});

/** A centre where everything is in order: this request should be granted. */
function goodWorld(): World {
  return {
    pkg: {
      id: PKG,
      state: "at_centre",
      seal_serial: SEAL,
      seam_commitment: null,
      custody_from: ago(H),
      custody_to: ahead(H),
      centre_id: CENTRE,
      exam_id: EXAM,
      centre_code: "TEST-01",
      lat: CENTRE_LAT,
      lon: CENTRE_LON,
      geofence_m: 150,
      suspended_at: null,
      starts_at: ahead(2 * H),
    },
    stages: { unlock: "superintendent", transit: "courier" },
    devices: [
      { id: STATION, kind: "monitor", centre_id: CENTRE, revoked_at: null },
      { id: FIELD_PHONE, kind: "field", centre_id: null, revoked_at: null },
    ],
    persons: { [SUPT]: "superintendent", [OBSERVER]: "observer" },
    keys: [keyRow()],
    roster: [
      { person_id: SUPT, valid_from: ago(24 * H), valid_to: ahead(24 * H) },
      { person_id: OBSERVER, valid_from: ago(24 * H), valid_to: ahead(24 * H) },
    ],
    events: [assertion("superintendent", 1), assertion("observer", 11), ceremony(), frame()],
    everWitness: 3,
    everMonitor: 0,
    enrolments: [
      { slot: 1, display_name: "R. Verma", role: "superintendent" },
      { slot: 11, display_name: "S. Iyer", role: "observer" },
    ],
  };
}

function goodRequest(over: Partial<AccessRequest> = {}): AccessRequest {
  return {
    packageId: PKG,
    stage: "unlock",
    presentedKey: KEY,
    deviceId: STATION,
    personId: SUPT,
    sealSerialRead: SEAL,
    occurredAt: new Date().toISOString(),
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ...over,
  };
}

/**
 * The stand-in database. Each branch answers one of the queries the engine
 * makes; anything it does not recognise fails the test loudly, so a new query
 * in the engine cannot be silently answered with nothing.
 */
function fakeTx(w: World): PoolClient {
  const query = async (sql: string, params: unknown[] = []) => {
    const rows = ((): unknown[] => {
      if (sql.includes("from ref.package p")) {
        return w.pkg && params[0] === w.pkg.id ? [w.pkg] : [];
      }
      if (sql.includes("from led.custody_stage")) {
        const role = w.stages[String(params[0])];
        return role ? [{ stage: params[0], expected_role: role }] : [];
      }
      if (sql.includes("from ref.device")) {
        return w.devices.filter((d) => d.id === params[0]);
      }
      if (sql.includes("from ref.person where id")) {
        const role = w.persons[String(params[0])];
        return role ? [{ role }] : [];
      }
      if (sql.includes("from led.access_key")) {
        return w.keys.filter((k) => k.package_id === params[0]);
      }
      if (sql.includes("from ref.roster")) {
        return w.roster.filter((r) => r.person_id === params[2]);
      }
      if (sql.includes("count(*) filter")) {
        return [{ witness: String(w.everWitness), monitor: String(w.everMonitor) }];
      }
      if (sql.includes("from led.event")) {
        return w.events;
      }
      if (sql.includes("from ref.fingerprint_enrolment")) {
        return w.enrolments.filter((e) => e.slot === params[1]);
      }
      throw new Error(`fake database was asked something it does not know: ${sql.slice(0, 80)}`);
    })();
    return { rows, rowCount: rows.length };
  };
  return { query } as unknown as PoolClient;
}

async function decide(w: World, req: AccessRequest) {
  const d = await decideAccess(fakeTx(w), req);
  const check = (name: CheckName) => {
    const c = d.checks.find((x) => x.check === name);
    assert.ok(c, `check ${name} was not evaluated at all`);
    return c;
  };
  return { ...d, check };
}

// ── the whole engine ────────────────────────────────────────────────────────

const ALL_22: CheckName[] = [
  "key_presented", "key_valid", "key_in_window", "key_stage_match",
  "device_enrolled", "device_binding", "roster_membership", "role_permitted",
  "geofence", "geo_accuracy", "clock_skew", "custody_window",
  "seal_serial", "seam_token", "package_state", "exam_active",
  "biometric_primary", "biometric_secondary", "two_person_copresence",
  "occupancy_corroborated", "seal_lock_intact", "witness_capture",
];

test("a request with everything in order is granted, 19 of 22", async () => {
  const d = await decide(goodWorld(), goodRequest());
  assert.equal(d.outcome, "granted");
  assert.deepEqual(d.denyReasons, []);
  assert.equal(d.checks.length, 22);
  assert.equal(d.checksPassed.length, 19);
});

test("the three that do not pass are the ones with nothing to measure", async () => {
  const d = await decide(goodWorld(), goodRequest());
  const notPassed = d.checks.filter((c) => !c.passed);
  assert.deepEqual(
    notPassed.map((c) => c.check).sort(),
    ["occupancy_corroborated", "seal_lock_intact", "seam_token"],
  );
  // Not evaluated is not a refusal: none of them carries a reason.
  for (const c of notPassed) {
    assert.equal(c.reason, undefined, `${c.check} refused when it should be not-evaluated`);
    assert.match(c.evidence, /not evaluated/);
  }
});

test("every one of the 22 checks is evaluated at unlock, in order", async () => {
  const d = await decide(goodWorld(), goodRequest());
  assert.deepEqual(d.checks.map((c) => c.check), ALL_22);
});

test("no short-circuit: a request wrong in five ways reports all five", async () => {
  const w = goodWorld();
  w.pkg!.state = "compromised";
  w.pkg!.custody_to = ago(H);
  const d = await decide(w, goodRequest({ presentedKey: "MHR-UNLOCK-WRONG", sealSerialRead: "SEAL-OTHER", personId: NOBODY }));
  assert.equal(d.outcome, "denied");
  for (const r of [
    "key_unknown",
    "outside_custody_window",
    "seal_serial_mismatch",
    "package_compromised",
    "person_not_on_roster",
  ]) {
    assert.ok(d.denyReasons.includes(r as never), `missing ${r} in ${d.denyReasons.join(",")}`);
  }
  assert.equal(d.checks.length, 22, "a failure early on must not stop later checks");
});

test("deny reasons are not repeated", async () => {
  const d = await decide(goodWorld(), goodRequest({ personId: NOBODY }));
  assert.equal(new Set(d.denyReasons).size, d.denyReasons.length);
});

test("witness checks only run at the unlock stage", async () => {
  const w = goodWorld();
  w.keys = [keyRow({ stage: "transit" })];
  w.persons[SUPT] = "courier";
  const d = await decide(w, goodRequest({ stage: "transit" }));
  assert.equal(d.checks.length, 16);
  assert.ok(!d.checks.some((c) => c.check === "biometric_primary"));
});

// ── 1-4 · the custody key ───────────────────────────────────────────────────

test("key_presented: no key is refused", async () => {
  const d = await decide(goodWorld(), goodRequest({ presentedKey: undefined }));
  assert.equal(d.check("key_presented").reason, "key_not_presented");
  assert.equal(d.outcome, "denied");
});

test("key_valid: a key never issued is refused, and its fingerprint recorded", async () => {
  const d = await decide(goodWorld(), goodRequest({ presentedKey: "MHR-UNLOCK-GUESS-1234" }));
  assert.equal(d.check("key_valid").reason, "key_unknown");
  assert.equal(d.context.presentedFingerprint, digestKey("MHR-UNLOCK-GUESS-1234").fingerprint);
});

test("key_valid: a revoked key is refused", async () => {
  const w = goodWorld();
  w.keys = [keyRow({ revoked_at: ago(60_000), revoked_reason: "lost phone" })];
  const d = await decide(w, goodRequest());
  assert.equal(d.check("key_valid").reason, "key_revoked");
  assert.match(d.check("key_valid").evidence, /lost phone/);
});

test("key_in_window: an expired key is refused", async () => {
  const w = goodWorld();
  w.keys = [keyRow({ valid_from: ago(8 * H), valid_to: ago(2 * H) })];
  const d = await decide(w, goodRequest());
  assert.equal(d.check("key_in_window").reason, "key_expired");
});

test("key_in_window: a key not yet valid is refused", async () => {
  const w = goodWorld();
  w.keys = [keyRow({ valid_from: ahead(H), valid_to: ahead(7 * H) })];
  const d = await decide(w, goodRequest());
  assert.equal(d.check("key_in_window").reason, "key_not_yet_valid");
});

test("key_stage_match: a key for another stage is refused", async () => {
  const w = goodWorld();
  w.keys = [keyRow({ stage: "transit" })];
  const d = await decide(w, goodRequest());
  assert.equal(d.check("key_stage_match").reason, "key_wrong_stage");
});

// ── 5-6 · the device ────────────────────────────────────────────────────────

test("device_enrolled: an unknown device is refused", async () => {
  const d = await decide(goodWorld(), goodRequest({ deviceId: NOBODY }));
  assert.equal(d.check("device_enrolled").reason, "device_unknown");
});

test("device_enrolled: a revoked device is refused", async () => {
  const w = goodWorld();
  w.devices[0]!.revoked_at = ago(H);
  const d = await decide(w, goodRequest());
  assert.equal(d.check("device_enrolled").reason, "device_revoked");
});

test("device_binding: a station bound to another centre is refused", async () => {
  const w = goodWorld();
  w.devices[0]!.centre_id = OTHER_CENTRE;
  const d = await decide(w, goodRequest());
  assert.equal(d.check("device_binding").reason, "device_not_bound_to_centre");
});

// ── 7-8 · the person ────────────────────────────────────────────────────────

test("roster_membership: someone not rostered here is refused", async () => {
  const d = await decide(goodWorld(), goodRequest({ personId: NOBODY }));
  assert.equal(d.check("roster_membership").reason, "person_not_on_roster");
});

test("roster_membership: a roster entry that has lapsed is refused", async () => {
  const w = goodWorld();
  w.roster[0] = { person_id: SUPT, valid_from: ago(48 * H), valid_to: ago(24 * H) };
  const d = await decide(w, goodRequest());
  assert.equal(d.check("roster_membership").reason, "person_not_on_roster");
});

test("role_permitted: an observer cannot perform a superintendent's stage", async () => {
  const d = await decide(goodWorld(), goodRequest({ personId: OBSERVER }));
  assert.equal(d.check("role_permitted").reason, "person_role_not_permitted");
});

// ── 9-10 · position ─────────────────────────────────────────────────────────

test("geofence: a station bound to the centre is located by that binding, no fix needed", async () => {
  const d = await decide(goodWorld(), goodRequest({ geo: undefined }));
  assert.equal(d.check("geofence").passed, true);
  assert.match(d.check("geofence").evidence, /binding/);
});

test("geofence: a field phone with no fix is refused", async () => {
  const d = await decide(goodWorld(), goodRequest({ deviceId: FIELD_PHONE }));
  assert.equal(d.check("geofence").reason, "geo_missing");
});

test("geofence: a field phone a kilometre away is refused", async () => {
  const d = await decide(
    goodWorld(),
    goodRequest({ deviceId: FIELD_PHONE, geo: { lat: CENTRE_LAT + 0.01, lon: CENTRE_LON, accuracyM: 10 } }),
  );
  assert.equal(d.check("geofence").reason, "outside_geofence");
  assert.ok((d.context.distanceM ?? 0) > 1000);
});

test("geo_accuracy: a fix too vague to place the device is refused", async () => {
  const d = await decide(
    goodWorld(),
    goodRequest({ deviceId: FIELD_PHONE, geo: { lat: CENTRE_LAT, lon: CENTRE_LON, accuracyM: 400 } }),
  );
  assert.equal(d.check("geofence").passed, true);
  assert.equal(d.check("geo_accuracy").reason, "geo_accuracy_insufficient");
});

// ── 11-12 · time ────────────────────────────────────────────────────────────

test("custody_window: a closed window is refused", async () => {
  const w = goodWorld();
  w.pkg!.custody_to = ago(H);
  const d = await decide(w, goodRequest());
  assert.equal(d.check("custody_window").reason, "outside_custody_window");
});

test("custody_window: a window not yet open is refused", async () => {
  const w = goodWorld();
  w.pkg!.custody_from = ahead(H);
  w.pkg!.custody_to = ahead(3 * H);
  const d = await decide(w, goodRequest());
  assert.equal(d.check("custody_window").reason, "outside_custody_window");
});

test("clock_skew: a device clock ten minutes out is refused", async () => {
  const d = await decide(goodWorld(), goodRequest({ occurredAt: ahead(10 * 60_000).toISOString() }));
  assert.equal(d.check("clock_skew").reason, "clock_skew_excessive");
});

// ── 13-14 · the seal ────────────────────────────────────────────────────────

test("seal_serial: a seal not read is refused", async () => {
  const d = await decide(goodWorld(), goodRequest({ sealSerialRead: undefined }));
  assert.equal(d.check("seal_serial").reason, "seal_serial_not_read");
});

test("seal_serial: a different seal number is refused", async () => {
  const d = await decide(goodWorld(), goodRequest({ sealSerialRead: "SEAL-TEST-00002" }));
  assert.equal(d.check("seal_serial").reason, "seal_serial_mismatch");
});

test("seam_token: the right flap code passes", async () => {
  const w = goodWorld();
  const token = generateSeamToken();
  w.pkg!.seam_commitment = seamCommitment(token, PKG);
  const d = await decide(w, goodRequest({ seamTokenRead: seamTokenToHex(token) }));
  assert.equal(d.check("seam_token").passed, true);
  assert.equal(d.outcome, "granted");
  assert.equal(d.checksPassed.length, 20);
});

test("seam_token: a torn flap code that cannot be read is refused", async () => {
  const w = goodWorld();
  w.pkg!.seam_commitment = seamCommitment(generateSeamToken(), PKG);
  const d = await decide(w, goodRequest());
  assert.equal(d.check("seam_token").reason, "seam_token_absent");
});

test("seam_token: a different flap code is refused", async () => {
  const w = goodWorld();
  w.pkg!.seam_commitment = seamCommitment(generateSeamToken(), PKG);
  const d = await decide(w, goodRequest({ seamTokenRead: seamTokenToHex(generateSeamToken()) }));
  assert.equal(d.check("seam_token").reason, "seam_token_mismatch");
});

test("seam_token: another package's flap code does not open this one", async () => {
  const w = goodWorld();
  const token = generateSeamToken();
  w.pkg!.seam_commitment = seamCommitment(token, "12121212-1212-4212-8212-121212121212");
  const d = await decide(w, goodRequest({ seamTokenRead: seamTokenToHex(token) }));
  assert.equal(d.check("seam_token").reason, "seam_token_mismatch");
});

// ── 15-16 · package and exam ────────────────────────────────────────────────

test("package_state: an unknown package is refused, not crashed on", async () => {
  const d = await decide(goodWorld(), goodRequest({ packageId: NOBODY }));
  assert.equal(d.check("package_state").reason, "package_state_unexpected");
  assert.equal(d.outcome, "denied");
});

test("package_state: a compromised package is refused", async () => {
  const w = goodWorld();
  w.pkg!.state = "compromised";
  const d = await decide(w, goodRequest());
  assert.equal(d.check("package_state").reason, "package_compromised");
});

test("package_state: a package already opened cannot be opened again", async () => {
  const w = goodWorld();
  w.pkg!.state = "opened";
  const d = await decide(w, goodRequest());
  assert.equal(d.check("package_state").reason, "package_already_opened");
});

test("exam_active: a suspended exam is refused", async () => {
  const w = goodWorld();
  w.pkg!.suspended_at = ago(H);
  const d = await decide(w, goodRequest());
  assert.equal(d.check("exam_active").reason, "exam_suspended");
});

// ── 17-22 · the hardware ────────────────────────────────────────────────────

test("biometric_primary: no superintendent print is refused", async () => {
  const w = goodWorld();
  w.events = [assertion("observer", 11), ceremony(), frame()];
  const d = await decide(w, goodRequest());
  assert.equal(d.check("biometric_primary").reason, "biometric_primary_missing");
});

test("biometric_secondary: one person twice is not two people", async () => {
  const w = goodWorld();
  w.events = [assertion("superintendent", 1), assertion("observer", 1), ceremony(), frame()];
  const d = await decide(w, goodRequest());
  assert.equal(d.check("biometric_secondary").reason, "biometric_secondary_missing");
  assert.match(d.check("biometric_secondary").evidence, /one person twice/);
});

test("two_person_copresence: a window the station did not confirm is refused", async () => {
  const w = goodWorld();
  w.events = [assertion("superintendent", 1), assertion("observer", 11), ceremony("window_expired"), frame()];
  const d = await decide(w, goodRequest());
  assert.equal(d.check("two_person_copresence").reason, "two_person_window_not_met");
});

test("biometrics name the person the slot is registered to", async () => {
  const d = await decide(goodWorld(), goodRequest());
  assert.match(d.check("biometric_primary").evidence, /R\. Verma/);
  assert.match(d.check("biometric_secondary").evidence, /S\. Iyer/);
});

test("witness_capture: a ceremony with no photograph is refused", async () => {
  const w = goodWorld();
  w.events = [assertion("superintendent", 1), assertion("observer", 11), ceremony()];
  const d = await decide(w, goodRequest());
  assert.equal(d.check("witness_capture").reason, "witness_frame_missing");
});

test("witness_capture: a frame taken on the station itself counts", async () => {
  const w = goodWorld();
  w.events = [
    assertion("superintendent", 1, { frameBytes: 2048, frameSha256: "cd".repeat(32) }),
    assertion("observer", 11),
    ceremony(),
  ];
  const d = await decide(w, goodRequest());
  assert.equal(d.check("witness_capture").passed, true);
});

test("a centre with no witness station is not refused for lacking one", async () => {
  const w = goodWorld();
  w.everWitness = 0;
  w.events = [];
  const d = await decide(w, goodRequest());
  for (const name of ["biometric_primary", "biometric_secondary", "two_person_copresence", "witness_capture"] as const) {
    assert.equal(d.check(name).passed, false);
    assert.equal(d.check(name).reason, undefined, `${name} refused a centre that has no station`);
  }
  assert.equal(d.outcome, "granted");
});

test("occupancy_corroborated: a fitted monitor that saw nothing contradicts two people", async () => {
  const w = goodWorld();
  w.everMonitor = 5;
  const d = await decide(w, goodRequest());
  assert.equal(d.check("occupancy_corroborated").reason, "occupancy_contradicts_two_person");
});

test("occupancy_corroborated: a monitor that saw people enter passes", async () => {
  const w = goodWorld();
  w.everMonitor = 5;
  w.events.push(roomEntry(2, true));
  const d = await decide(w, goodRequest());
  assert.equal(d.check("occupancy_corroborated").passed, true);
});

test("seal_lock_intact is never reported as passed while no lock exists", async () => {
  const d = await decide(goodWorld(), goodRequest());
  assert.equal(d.check("seal_lock_intact").passed, false);
  assert.match(d.check("seal_lock_intact").evidence, /not evaluated/);
});
