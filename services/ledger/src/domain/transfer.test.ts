import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  generateSeamLabel,
  generateTransferKey,
  type SeamLabel,
} from "@mohar/crypto-core";
import {
  decideTransfer,
  TRANSFER_CHECKS,
  type TransferCheckName,
  type TransferRequest,
} from "./transfer.js";

/**
 * ── The hand-off engine, check by check ──────────────────────────────────────
 *
 * The real `decideTransfer` against an in-memory stand-in for the database, so
 * each test changes exactly one fact and asserts exactly what the engine does
 * with it. This proves the decision logic; it does not prove the SQL, which the
 * seed tool and a live run exercise instead.
 *
 * The claims under test are the deck's: every hand-off is verified by scan,
 * fingerprint and signed record; a new key exists for every transfer and is
 * released only after the receiver has proved they are standing at the packet;
 * a wrong fingerprint, device, place, time, serial or label refuses the
 * transfer and says why.
 */

const LEG = "aaaaaaaa-0000-4000-8000-000000000001";
const LEG_TWO = "aaaaaaaa-0000-4000-8000-000000000002";
const PKG = "bbbbbbbb-0000-4000-8000-000000000001";
const CENTRE = "cccccccc-0000-4000-8000-000000000001";
const OTHER_CENTRE = "cccccccc-0000-4000-8000-000000000002";
const PHONE = "dddddddd-0000-4000-8000-000000000001";
const CENTRE_TABLET = "dddddddd-0000-4000-8000-000000000002";
const COURIER = "eeeeeeee-0000-4000-8000-000000000001";
const CUSTODIAN = "eeeeeeee-0000-4000-8000-000000000002";
const NOBODY = "eeeeeeee-0000-4000-8000-00000000000f";

const SERIAL = "PKT-JPR-0091";
const LAT = 26.9124;
const LON = 75.7873;
const H = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

interface World {
  leg: Record<string, unknown> | null;
  pkg: { state: string; seal_serial: string | null } | null;
  label: SeamLabel | null;
  packageCentre: string;
  devices: { id: string; kind: string; centre_id: string | null; revoked_at: Date | null }[];
  persons: Record<string, string>;
  priorLegClosed: boolean;
  refusedAttempts: number;
  issuedKey: { key: string; keyHashHex: string; expiresAt: Date } | null;
  dispatched: boolean;
}

function world(over: Partial<World> = {}): World {
  const label = generateSeamLabel();
  return {
    leg: {
      id: LEG,
      package_id: PKG,
      leg_no: 1,
      from_role: "press_operator",
      to_role: "courier",
      from_place: "Government Press, Jaipur",
      to_place: "District strong room, Jaipur",
      window_start: ago(H),
      window_end: ahead(H),
      expected_by: ahead(H / 2),
      geo_lat: LAT,
      geo_lon: LON,
      geo_radius_m: 150,
    },
    pkg: { state: "sealed", seal_serial: SERIAL },
    label,
    packageCentre: CENTRE,
    devices: [
      { id: PHONE, kind: "field", centre_id: null, revoked_at: null },
      { id: CENTRE_TABLET, kind: "centre_pc", centre_id: CENTRE, revoked_at: null },
    ],
    persons: { [COURIER]: "courier", [CUSTODIAN]: "custodian" },
    priorLegClosed: true,
    refusedAttempts: 0,
    issuedKey: null,
    dispatched: true,
    ...over,
  };
}

function request(w: World, over: Partial<TransferRequest> = {}): TransferRequest {
  return {
    legId: LEG,
    step: "receive",
    deviceId: PHONE,
    personId: COURIER,
    seamSecretHex: w.label ? Buffer.from(w.label.seamSecret).toString("hex") : undefined,
    seamIdRead: w.label?.seamId,
    packetSerialTyped: SERIAL,
    biometricSlot: 4,
    biometricScore: 182,
    geo: { lat: LAT, lon: LON, accuracyM: 8 },
    occurredAt: new Date().toISOString(),
    ...over,
  };
}

/**
 * The stand-in database. Anything it does not recognise fails loudly, so a new
 * query in the engine cannot be silently answered with an empty result.
 */
