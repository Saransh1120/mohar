import type { PoolClient } from "pg";
import { digestKey, epochAt, keyMatches } from "@mohar/crypto-core";

/**
 * ── The access decision engine ───────────────────────────────────────────────
 *
 * Deny by default. A request starts refused and every check must positively
 * pass for it to be granted; there is no path through this function that
 * returns `granted` without having evaluated all of them.
 *
 * Two rules shape everything here:
 *
 *  1. **Evaluate every check, always.** We never short-circuit on the first
 *     failure. An attempt that trips four checks is a different event from one
 *     that trips a clock skew, and an investigator needs the whole set. The
 *     cost is a few extra comparisons; the benefit is that the record is
 *     complete the first time, because there is no second chance to observe an
 *     attempt that already happened.
 *
 *  2. **Record the evidence, not just the verdict.** Distance in metres, not
 *     "outside geofence". The epoch presented and the epoch current, not
 *     "expired". A verdict without its inputs cannot be re-examined later, and
 *     this record has to stand up as an FIR annexure.
 */

export type DenyReasonCode =
  | "key_not_presented"
  | "key_unknown"
  | "key_wrong_stage"
  | "key_wrong_package"
  | "key_expired"
  | "key_not_yet_valid"
  | "key_revoked"
  | "device_unknown"
  | "device_revoked"
  | "device_not_bound_to_centre"
  | "person_not_on_roster"
  | "person_role_not_permitted"
  | "outside_geofence"
  | "geo_missing"
  | "geo_accuracy_insufficient"
  | "outside_custody_window"
  | "clock_skew_excessive"
  | "seal_serial_mismatch"
  | "seal_serial_not_read"
  | "package_compromised"
  | "package_already_opened"
  | "package_state_unexpected"
  | "exam_suspended"
  // -- hardware, evaluated only at the unlock stage --
  | "biometric_primary_missing"
  | "biometric_secondary_missing"
  | "two_person_window_not_met"
  | "occupancy_contradicts_two_person"
  | "witness_frame_missing";

/** Every check the engine runs, so a granted decision can list what it verified. */
export type CheckName =
  | "key_presented"
  | "key_valid"
  | "key_in_window"
  | "key_stage_match"
  | "device_enrolled"
  | "device_binding"
  | "roster_membership"
  | "role_permitted"
  | "geofence"
  | "geo_accuracy"
  | "custody_window"
  | "clock_skew"
  | "seal_serial"
  | "package_state"
  | "exam_active"
  // -- the six the hardware layer adds (docs/12 Part F) --
  | "biometric_primary"
  | "biometric_secondary"
  | "two_person_copresence"
  | "occupancy_corroborated"
  | "seal_lock_intact"
  | "witness_capture";

export interface AccessRequest {
  packageId: string;
  stage: string;
  /** The custody key as typed or scanned. Absent is itself a denial reason. */
  presentedKey?: string | undefined;
  deviceId: string;
  personId?: string | undefined;
  sealSerialRead?: string | undefined;
  geo?: { lat: number; lon: number; accuracyM: number } | undefined;
  /** Device clock at the moment of the attempt. */
  occurredAt: string;
  sessionId: string;
}

/** One evaluated check, with the evidence that decided it. */
export interface CheckResult {
  check: CheckName;
  passed: boolean;
  /** What was actually observed. Present whether the check passed or failed. */
  evidence: string;
  reason?: DenyReasonCode;
}

export interface AccessDecision {
  outcome: "granted" | "denied";
  checks: CheckResult[];
  denyReasons: DenyReasonCode[];
  checksPassed: CheckName[];
  /** Forensic context captured at decision time. */
  context: {
    stage: string;
    expectedRole: string | null;
    currentEpoch: number;
    keyEpoch: number | null;
    keyId: string | null;
    presentedFingerprint: string | null;
    distanceM: number | null;
    geofenceM: number | null;
    clockSkewMs: number;
    deviceKind: string | null;
    actorRole: string | null;
    packageState: string | null;
    sealSerialRegistered: string | null;
  };
}

