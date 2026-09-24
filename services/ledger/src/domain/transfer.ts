import type { PoolClient } from "pg";
import type { DenyReason } from "@mohar/contracts";
import { checkTransferKey, seamLabelMatches, TRANSFER_KEY_ATTEMPT_LIMIT } from "@mohar/crypto-core";

/**
 * ── The hand-off decision engine ─────────────────────────────────────────────
 *
 * One leg of a packet's journey, from the moment a sender dispatches it to the
 * moment a receiver accepts it. The same procedure runs at every arrow of the
 * chain — press to courier, courier to strong room, strong room to vehicle,
 * vehicle to centre — because a hand-off that is checked carefully in some
 * places and loosely in others is only as good as its loosest place.
 *
 * It follows the access engine next door, and for the same reasons:
 *
 *  1. **Deny by default.** A dispatch or an acceptance starts refused. There is
 *     no path through here that returns `granted` without every check having
 *     been evaluated and passed.
 *  2. **Evaluate everything, always.** No short-circuit on the first failure. A
 *     refusal that names one problem sends an officer to fix that one thing and
 *     come back; a refusal that names all four is the actual situation.
 *  3. **Record the evidence, not the verdict.** Metres, seconds, the serial
 *     typed against the serial registered. Nine months later this has to be
 *     readable by someone who was not there.
 *
 * What this engine does NOT do is release the transfer key. It reports whether
 * every condition for releasing it held; the caller records the attempt and
 * then acts. That separation is what makes "record before you answer" possible
 * to enforce in one place.
 */

export type TransferStep = "dispatch" | "receive" | "confirm";

export type TransferCheckName =
  | "leg_known"
  | "leg_sequence"
  | "leg_window"
  | "package_state"
  | "device_enrolled"
  | "device_binding"
  | "person_on_roster"
  | "role_permitted"
  | "geofence"
  | "geo_accuracy"
  | "clock_skew"
  | "seam_commitment"
  | "packet_serial"
  | "biometric_presented"
  | "transfer_key"
  | "attempt_rate";

/** Every check, in the order they are evaluated. A granted leg lists them all. */
export const TRANSFER_CHECKS: readonly TransferCheckName[] = Object.freeze([
  "leg_known",
  "leg_sequence",
  "leg_window",
  "clock_skew",
  "package_state",
  "seam_commitment",
  "packet_serial",
  "device_enrolled",
  "device_binding",
  "person_on_roster",
  "role_permitted",
  "geofence",
  "geo_accuracy",
  "biometric_presented",
  "transfer_key",
  "attempt_rate",
]);

export interface TransferRequest {
  legId: string;
  step: TransferStep;
  deviceId: string;
  personId?: string | undefined;
  /** The secret rebuilt from both QR codes, hex. Absent means it was not read. */
  seamSecretHex?: string | undefined;
  seamIdRead?: string | undefined;
  /** Typed off the packet by the receiver. Proves someone is standing next to it. */
  packetSerialTyped?: string | undefined;
  /** Slot and score from the reader. Never an image, never a template. */
  biometricSlot?: number | undefined;
  biometricScore?: number | undefined;
  transferKey?: string | undefined;
  geo?: { lat: number; lon: number; accuracyM: number } | undefined;
  /** The device's own clock at the moment of the attempt. */
  occurredAt: string;
}

export interface TransferCheckResult {
  check: TransferCheckName;
  /** Undefined where the step does not evaluate this check at all. A check that
   *  was not run is not a check that passed, and the two must never collapse. */
  passed: boolean | undefined;
  evidence: string;
  reason?: DenyReason;
}

export interface TransferDecision {
  outcome: "granted" | "refused";
  checks: TransferCheckResult[];
  denyReasons: DenyReason[];
  attemptNo: number;
  /** True once this leg has refused as many attempts as the limit allows. */
  raisesAlert: boolean;
  context: {
    legNo: number | null;
    packageId: string | null;
    expectedRole: string | null;
    distanceM: number | null;
    geofenceM: number | null;
    clockSkewMs: number;
    packageState: string | null;
    serialRegistered: string | null;
    lateBySeconds: number | null;
  };
}