function fakeClient(w: World): PoolClient {
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.includes("from ref.route_leg where id")) {
      const wanted = params[0];
      if (w.leg && wanted === w.leg["id"]) return { rows: [w.leg] };
      return { rows: [] };
    }
    if (sql.includes("as closed")) {
      return { rows: [{ closed: w.priorLegClosed }] };
    }
    if (sql.includes("from ref.package p") && sql.includes("ref.seal_label")) {
      if (!w.pkg) return { rows: [] };
      return {
        rows: [
          {
            state: w.pkg.state,
            seal_serial: w.pkg.seal_serial,
            seam_id: w.label?.seamId ?? null,
            commitment_hex: w.label?.commitment ?? null,
          },
        ],
      };
    }
    if (sql.includes("select centre_id from ref.package")) {
      return { rows: [{ centre_id: w.packageCentre }] };
    }
    if (sql.includes("from ref.device where id")) {
      const found = w.devices.find((d) => d.id === params[0]);
      return { rows: found ? [found] : [] };
    }
    if (sql.includes("from ref.person where id")) {
      const role = w.persons[params[0] as string];
      return {
        rows: role
          ? [{ id: params[0], role, display_name: `Officer ${role}` }]
          : [],
      };
    }
    if (sql.includes("from led.transfer_key")) {
      if (!w.issuedKey) return { rows: [] };
      return {
        rows: [
          {
            key_hash_hex: w.issuedKey.keyHashHex,
            expires_at: w.issuedKey.expiresAt,
            seam_id: w.label?.seamId ?? null,
          },
        ],
      };
    }
    if (sql.includes("as dispatched")) {
      return { rows: [{ dispatched: w.dispatched }] };
    }
    if (sql.includes("count(*) as refused")) {
      return { rows: [{ refused: String(w.refusedAttempts), guesses: String(w.refusedAttempts) }] };
    }
    throw new Error(`fake client has no answer for: ${sql.slice(0, 120)}`);
  };
  return { query } as unknown as PoolClient;
}

const run = (w: World, over: Partial<TransferRequest> = {}) =>
  decideTransfer(fakeClient(w), request(w, over));

function check(
  decision: Awaited<ReturnType<typeof decideTransfer>>,
  name: TransferCheckName,
) {
  const found = decision.checks.find((c) => c.check === name);
  assert.ok(found, `no result recorded for ${name}`);
  return found;
}

// ── the shape of a decision ─────────────────────────────────────────────────

test("every check is evaluated, in order, on every decision", async () => {
  const decision = await run(world());
  assert.deepEqual(
    decision.checks.map((c) => c.check),
    [...TRANSFER_CHECKS],
  );
});

test("a hand-off in order is granted, and nothing is left unevaluated by accident", async () => {
  const decision = await run(world());
  assert.equal(decision.outcome, "granted", JSON.stringify(decision.denyReasons));
  assert.deepEqual(decision.denyReasons, []);
  const notEvaluated = decision.checks.filter((c) => c.passed === undefined).map((c) => c.check);
  assert.deepEqual(notEvaluated, []);
});

test("every check records evidence whether it passed or failed", async () => {
  const decision = await run(world(), { packetSerialTyped: "WRONG-1" });
  for (const c of decision.checks) {
    assert.ok(c.evidence.length > 0, `${c.check} recorded no evidence`);
  }
});

test("nothing short-circuits: five wrong things produce five reasons", async () => {
  const decision = await run(world(), {
    personId: NOBODY,
    deviceId: "dddddddd-0000-4000-8000-0000000000ff",
    packetSerialTyped: "WRONG-1",
    geo: { lat: 28.6139, lon: 77.209, accuracyM: 9 },
    biometricScore: 12,
  });
  assert.equal(decision.outcome, "refused");
  for (const reason of [
    "person_not_on_roster",
    "device_unknown",
    "packet_serial_mismatch",
    "outside_geofence",
    "biometric_primary_missing",
  ] as const) {
    assert.ok(decision.denyReasons.includes(reason), `missing ${reason}`);
  }
  assert.equal(decision.checks.length, TRANSFER_CHECKS.length);
});

// ── the packet itself ───────────────────────────────────────────────────────