const MAX_SKEW_MS = 2 * 60 * 1000; // matches ACCESS_CLOCK_SKEW_SECONDS in .env
const MAX_ACCURACY_M = 50;

/** Haversine, metres. Mirrors the SQL function in 001_init. */
function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function decideAccess(
  tx: PoolClient,
  req: AccessRequest,
): Promise<AccessDecision> {
  const checks: CheckResult[] = [];
  const add = (
    check: CheckName,
    passed: boolean,
    evidence: string,
    reason?: DenyReasonCode,
  ) => {
    checks.push({ check, passed, evidence, ...(reason && !passed ? { reason } : {}) });
  };

  const now = new Date();
  const currentEpoch = epochAt(now);

  // ── load everything the decision depends on, once ──
  const { rows: pkgRows } = await tx.query(
    `select p.id, p.state, p.seal_serial, p.custody_from, p.custody_to,
            p.centre_id, p.exam_id,
            c.code as centre_code, c.lat, c.lon, c.geofence_m,
            e.suspended_at, e.starts_at
       from ref.package p
       join ref.centre c on c.id = p.centre_id
       join ref.exam   e on e.id = p.exam_id
      where p.id = $1`,
    [req.packageId],
  );
  const pkg = pkgRows[0];

  const { rows: stageRows } = await tx.query(
    "select stage, expected_role from led.custody_stage where stage = $1",
    [req.stage],
  );
  const stageDef = stageRows[0];

  const { rows: devRows } = await tx.query(
    "select id, kind, centre_id, revoked_at from ref.device where id = $1",
    [req.deviceId],
  );
  const device = devRows[0];

  let actorRole: string | null = null;
  if (req.personId) {
    const { rows } = await tx.query("select role from ref.person where id = $1", [
      req.personId,
    ]);
    actorRole = rows[0]?.role ?? null;
  }

  // ── 1. the custody key ──
  let keyId: string | null = null;
  let keyEpoch: number | null = null;
  let presentedFingerprint: string | null = null;

  if (!req.presentedKey) {
    add("key_presented", false, "no key was presented with this request", "key_not_presented");
    add("key_valid", false, "not evaluated — nothing was presented");
    add("key_in_window", false, "not evaluated — nothing was presented");
    add("key_stage_match", false, "not evaluated — nothing was presented");
  } else {
    add("key_presented", true, "a key was presented");

    // Match against every key ever issued for this package, not merely the
    // current one. A key from a previous epoch must be told apart from a key we
    // never issued: the first is a stale credential, the second is someone
    // guessing, and those call for very different responses.
    const { rows: keyRows } = await tx.query(
      `select id, stage, epoch, key_hash, fingerprint, valid_from, valid_to,
              revoked_at, revoked_reason, package_id
         from led.access_key
        where package_id = $1
        order by epoch desc`,
      [req.packageId],
    );

    const matched = keyRows.find((k) =>
      keyMatches(req.presentedKey!, Buffer.from(k.key_hash).toString("hex")),
    );

    if (!matched) {
      // Fingerprint what they presented anyway, so a repeated wrong key is
      // recognisable across attempts even though we cannot say whose it is.
      presentedFingerprint = digestKey(req.presentedKey).fingerprint;
      add(
        "key_valid",
        false,
        `presented key ${presentedFingerprint} matches nothing ever issued for this package`,
        "key_unknown",
      );
      add("key_in_window", false, "not evaluated — key unrecognised");
      add("key_stage_match", false, "not evaluated — key unrecognised");
    } else {
      keyId = matched.id;
      keyEpoch = Number(matched.epoch);
      presentedFingerprint = matched.fingerprint;

      if (matched.revoked_at) {
        add(
          "key_valid",
          false,
          `key ${matched.fingerprint} was revoked at ${(matched.revoked_at as Date).toISOString()}` +
            `${matched.revoked_reason ? ` (${matched.revoked_reason})` : ""}`,
          "key_revoked",
        );
      } else {
        add("key_valid", true, `key ${matched.fingerprint} issued for epoch ${keyEpoch}`);
      }

      const from = matched.valid_from as Date;
      const to = matched.valid_to as Date;
      if (now < from) {
        add(
          "key_in_window",
          false,
          `key becomes valid at ${from.toISOString()}, ${Math.round((from.getTime() - now.getTime()) / 60000)} minutes from now`,
          "key_not_yet_valid",
        );
      } else if (now > to) {
        const ageH = (now.getTime() - to.getTime()) / 3_600_000;
        add(
          "key_in_window",
          false,
          `key expired at ${to.toISOString()}, ${ageH.toFixed(1)} hours ago ` +
            `(presented epoch ${keyEpoch}, current epoch ${currentEpoch})`,
          "key_expired",
        );
      } else {
        add(
          "key_in_window",
          true,
          `within window ${from.toISOString()} → ${to.toISOString()}`,
        );
      }

      if (matched.stage !== req.stage) {
        add(
          "key_stage_match",
          false,
          `key authorises stage "${matched.stage}" but "${req.stage}" was requested`,
          "key_wrong_stage",
        );
      } else {
        add("key_stage_match", true, `key authorises stage "${req.stage}"`);
      }
    }
  }

  // ── 2. the device ──
  if (!device) {
    add("device_enrolled", false, `device ${req.deviceId} is not enrolled`, "device_unknown");
    add("device_binding", false, "not evaluated — device unknown");
  } else {
    if (device.revoked_at) {
      add(
        "device_enrolled",
        false,
        `device revoked at ${(device.revoked_at as Date).toISOString()}`,
        "device_revoked",
      );
    } else {
      add("device_enrolled", true, `${device.kind} device, enrolled and active`);
    }

    // A centre PC bound to centre A must not authorise a package at centre B.
    // Field devices travel by design, so the binding only applies where one exists.
    if (device.centre_id && pkg && device.centre_id !== pkg.centre_id) {
      add(
        "device_binding",
        false,
        `device is bound to a different centre than ${pkg.centre_code}`,
        "device_not_bound_to_centre",
      );
    } else {
      add(
        "device_binding",
        true,
        device.centre_id ? `bound to ${pkg?.centre_code ?? "this centre"}` : "not centre-bound",
      );
    }
  }

  // ── 3. the person ──
  if (!pkg) {
    add("roster_membership", false, "not evaluated — unknown package");
    add("role_permitted", false, "not evaluated — unknown package");
  } else if (!req.personId) {
    add("roster_membership", false, "no person identified on the request", "person_not_on_roster");
    add("role_permitted", false, "not evaluated — no person identified");
  } else {
    const { rows } = await tx.query(
      `select valid_from, valid_to from ref.roster
        where exam_id = $1 and centre_id = $2 and person_id = $3`,
      [pkg.exam_id, pkg.centre_id, req.personId],
    );
    const entry = rows[0];
    if (!entry) {
      add(
        "roster_membership",
        false,
        `person is not rostered at ${pkg.centre_code} for this exam`,
        "person_not_on_roster",
      );
    } else if (now < (entry.valid_from as Date) || now > (entry.valid_to as Date)) {
      add(
        "roster_membership",
        false,
        `rostered only between ${(entry.valid_from as Date).toISOString()} and ` +
          `${(entry.valid_to as Date).toISOString()}`,
        "person_not_on_roster",
      );
    } else {
      add("roster_membership", true, `rostered at ${pkg.centre_code} for this window`);
    }

    if (stageDef && actorRole !== stageDef.expected_role) {
      add(
        "role_permitted",
        false,
        `stage "${req.stage}" expects a ${stageDef.expected_role}; this person is a ${actorRole ?? "unknown role"}`,
        "person_role_not_permitted",
      );
    } else {
      add("role_permitted", true, `${actorRole} may act at stage "${req.stage}"`);
    }
  }

  // ── 4. position ──
  //
  // The geofence exists to establish that the requesting device is at the
  // centre. For a phone that means a position fix, because a phone could be
  // anywhere. For hardware bolted to the wall it does not: a station or a
  // centre PC is placed at accreditation and bound to its centre at enrolment,
  // and that binding is a stronger statement about where it is than a radio fix
  // ever was.
  //
  // Demanding a fix from a stationary device would also be demanding something
  // it cannot honestly produce. The room monitor has no GNSS at all, and a
  // laptop indoors reports Wi-Fi triangulation accurate to a hundred metres or
  // worse — so the check could only ever be satisfied by inventing a number.
  //
  // So a device bound to this package's centre is located by that binding, and
  // the evidence says so in those words rather than claiming a fix nobody took.
  // Anything else — a field phone, an unbound device — still has to produce one.
  const locatedByBinding =
    !!pkg &&
    !!device &&
    (device.kind === "monitor" || device.kind === "centre_pc") &&
    device.centre_id === pkg.centre_id;

  let dist: number | null = null;
  if (!pkg) {
    add("geofence", false, "not evaluated — unknown package");
    add("geo_accuracy", false, "not evaluated — unknown package");
  } else if (locatedByBinding) {
    add(
      "geofence",
      true,
      `fixed ${device.kind} enrolled against ${pkg.centre_code}; located by that ` +
        "binding rather than by a position fix",
    );
    add(
      "geo_accuracy",
      true,
      "not applicable — a device bolted to the centre is placed at accreditation, not measured",
    );
    if (req.geo) {
      // Recorded even though it decided nothing. If this device ever reports a
      // fix a long way from its own centre, somebody has moved it, and that is
      // worth being able to find afterwards.
      dist = distanceM(req.geo, { lat: pkg.lat, lon: pkg.lon });
    }
  } else if (!req.geo) {
    add("geofence", false, "no position fix accompanied this request", "geo_missing");
    add("geo_accuracy", false, "not evaluated — no fix");
  } else {
    dist = distanceM(req.geo, { lat: pkg.lat, lon: pkg.lon });
    if (dist > pkg.geofence_m) {
      add(
        "geofence",
        false,
        `${Math.round(dist)} m from ${pkg.centre_code}, geofence is ${pkg.geofence_m} m`,
        "outside_geofence",
      );
    } else {
      add("geofence", true, `${Math.round(dist)} m from ${pkg.centre_code} (within ${pkg.geofence_m} m)`);
    }

    if (req.geo.accuracyM > MAX_ACCURACY_M) {
      add(
        "geo_accuracy",
        false,
        `fix accurate only to ${Math.round(req.geo.accuracyM)} m — too imprecise to place the device inside a ${pkg.geofence_m} m fence`,
        "geo_accuracy_insufficient",
      );
    } else {
      add("geo_accuracy", true, `fix accurate to ${Math.round(req.geo.accuracyM)} m`);
    }
  }

  // ── 5. time ──
  const skewMs = Date.parse(req.occurredAt) - now.getTime();
  if (Math.abs(skewMs) > MAX_SKEW_MS) {
    add(
      "clock_skew",
      false,
      `device clock is ${Math.round(skewMs / 1000)} s from server time (tolerance ±${MAX_SKEW_MS / 1000} s)`,
      "clock_skew_excessive",
    );
  } else {
    add("clock_skew", true, `device clock within ${Math.round(skewMs / 1000)} s of server`);
  }

  if (!pkg) {
    add("custody_window", false, "not evaluated — unknown package");
  } else if (!pkg.custody_from || !pkg.custody_to) {
    add("custody_window", true, "no custody window configured for this package");
  } else {
    const from = pkg.custody_from as Date;
    const to = pkg.custody_to as Date;
    if (now < from) {
      const h = (from.getTime() - now.getTime()) / 3_600_000;
      add(
        "custody_window",
        false,
        `custody window opens at ${from.toISOString()} — ${h.toFixed(1)} hours from now`,
        "outside_custody_window",
      );
    } else if (now > to) {
      add(
        "custody_window",
        false,
        `custody window closed at ${to.toISOString()}`,
        "outside_custody_window",
      );
    } else {
      add("custody_window", true, `inside window ${from.toISOString()} → ${to.toISOString()}`);
    }
  }

  // ── 6. the seal ──
  if (!pkg) {
    add("seal_serial", false, "not evaluated — unknown package");
  } else if (!req.sealSerialRead) {
    add("seal_serial", false, "seal serial was not read at the point of access", "seal_serial_not_read");
  } else if (pkg.seal_serial && req.sealSerialRead !== pkg.seal_serial) {
    add(
      "seal_serial",
      false,
      `read "${req.sealSerialRead}" but "${pkg.seal_serial}" is registered — treat the package as compromised`,
      "seal_serial_mismatch",
    );
  } else {
    add("seal_serial", true, `serial "${req.sealSerialRead}" matches the registered seal`);
  }

  // ── 7. package and exam state ──
  if (!pkg) {
    add("package_state", false, `package ${req.packageId} does not exist`, "package_state_unexpected");
    add("exam_active", false, "not evaluated — unknown package");
  } else {
    if (pkg.state === "compromised") {
      add("package_state", false, "package is marked compromised", "package_compromised");
    } else if (pkg.state === "opened" && req.stage === "unlock") {
      add("package_state", false, "package has already been opened", "package_already_opened");
    } else {
      add("package_state", true, `package state is "${pkg.state}"`);
    }

    if (pkg.suspended_at) {
      add(
        "exam_active",
        false,
        `exam suspended at ${(pkg.suspended_at as Date).toISOString()}`,
        "exam_suspended",
      );
    } else {
      add("exam_active", true, "exam is active");
    }
  }

  // -- 8. the hardware layer --
  if (req.stage === "unlock") {
    await addWitnessChecks(tx, req, pkg?.centre_id ?? null, add);
  }

  const denyReasons = [
    ...new Set(checks.filter((c) => !c.passed && c.reason).map((c) => c.reason!)),
  ];
  const checksPassed = checks.filter((c) => c.passed).map((c) => c.check);

  return {
    outcome: denyReasons.length === 0 ? "granted" : "denied",
    checks,
    denyReasons,
    checksPassed,
    context: {
      stage: req.stage,
      expectedRole: stageDef?.expected_role ?? null,
      currentEpoch,
      keyEpoch,
      keyId,
      presentedFingerprint,
      distanceM: dist,
      geofenceM: pkg?.geofence_m ?? null,
      clockSkewMs: skewMs,
      deviceKind: device?.kind ?? null,
      actorRole,
      packageState: pkg?.state ?? null,
      sealSerialRegistered: pkg?.seal_serial ?? null,
    },
  };
}