const MAX_SKEW_MS = 2 * 60 * 1000;
const MAX_ACCURACY_M = 50;
/** The R307 reports 0–255. Below 60 the reader itself calls a match doubtful. */
const MIN_BIOMETRIC_SCORE = 60;

/** Haversine, metres. Mirrors the SQL function in 001_init. */
function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

interface LegRow {
  id: string;
  package_id: string;
  leg_no: number;
  from_role: string;
  to_role: string;
  from_place: string;
  to_place: string;
  window_start: Date;
  window_end: Date;
  expected_by: Date;
  geo_lat: number | null;
  geo_lon: number | null;
  geo_radius_m: number | null;
}

/**
 * Decide one step of one leg.
 *
 * `step` changes which checks apply, not how strictly they are applied. A
 * dispatch has no packet serial to check and no key to present; an acceptance
 * has both. Checks that do not apply are reported as not evaluated, with the
 * reason they were skipped, rather than being quietly marked passed.
 */
export async function decideTransfer(
  tx: PoolClient,
  req: TransferRequest,
): Promise<TransferDecision> {
  const checks: TransferCheckResult[] = [];
  const add = (
    check: TransferCheckName,
    passed: boolean | undefined,
    evidence: string,
    reason?: DenyReason,
  ) => {
    checks.push({ check, passed, evidence, ...(reason && passed === false ? { reason } : {}) });
  };

  const now = new Date();
  const context: TransferDecision["context"] = {
    legNo: null,
    packageId: null,
    expectedRole: null,
    distanceM: null,
    geofenceM: null,
    clockSkewMs: 0,
    packageState: null,
    serialRegistered: null,
    lateBySeconds: null,
  };

  // ── the leg ──
  const { rows: legRows } = await tx.query<LegRow>(
    `select id, package_id, leg_no, from_role, to_role, from_place, to_place,
            window_start, window_end, expected_by, geo_lat, geo_lon, geo_radius_m
       from ref.route_leg where id = $1::uuid`,
    [req.legId],
  );
  const leg = legRows[0];

  add(
    "leg_known",
    Boolean(leg),
    leg
      ? `leg ${leg.leg_no}: ${leg.from_place} to ${leg.to_place}`
      : `no planned leg with id ${req.legId}`,
    "leg_not_scheduled",
  );

  if (leg) {
    context.legNo = leg.leg_no;
    context.packageId = leg.package_id;
    context.expectedRole = req.step === "dispatch" ? leg.from_role : leg.to_role;
  }

  // ── the leg before this one has to have closed ──
  if (!leg) {
    add("leg_sequence", undefined, "not evaluated: the leg itself is unknown");
  } else if (leg.leg_no === 1) {
    add("leg_sequence", true, "first leg of the journey; nothing precedes it");
  } else {
    // A leg closes when its confirm step is granted. That is recorded in
    // led.transfer_attempt, which is append-only, so a closure cannot be
    // manufactured after the fact any more than a chain event could.
    const { rows } = await tx.query<{ closed: boolean }>(
      `select exists (
         select 1 from led.transfer_attempt a
           join ref.route_leg r on r.id = a.leg_id
          where r.package_id = $1::uuid and r.leg_no = $2
            and a.outcome = 'granted' and a.checks ->> 'step' = 'confirm'
       ) as closed`,
      [leg.package_id, leg.leg_no - 1],
    );
    const closed = rows[0]?.closed === true;
    add(
      "leg_sequence",
      closed,
      closed
        ? `leg ${leg.leg_no - 1} closed before this one`
        : `leg ${leg.leg_no - 1} has no completion; this packet skipped a hand-off`,
      "leg_not_scheduled",
    );
  }

  // ── timing ──
  if (!leg) {
    add("leg_window", undefined, "not evaluated: the leg itself is unknown");
  } else {
    const inWindow = now >= leg.window_start && now <= leg.window_end;
    context.lateBySeconds = Math.round((now.getTime() - leg.expected_by.getTime()) / 1000);
    add(
      "leg_window",
      inWindow,
      `now ${now.toISOString()}; window ${leg.window_start.toISOString()} to ` +
        `${leg.window_end.toISOString()}; expected by ${leg.expected_by.toISOString()}` +
        (context.lateBySeconds > 0 ? `, late by ${context.lateBySeconds}s` : ""),
      "leg_window_closed",
    );
  }

  const skewMs = Math.abs(now.getTime() - new Date(req.occurredAt).getTime());
  context.clockSkewMs = Number.isFinite(skewMs) ? skewMs : Number.MAX_SAFE_INTEGER;
  add(
    "clock_skew",
    context.clockSkewMs <= MAX_SKEW_MS,
    `device clock differs from the server by ${Math.round(context.clockSkewMs / 1000)}s ` +
      `(limit ${MAX_SKEW_MS / 1000}s)`,
    "clock_skew_excessive",
  );

  // ── the package ──
  if (!leg) {
    add("package_state", undefined, "not evaluated: the leg itself is unknown");
    add("packet_serial", undefined, "not evaluated: the leg itself is unknown");
    add("seam_commitment", undefined, "not evaluated: the leg itself is unknown");
  } else {
    const { rows } = await tx.query<{
      state: string;
      seal_serial: string | null;
      seam_id: string | null;
      commitment_hex: string | null;
    }>(
      `select p.state, p.seal_serial, l.seam_id, l.commitment_hex
         from ref.package p
         left join ref.seal_label l on l.package_id = p.id
        where p.id = $1::uuid`,
      [leg.package_id],
    );
    const pkg = rows[0];
    context.packageState = pkg?.state ?? null;
    context.serialRegistered = pkg?.seal_serial ?? null;

    const movable = pkg ? ["sealed", "in_transit", "at_custodian", "at_centre"].includes(pkg.state) : false;
    add(
      "package_state",
      movable,
      pkg
        ? `package is ${pkg.state}`
        : `package ${leg.package_id} is not registered`,
      pkg?.state === "compromised" ? "package_compromised" : "package_state_unexpected",
    );

    // ── the seam label ──
    if (!pkg?.commitment_hex) {
      add(
        "seam_commitment",
        undefined,
        "not evaluated: this packet has no label on record, so there is nothing " +
          "to check a scan against",
      );
    } else if (!req.seamSecretHex) {
      add(
        "seam_commitment",
        false,
        "both codes must be scanned; no seam secret was presented",
        "seam_token_absent",
      );
    } else {
      const secret = hexToBytes(req.seamSecretHex);
      const idSeen = req.seamIdRead ?? pkg.seam_id ?? "";
      const matches =
        secret !== null && pkg.seam_id !== null && idSeen === pkg.seam_id
          ? seamLabelMatches(pkg.seam_id, secret, pkg.commitment_hex)
          : false;
      add(
        "seam_commitment",
        matches,
        matches
          ? `label ${pkg.seam_id} matches the commitment recorded at sealing`
          : `scanned label ${idSeen || "(unreadable)"} does not match the commitment ` +
            `recorded for ${pkg.seam_id ?? "this packet"}`,
        "seam_token_mismatch",
      );
    }

    // ── the printed serial, typed by the receiver ──
    if (req.step === "dispatch") {
      add(
        "packet_serial",
        undefined,
        "not evaluated: the serial is typed by the receiver, not the sender",
      );
    } else if (req.step === "confirm") {
      add(
        "packet_serial",
        undefined,
        "not evaluated: the serial was typed and checked at receive; confirm carries the key",
      );
    } else if (!req.packetSerialTyped) {
      // Absent is not wrong. Nobody guessed anything, so this does not count
      // toward the three-wrong-entries alert.
      add("packet_serial", false, "no packet serial was typed", "seal_serial_not_read");
    } else if (!pkg?.seal_serial) {
      add(
        "packet_serial",
        undefined,
        "not evaluated: no serial is registered for this packet",
      );
    } else {
      const typed = req.packetSerialTyped.trim().toUpperCase();
      const registered = pkg.seal_serial.trim().toUpperCase();
      add(
        "packet_serial",
        typed === registered,
        `typed ${typed}; registered ${registered}`,
        "packet_serial_mismatch",
      );
    }
  }

  // ── the device ──
  const { rows: devRows } = await tx.query<{
    id: string;
    kind: string;
    revoked_at: Date | null;
    centre_id: string | null;
  }>(
    `select id, kind, revoked_at, centre_id from ref.device where id = $1::uuid`,
    [req.deviceId],
  );
  const device = devRows[0];
  add(
    "device_enrolled",
    Boolean(device) && !device?.revoked_at,
    device
      ? device.revoked_at
        ? `device ${device.id} was revoked at ${device.revoked_at.toISOString()}`
        : `device ${device.id} (${device.kind}) is enrolled`
      : `device ${req.deviceId} is not enrolled`,
    device?.revoked_at ? "device_revoked" : "device_unknown",
  );

  if (!device || !leg) {
    add("device_binding", undefined, "not evaluated: device or leg unknown");
  } else if (!device.centre_id) {
    // A courier's handheld travels the route and is bound to no one centre.
    add("device_binding", true, `device ${device.id} is not bound to a single centre`);
  } else {
    const { rows } = await tx.query<{ centre_id: string }>(
      `select centre_id from ref.package where id = $1::uuid`,
      [leg.package_id],
    );
    const bound = rows[0]?.centre_id === device.centre_id;
    add(
      "device_binding",
      bound,
      bound
        ? `device is bound to the packet's centre ${device.centre_id}`
        : `device is bound to centre ${device.centre_id}, packet belongs to ` +
          `${rows[0]?.centre_id ?? "an unknown centre"}`,
      "device_not_bound_to_centre",
    );
  }

  // ── the person ──
  if (!req.personId) {
    add("person_on_roster", false, "no person was named on the attempt", "person_not_on_roster");
    add("role_permitted", false, "no person was named on the attempt", "person_role_not_permitted");
  } else {
    const { rows } = await tx.query<{ id: string; role: string; display_name: string }>(
      `select id, role, display_name from ref.person where id = $1::uuid`,
      [req.personId],
    );
    const person = rows[0];
    add(
      "person_on_roster",
      Boolean(person),
      person
        ? `${person.display_name} is on record as ${person.role}`
        : `person ${req.personId} is not registered`,
      "person_not_on_roster",
    );

    if (!person || !leg) {
      add("role_permitted", undefined, "not evaluated: person or leg unknown");
    } else {
      const expected = req.step === "dispatch" ? leg.from_role : leg.to_role;
      add(
        "role_permitted",
        person.role === expected,
        `leg ${leg.leg_no} ${req.step === "dispatch" ? "hands over from" : "is received by"} ` +
          `${expected}; this person is ${person.role}`,
        "person_role_not_permitted",
      );
    }
  }

  // ── where it happened ──
  if (!leg || leg.geo_lat === null || leg.geo_lon === null || leg.geo_radius_m === null) {
    add("geofence", undefined, "not evaluated: this leg has no corridor on record");
    add(
      "geo_accuracy",
      req.geo ? req.geo.accuracyM <= MAX_ACCURACY_M : undefined,
      req.geo
        ? `fix accurate to ${Math.round(req.geo.accuracyM)}m (limit ${MAX_ACCURACY_M}m)`
        : "not evaluated: no location was reported and none is required here",
      "geo_accuracy_insufficient",
    );
  } else if (!req.geo) {
    add("geofence", false, "no location was reported for a leg that has a corridor", "geo_missing");
    add("geo_accuracy", false, "no location was reported", "geo_missing");
  } else {
    const d = distanceM(req.geo, { lat: leg.geo_lat, lon: leg.geo_lon });
    context.distanceM = Math.round(d);
    context.geofenceM = leg.geo_radius_m;
    add(
      "geofence",
      d <= leg.geo_radius_m,
      `${Math.round(d)}m from the corridor centre (limit ${leg.geo_radius_m}m)`,
      "outside_geofence",
    );
    add(
      "geo_accuracy",
      req.geo.accuracyM <= MAX_ACCURACY_M,
      `fix accurate to ${Math.round(req.geo.accuracyM)}m (limit ${MAX_ACCURACY_M}m)`,
      "geo_accuracy_insufficient",
    );
  }

  // ── the fingerprint ──
  if (req.biometricSlot === undefined || req.biometricScore === undefined) {
    add(
      "biometric_presented",
      false,
      "no fingerprint was presented; every hand-off needs one from the person " +
        "whose hands the packet is passing through",
      "biometric_primary_missing",
    );
  } else {
    add(
      "biometric_presented",
      req.biometricScore >= MIN_BIOMETRIC_SCORE,
      `slot ${req.biometricSlot} matched with score ${req.biometricScore} ` +
        `(minimum ${MIN_BIOMETRIC_SCORE})`,
      "biometric_primary_missing",
    );
  }

  // ── the transfer key, only at the closing step ──
  let attemptNo = 1;
  if (req.step === "dispatch") {
    add(
      "transfer_key",
      undefined,
      "not evaluated: the sender opens the leg; no key exists yet",
    );
  } else if (req.step === "receive") {
    // The key is created at the moment the receiver passes, so what this step
    // checks is that there is a dispatch for it to link to. An acceptance with
    // no dispatch is a packet arriving that nobody sent.
    const { rows } = await tx.query<{ dispatched: boolean }>(
      `select exists (
         select 1 from led.transfer_attempt
          where leg_id = $1::uuid and outcome = 'granted'
            and checks ->> 'step' = 'dispatch'
       ) as dispatched`,
      [req.legId],
    );
    const dispatched = rows[0]?.dispatched === true;
    add(
      "transfer_key",
      dispatched,
      dispatched
        ? "the sender dispatched this leg; a key will be issued to this device if every check passes"
        : "the sender has not dispatched this leg, so there is no hand-off to accept",
      "transfer_key_not_presented",
    );
  } else {
    const { rows } = await tx.query<{
      key_hash_hex: string;
      expires_at: Date;
      seam_id: string | null;
    }>(
      `select k.key_hash_hex, k.expires_at, l.seam_id
         from led.transfer_key k
         left join ref.route_leg r on r.id = k.leg_id
         left join ref.seal_label l on l.package_id = r.package_id
        where k.leg_id = $1::uuid`,
      [req.legId],
    );
    const stored = rows[0];

    if (!stored) {
      add(
        "transfer_key",
        false,
        "no key has been issued for this leg; the sender has not dispatched it",
        "transfer_key_not_presented",
      );
    } else if (!req.transferKey) {
      add("transfer_key", false, "no key was presented", "transfer_key_not_presented");
    } else {
      const verdict = checkTransferKey(req.transferKey, {
        seamId: stored.seam_id ?? "",
        legId: req.legId,
        keyHashHex: stored.key_hash_hex,
        expiresAt: stored.expires_at,
      }, now);
      const passed = verdict.matches && !verdict.expired;
      add(
        "transfer_key",
        passed,
        verdict.matches
          ? verdict.expired
            ? `the right key, but it expired at ${stored.expires_at.toISOString()}`
            : "key matches the one issued for this leg"
          : verdict.wellFormed
            ? "key does not match the one issued for this leg"
            : "what was presented is not a well-formed key",
        verdict.matches && verdict.expired ? "transfer_key_expired" : "transfer_key_mismatch",
      );
    }
  }

  // ── guessing ──
  //
  // What the limit counts is wrong answers to the two things only the person
  // at the packet can know: the printed serial and the transfer key. A refusal
  // for a vague GPS fix or a leg that was not dispatched yet is not a guess,
  // and counting it would lock out the real receiver because of a courier's
  // bad signal an hour earlier.
  const { rows: attemptRows } = await tx.query<{ refused: string; guesses: string }>(
    `select count(*) as refused,
            count(*) filter (where exists (
              select 1 from jsonb_array_elements(a.checks -> 'checks') c
               where c ->> 'passed' = 'false'
                 and c ->> 'reason' in ('packet_serial_mismatch', 'transfer_key_mismatch')
            )) as guesses
       from led.transfer_attempt a
      where a.leg_id = $1::uuid and a.outcome = 'refused'`,
    [req.legId],
  );
  const priorRefusals = Number(attemptRows[0]?.refused ?? 0);
  const priorGuesses = Number(attemptRows[0]?.guesses ?? 0);
  attemptNo = priorRefusals + 1;
  add(
    "attempt_rate",
    priorGuesses < TRANSFER_KEY_ATTEMPT_LIMIT,
    `${priorGuesses} wrong serial or key entr${priorGuesses === 1 ? "y" : "ies"} on this leg before this one (limit ${TRANSFER_KEY_ATTEMPT_LIMIT}); ${priorRefusals} refusal(s) in all`,
    "duplicate_session",
  );

  const denyReasons = [
    ...new Set(checks.filter((c) => c.passed === false && c.reason).map((c) => c.reason!)),
  ];
  const granted = checks.every((c) => c.passed !== false);
  const thisIsAGuess = checks.some(
    (c) =>
      c.passed === false &&
      (c.reason === "packet_serial_mismatch" || c.reason === "transfer_key_mismatch"),
  );

  return {
    outcome: granted ? "granted" : "refused",
    checks,
    denyReasons,
    attemptNo,
    // The alert fires on the wrong answer that reaches the limit, not after it,
    // so nobody gets three free guesses and a silent fourth. Once, not on every
    // refusal after: the leg is locked by then and the control room already knows.
    raisesAlert: thisIsAGuess && priorGuesses + 1 === TRANSFER_KEY_ATTEMPT_LIMIT,
    context,
  };
}