test("both codes rebuild the secret and the commitment matches", async () => {
  const decision = await run(world());
  assert.equal(check(decision, "seam_commitment").passed, true);
});

test("a label swapped in transit is refused", async () => {
  const other = generateSeamLabel();
  const decision = await run(world(), {
    seamIdRead: other.seamId,
    seamSecretHex: Buffer.from(other.seamSecret).toString("hex"),
  });
  assert.equal(check(decision, "seam_commitment").passed, false);
  assert.ok(decision.denyReasons.includes("seam_token_mismatch"));
});

test("a label that could not be read is refused as absent, not as mismatched", async () => {
  const decision = await run(world(), { seamSecretHex: undefined, seamIdRead: undefined });
  assert.equal(check(decision, "seam_commitment").passed, false);
  assert.ok(decision.denyReasons.includes("seam_token_absent"));
});

test("a packet with no label on record reports the seam check as not evaluated", async () => {
  const w = world({ label: null });
  const decision = await run(w, { seamSecretHex: undefined, seamIdRead: undefined });
  assert.equal(check(decision, "seam_commitment").passed, undefined);
  assert.equal(decision.outcome, "granted");
});

test("the receiver must type the packet's own serial", async () => {
  const wrong = await run(world(), { packetSerialTyped: "PKT-JPR-0092" });
  assert.equal(check(wrong, "packet_serial").passed, false);
  assert.ok(wrong.denyReasons.includes("packet_serial_mismatch"));

  const caseAndSpace = await run(world(), { packetSerialTyped: `  ${SERIAL.toLowerCase()} ` });
  assert.equal(check(caseAndSpace, "packet_serial").passed, true);
});

test("a serial that was not typed is refused as unread, not counted as a guess", async () => {
  const decision = await run(world({ refusedAttempts: 2 }), { packetSerialTyped: undefined });
  assert.equal(check(decision, "packet_serial").passed, false);
  assert.ok(decision.denyReasons.includes("seal_serial_not_read"));
  assert.ok(!decision.denyReasons.includes("packet_serial_mismatch"));
  assert.equal(decision.raisesAlert, false);
});

test("the closing step does not ask for the serial again", async () => {
  const w = world();
  w.issuedKey = generateTransferKey(w.label!.seamId, LEG, ahead(H));
  const decision = await run(w, { step: "confirm", transferKey: w.issuedKey.key, packetSerialTyped: undefined });
  assert.equal(check(decision, "packet_serial").passed, undefined);
  assert.equal(decision.outcome, "granted");
});

test("the sender is not asked for a serial they cannot see", async () => {
  const decision = await run(world(), { step: "dispatch", packetSerialTyped: undefined });
  assert.equal(check(decision, "packet_serial").passed, undefined);
});

test("a compromised packet does not move", async () => {
  const decision = await run(world({ pkg: { state: "compromised", seal_serial: SERIAL } }));
  assert.equal(check(decision, "package_state").passed, false);
  assert.ok(decision.denyReasons.includes("package_compromised"));
});

test("an already opened packet does not move", async () => {
  const decision = await run(world({ pkg: { state: "opened", seal_serial: SERIAL } }));
  assert.equal(check(decision, "package_state").passed, false);
  assert.ok(decision.denyReasons.includes("package_state_unexpected"));
});

// ── who, where, when ────────────────────────────────────────────────────────

test("the receiver must hold the role this leg hands over to", async () => {
  const decision = await run(world(), { personId: CUSTODIAN });
  assert.equal(check(decision, "role_permitted").passed, false);
  assert.ok(decision.denyReasons.includes("person_role_not_permitted"));
});

test("the sender is checked against the role the leg hands over from", async () => {
  const w = world();
  const asCourier = await run(w, { step: "dispatch", personId: COURIER });
  assert.equal(check(asCourier, "role_permitted").passed, false);
  assert.equal(asCourier.context.expectedRole, "press_operator");
});

test("an unregistered person is refused, and their attempt still names them", async () => {
  const decision = await run(world(), { personId: NOBODY });
  assert.equal(check(decision, "person_on_roster").passed, false);
  assert.ok(check(decision, "person_on_roster").evidence.includes(NOBODY));
});