// ── the hardware layer ───────────────────────────────────────────────────────

/** How far back to look for the ceremony that accompanies this unlock. */
const WITNESS_LOOKBACK_MINUTES = 30;

/**
 * The six checks the witness station and room monitor add, applied only at the
 * unlock stage.
 *
 * **Binding only where the hardware exists.** A centre that has never produced a
 * witness event does not have a station, and refusing its unlock for the absence
 * of evidence no device was ever installed to produce would be a denial about
 * our procurement rather than about the exam. So the checks are recorded either
 * way and contribute deny reasons only once a centre has demonstrably been
 * fitted. Every check still states what it observed, including "no witness
 * station has ever reported from this centre" — an unevaluated check is never
 * silently reported as passed.
 *
 * The evidence is read from the chain, not from a live query to the device. A
 * station unplugged at 08:51 cannot retract what it signed at 08:50, and the
 * engine reading the ledger rather than the wire is what makes that true.
 */
async function addWitnessChecks(
  tx: PoolClient,
  req: AccessRequest,
  centreId: string | null,
  add: (c: CheckName, passed: boolean, evidence: string, reason?: DenyReasonCode) => void,
): Promise<void> {
  interface WitnessRow {
    kind: string;
    occurred_at: Date;
    body: { actorDeviceId: string; payload: Record<string, unknown> };
  }

  const { rows } = await tx.query<WitnessRow>(
    `select kind, occurred_at, body
       from led.event
      where kind in ('WITNESS_ASSERTED','WITNESS_CEREMONY','ROOM_ENTRY','WITNESS_FRAME')
        and (package_id = $1 or (package_id is null and centre_id = $2))
        and occurred_at > now() - ($3 || ' minutes')::interval
      order by occurred_at asc`,
    [req.packageId, centreId, String(WITNESS_LOOKBACK_MINUTES)],
  );

  // Has this centre ever been fitted? Asked of the chain, not the registry:
  // `ref.device.kind` cannot tell a witness station from a room monitor, and
  // what matters is whether a device has ever actually reported from here.
  const { rows: everRows } = await tx.query<{ witness: string; monitor: string }>(
    `select count(*) filter (where kind in ('WITNESS_ASSERTED','WITNESS_CEREMONY')) as witness,
            count(*) filter (where kind = 'ROOM_ENTRY') as monitor
       from led.event
      where centre_id = $1`,
    [centreId],
  );
  const hasWitnessStation = Number(everRows[0]?.witness ?? 0) > 0;
  const hasRoomMonitor = Number(everRows[0]?.monitor ?? 0) > 0;

  const assertions = rows.filter((r) => r.kind === "WITNESS_ASSERTED");
  const frames = rows.filter((r) => r.kind === "WITNESS_FRAME");
  const ceremonies = rows.filter((r) => r.kind === "WITNESS_CEREMONY");
  const roomEntries = rows.filter((r) => r.kind === "ROOM_ENTRY");

  const primary = assertions.find((a) => a.body.payload["role"] === "superintendent");
  const secondary = assertions.find(
    (a) =>
      a.body.payload["role"] === "observer" &&
      a.body.payload["templateSlot"] !== primary?.body.payload["templateSlot"],
  );

  const unfitted = (what: string) =>
    `not evaluated — no ${what} has ever reported from this centre`;

  /**
   * Turn a template slot into a person.
   *
   * The chain deliberately holds only "slot 3 matched"; who slot 3 is lives in
   * `ref.fingerprint_enrolment`, which is reference data and can be corrected.
   * Resolved *as at the time of the assertion*, not as at now: a slot retired
   * and reassigned last week must not rewrite who a record from last month
   * refers to.
   *
   * An unmapped slot is reported as unmapped rather than quietly dropped. A
   * fingerprint that matched a template nobody registered is a real finding —
   * it means someone enrolled a finger on this station outside the process.
   */
  const nameFor = async (row: WitnessRow | undefined): Promise<string> => {
    if (!row) return "";
    const slot = Number(row.body.payload["templateSlot"]);
    const { rows: who } = await tx.query<{ display_name: string; role: string }>(
      `select p.display_name, e.role
         from ref.fingerprint_enrolment e
         join ref.person p on p.id = e.person_id
        where e.device_id = $1
          and e.template_slot = $2
          and e.enrolled_at <= $3
          and (e.revoked_at is null or e.revoked_at > $3)
        order by e.enrolled_at desc
        limit 1`,
      [row.body.actorDeviceId, slot, row.occurred_at],
    );
    const hit = who[0];
    return hit
      ? `${hit.display_name} (${hit.role}, slot ${slot})`
      : `slot ${slot} — not mapped to anyone on the roster`;
  };

  const primaryWho = await nameFor(primary);
  const secondaryWho = await nameFor(secondary);

  // ── 16. biometric_primary ──
  if (!hasWitnessStation) {
    add("biometric_primary", false, unfitted("witness station"));
  } else if (primary) {
    add(
      "biometric_primary",
      true,
      `${primaryWho} matched at score ${primary.body.payload["matchScore"]}`,
    );
  } else {
    add(
      "biometric_primary",
      false,
      `no superintendent assertion in the last ${WITNESS_LOOKBACK_MINUTES} minutes`,
      "biometric_primary_missing",
    );
  }

  // ── 17. biometric_secondary ──
  if (!hasWitnessStation) {
    add("biometric_secondary", false, unfitted("witness station"));
  } else if (secondary) {
    add(
      "biometric_secondary",
      true,
      `${secondaryWho} matched at score ${secondary.body.payload["matchScore"]}, ` +
        "a different template from the first",
    );
  } else {
    add(
      "biometric_secondary",
      false,
      assertions.length > 1
        ? "a second assertion exists but matched the same template — one person twice is not two people"
        : `no observer assertion in the last ${WITNESS_LOOKBACK_MINUTES} minutes`,
      "biometric_secondary_missing",
    );
  }

  // ── 18. two_person_copresence ──
  const confirmed = ceremonies.find(
    (c) => c.body.payload["outcome"] === "two_person_confirmed",
  );
  if (!hasWitnessStation) {
    add("two_person_copresence", false, unfitted("witness station"));
  } else if (confirmed && primary && secondary) {
    const gapS = Math.round(
      Math.abs(secondary.occurred_at.getTime() - primary.occurred_at.getTime()) / 1000,
    );
    add(
      "two_person_copresence",
      true,
      `assertions ${gapS} s apart, inside the ${confirmed.body.payload["windowSeconds"]} s window`,
    );
  } else {
    const last = ceremonies[ceremonies.length - 1];
    add(
      "two_person_copresence",
      false,
      last
        ? `the station closed the window as "${last.body.payload["outcome"]}"`
        : "the station never reported a completed two-person window",
      "two_person_window_not_met",
    );
  }

  // ── 19. occupancy_corroborated ──
  // Corroboration, never primary evidence. The counts are floors: two people
  // abreast through a wide door register as one, so a monitor reporting fewer
  // than two is not proof that fewer than two were present.
  if (!hasRoomMonitor) {
    add("occupancy_corroborated", false, unfitted("room monitor"));
  } else if (roomEntries.length === 0) {
    add(
      "occupancy_corroborated",
      false,
      `the room monitor reported nothing in the last ${WITNESS_LOOKBACK_MINUTES} minutes`,
      "occupancy_contradicts_two_person",
    );
  } else {
    const entered = roomEntries.reduce(
      (n, r) => n + Number(r.body.payload["enteredAtLeast"] ?? 0),
      0,
    );
    const latest = roomEntries[roomEntries.length - 1]!;
    const presence = latest.body.payload["presence"] === true;
    const consistent = presence && entered >= 1;
    add(
      "occupancy_corroborated",
      consistent,
      `monitor reports at least ${entered} entered and presence ` +
        `${presence ? "detected" : "not detected"}; counts are floors, not exact`,
      consistent ? undefined : "occupancy_contradicts_two_person",
    );
  }

  // ── 20. seal_lock_intact ──
  // The electronic seal lock is a later phase and has no event kind yet.
  // Recorded as unevaluated rather than quietly counted as passed: a check
  // nobody ran must never look like a check that succeeded.
  add(
    "seal_lock_intact",
    false,
    "not evaluated — the electronic seal lock is not implemented (docs/12 Part D)",
  );

  // ── 21. witness_capture ──
  // A frame counts whether the station took it itself or the centre PC did.
  // Where they came from is recorded in the events; what this check establishes
  // is only that a photograph of this moment was committed at the time.
  const onStation = assertions.filter(
    (a) => Number(a.body.payload["frameBytes"] ?? 0) > 0,
  );
  const total = onStation.length + frames.length;

  if (!hasWitnessStation) {
    add("witness_capture", false, unfitted("witness station"));
  } else if (total > 0) {
    const firstHash = String(
      (onStation[0] ?? frames[0])!.body.payload["frameSha256"],
    ).slice(0, 24);
    const source =
      onStation.length > 0 && frames.length > 0
        ? "station and centre PC"
        : onStation.length > 0
          ? "the station"
          : "the centre PC";
    add(
      "witness_capture",
      true,
      `${total} frame hash(es) committed by ${source}, first ${firstHash}…`,
    );
  } else {
    add(
      "witness_capture",
      false,
      assertions.length > 0
        ? "assertions were recorded but no photograph was committed for any of them"
        : "no assertion carried a frame",
      "witness_frame_missing",
    );
  }
}