/**
 * Write the attempt down, then let the caller answer.
 *
 * Separate from the decision so the order is visible at the call site: decide,
 * record, respond. A refusal that was never written is a refusal that never
 * happened as far as any later enquiry is concerned, and the probing attempts
 * — a leg id that does not exist, a person who is not registered — are the ones
 * most worth keeping.
 */
export async function recordTransferAttempt(
  tx: PoolClient,
  req: TransferRequest,
  decision: TransferDecision,
): Promise<void> {
  const { rows: known } = await tx.query<{
    leg_id: string | null;
    person_id: string | null;
    device_id: string | null;
  }>(
    `select (select id from ref.route_leg where id = $1::uuid) as leg_id,
            (select id from ref.person    where id = $2::uuid) as person_id,
            (select id from ref.device    where id = $3::uuid) as device_id`,
    [req.legId, req.personId ?? null, req.deviceId],
  );
  const ref = known[0];

  await tx.query(
    `insert into led.transfer_attempt
       (leg_id, person_id, device_id, seam_id_seen, serial_typed, checks, outcome, attempt_no)
     values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, $8)`,
    [
      ref?.leg_id ?? null,
      ref?.person_id ?? null,
      ref?.device_id ?? null,
      req.seamIdRead ?? null,
      req.packetSerialTyped ?? null,
      JSON.stringify({ step: req.step, checks: decision.checks, context: decision.context }),
      decision.outcome,
      decision.attemptNo,
    ],
  );
}