test("an attempt with no person named at all is refused", async () => {
  const decision = await run(world(), { personId: undefined });
  assert.equal(check(decision, "person_on_roster").passed, false);
  assert.equal(check(decision, "role_permitted").passed, false);
});

test("a revoked device is refused, and the refusal says when it was revoked", async () => {
  const w = world();
  w.devices[0]!.revoked_at = ago(2 * H);
  const decision = await run(w);
  assert.equal(check(decision, "device_enrolled").passed, false);
  assert.ok(decision.denyReasons.includes("device_revoked"));
});

test("a centre device carrying another centre's packet is refused", async () => {
  const decision = await run(world({ packageCentre: OTHER_CENTRE }), { deviceId: CENTRE_TABLET });
  assert.equal(check(decision, "device_binding").passed, false);
  assert.ok(decision.denyReasons.includes("device_not_bound_to_centre"));
});

test("a courier handheld bound to no centre travels the whole route", async () => {
  const decision = await run(world({ packageCentre: OTHER_CENTRE }), { deviceId: PHONE });
  assert.equal(check(decision, "device_binding").passed, true);
});

test("a scan outside the corridor is refused, with the distance recorded", async () => {
  const decision = await run(world(), { geo: { lat: 28.6139, lon: 77.209, accuracyM: 9 } });
  assert.equal(check(decision, "geofence").passed, false);
  assert.ok(decision.context.distanceM !== null && decision.context.distanceM > 150);
  assert.match(check(decision, "geofence").evidence, /\d+m from the corridor centre/);
});

test("a vague fix is refused even when the packet is in the right place", async () => {
  const decision = await run(world(), { geo: { lat: LAT, lon: LON, accuracyM: 400 } });
  assert.equal(check(decision, "geofence").passed, true);
  assert.equal(check(decision, "geo_accuracy").passed, false);
});

test("no location at all on a leg that has a corridor is refused", async () => {
  const decision = await run(world(), { geo: undefined });
  assert.equal(check(decision, "geofence").passed, false);
  assert.ok(decision.denyReasons.includes("geo_missing"));
});

test("a leg with no corridor on record does not invent one", async () => {
  const w = world();
  (w.leg as Record<string, unknown>)["geo_lat"] = null;
  (w.leg as Record<string, unknown>)["geo_lon"] = null;
  (w.leg as Record<string, unknown>)["geo_radius_m"] = null;
  const decision = await run(w, { geo: undefined });
  assert.equal(check(decision, "geofence").passed, undefined);
  assert.equal(decision.outcome, "granted");
});

test("an attempt outside the leg's window is refused", async () => {
  const w = world();
  (w.leg as Record<string, unknown>)["window_start"] = ago(5 * H);
  (w.leg as Record<string, unknown>)["window_end"] = ago(4 * H);
  (w.leg as Record<string, unknown>)["expected_by"] = ago(4 * H);
  const decision = await run(w);
  assert.equal(check(decision, "leg_window").passed, false);
  assert.ok(decision.denyReasons.includes("leg_window_closed"));
  assert.ok((decision.context.lateBySeconds ?? 0) > 0);
});

test("a device whose clock is hours out is refused", async () => {
  const decision = await run(world(), { occurredAt: ago(6 * H).toISOString() });
  assert.equal(check(decision, "clock_skew").passed, false);
  assert.ok(decision.denyReasons.includes("clock_skew_excessive"));
});

// ── the fingerprint ─────────────────────────────────────────────────────────

test("a hand-off with no fingerprint is refused", async () => {
  const decision = await run(world(), { biometricSlot: undefined, biometricScore: undefined });
  assert.equal(check(decision, "biometric_presented").passed, false);
});

test("a weak match is refused, and the score is in the record", async () => {
  const decision = await run(world(), { biometricScore: 41 });
  assert.equal(check(decision, "biometric_presented").passed, false);
  assert.match(check(decision, "biometric_presented").evidence, /score 41/);
});

// ── the leg's place in the journey ──────────────────────────────────────────

test("a leg whose predecessor never closed is refused", async () => {
  const w = world({ priorLegClosed: false });
  (w.leg as Record<string, unknown>)["leg_no"] = 3;
  const decision = await run(w);
  assert.equal(check(decision, "leg_sequence").passed, false);
  assert.match(check(decision, "leg_sequence").evidence, /skipped a hand-off/);
});

test("the first leg has nothing to follow", async () => {
  const decision = await run(world({ priorLegClosed: false }));
  assert.equal(check(decision, "leg_sequence").passed, true);
});

test("an attempt naming a leg that does not exist is refused and still evaluated", async () => {
  const decision = await run(world(), { legId: LEG_TWO });
  assert.equal(check(decision, "leg_known").passed, false);
  assert.ok(decision.denyReasons.includes("leg_not_scheduled"));
  assert.equal(decision.checks.length, TRANSFER_CHECKS.length);
});

// ── the transfer key ────────────────────────────────────────────────────────

test("the sender is not asked for a key, because none exists yet", async () => {
  const decision = await run(world(), { step: "dispatch", personId: undefined });
  assert.equal(check(decision, "transfer_key").passed, undefined);
});

test("accepting a packet nobody dispatched is refused", async () => {
  const decision = await run(world({ dispatched: false }), { step: "receive" });
  assert.equal(check(decision, "transfer_key").passed, false);
  assert.match(check(decision, "transfer_key").evidence, /has not dispatched/);
  assert.equal(decision.outcome, "refused");
});

test("the key issued for this leg closes it", async () => {
  const w = world();
  w.issuedKey = generateTransferKey(w.label!.seamId, LEG, ahead(H));
  const decision = await run(w, { step: "confirm", transferKey: w.issuedKey.key });
  assert.equal(check(decision, "transfer_key").passed, true);
  assert.equal(decision.outcome, "granted");
});

test("a wrong key is refused", async () => {
  const w = world();
  w.issuedKey = generateTransferKey(w.label!.seamId, LEG, ahead(H));
  const decision = await run(w, { step: "confirm", transferKey: "2H4K6M8P" });
  assert.equal(check(decision, "transfer_key").passed, false);
  assert.ok(decision.denyReasons.includes("transfer_key_mismatch"));
});

test("the right key after its window is refused as expired, not as wrong", async () => {
  const w = world();
  w.issuedKey = generateTransferKey(w.label!.seamId, LEG, ago(H));
  const decision = await run(w, { step: "confirm", transferKey: w.issuedKey.key });
  assert.equal(check(decision, "transfer_key").passed, false);
  assert.ok(decision.denyReasons.includes("transfer_key_expired"));
  assert.match(check(decision, "transfer_key").evidence, /expired/);
});

test("confirming a leg the sender never dispatched is refused", async () => {
  const decision = await run(world(), { step: "confirm", transferKey: "2H4K6M8P" });
  assert.equal(check(decision, "transfer_key").passed, false);
  assert.match(check(decision, "transfer_key").evidence, /has not dispatched/);
});

// ── repeated attempts ───────────────────────────────────────────────────────

test("a leg that has already refused twice still answers", async () => {
  const decision = await run(world({ refusedAttempts: 2 }));
  assert.equal(check(decision, "attempt_rate").passed, true);
  assert.equal(decision.attemptNo, 3);
});

test("the third refusal on one leg raises an alert rather than refusing quietly", async () => {
  const decision = await run(world({ refusedAttempts: 2 }), { packetSerialTyped: "WRONG-1" });
  assert.equal(decision.outcome, "refused");
  assert.equal(decision.raisesAlert, true);
});

test("a hand-off that succeeds at the third attempt raises no alert", async () => {
  const decision = await run(world({ refusedAttempts: 2 }));
  assert.equal(decision.outcome, "granted");
  assert.equal(decision.raisesAlert, false);
});

test("a refusal that is not a guess does not raise the guessing alert", async () => {
  const decision = await run(world({ refusedAttempts: 2 }), {
    geo: { lat: 28.6139, lon: 77.209, accuracyM: 9 },
  });
  assert.equal(decision.outcome, "refused");
  assert.equal(decision.raisesAlert, false);
});

test("past the limit the attempt itself is refused", async () => {
  const decision = await run(world({ refusedAttempts: 3 }));
  assert.equal(check(decision, "attempt_rate").passed, false);
  assert.equal(decision.outcome, "refused");
});
