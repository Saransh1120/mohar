import type { Pool, PoolClient } from "pg";
import type { DenyReason } from "@mohar/contracts";
import type { ChainEventOutcome } from "./service-events.js";
import { recordDwellEvent, recordExitEvent, recordFootfallEvent } from "./strongroom-events.js";

/**
 * ── The strong room door ─────────────────────────────────────────────────────
 *
 * The door is gated, not only the packet. A packet in a strong room sits for
 * days, and "who was in there at 03:00" is the question an enquiry asks; a
 * record kept only when something is moved cannot answer it. So every entry and
 * every exit is an attempt, decided and written down, whether or not a packet
 * is touched.
 *
 * It follows the access engine and the hand-off engine:
 *
 *  1. **Deny by default.** The door opens to two people, each verified, or not
 *     at all.
 *  2. **Evaluate everything, always.** One person alone at the door who is also
 *     not on record and whose finger scored 31 is three findings, not one.
 *  3. **Record the evidence, not the verdict.** Seconds between the two
 *     fingers, the score, the slot, minutes inside against minutes expected.
 *
 * Footfall is read from the chain events the room's own monitor signed, not
 * from anything the entry request says. A request can claim two people; the
 * monitor counted what it counted.
 */

export type DoorCheckName =
  | "room_known"
  | "device_enrolled"
  | "device_signature"
  | "two_entrants"
  | "persons_registered"
  | "roles_permitted"
  | "slots_registered"
  | "distinct_fingers"
  | "biometric_scores"
  | "faces_matched"
  | "two_person_window"
  | "clock_skew"
  | "visit_open";

export interface DoorCheckResult {
  check: DoorCheckName;
  /** Undefined where the check could not be run. Not run is not passed. */
  passed: boolean | undefined;
  evidence: string;
  reason?: DenyReason;
}

export interface Entrant {
  personId: string;
  biometricSlot?: number | undefined;
  biometricScore?: number | undefined;
  /** From the face check at the door. Absent means no face reading was taken. */
  faceMatched?: boolean | undefined;
  /** When this person's finger matched, by the door device's clock. */
  assertedAt: string;
}

export interface EntryRequest {
  roomId: string;
  deviceId: string;
  entrants: Entrant[];
  /** What they are going in to do, in the operator's words. */
  task: string;
  expectedMinutes: number;
  occurredAt: string;
  /** What the gateway established about who signed the request. See gateway-guard. */
  deviceSigned?: { passed: boolean | undefined; evidence: string } | undefined;
}

export interface ExitRequest {
  roomId: string;
  visitId: string;
  deviceId: string;
  packagesTouched: number;
  occurredAt: string;
  deviceSigned?: { passed: boolean | undefined; evidence: string } | undefined;
}

export interface DoorDecision {
  outcome: "granted" | "refused";
  checks: DoorCheckResult[];
  denyReasons: DenyReason[];
  context: {
    roomName: string | null;
    monitorDeviceId: string | null;
    secondsBetween: number | null;
    /** Visits to this room with no exit on record at the moment of the attempt. */
    openVisits: number;
    clockSkewMs: number;
  };
}

/** Both fingers inside this many seconds, or it is not two people together. */
export const TWO_PERSON_WINDOW_S = 120;
const MAX_SKEW_MS = 2 * 60 * 1000;
/** The R307 reports 0–255. Below 60 the reader itself calls a match doubtful. */
const MIN_BIOMETRIC_SCORE = 60;

/** Who may be let into a strong room at all. */
export const DOOR_ROLES: readonly string[] = Object.freeze([
  "custodian",
  "district_officer",
  "police_escort",
  "observer",
  "superintendent",
]);

interface DeviceRow {
  id: string;
  kind: string;
  revoked_at: Date | null;
}

async function loadDevice(tx: PoolClient, id: string): Promise<DeviceRow | undefined> {
  const { rows } = await tx.query<DeviceRow>(
    "select id, kind, revoked_at from ref.device where id = $1::uuid",
    [id],
  );
  return rows[0];
}

function signatureCheck(
  proof: { passed: boolean | undefined; evidence: string } | undefined,
): DoorCheckResult {
  return {
    check: "device_signature",
    passed: proof?.passed,
    evidence: proof?.evidence ?? "not evaluated: nothing was reported about who signed this request",
    ...(proof?.passed === false ? { reason: "device_signature_mismatch" as const } : {}),
  };
}

function deviceCheck(device: DeviceRow | undefined, id: string): DoorCheckResult {
  const passed = Boolean(device) && !device?.revoked_at;
  return {
    check: "device_enrolled",
    passed,
    evidence: device
      ? device.revoked_at
        ? `device ${device.id} was revoked at ${device.revoked_at.toISOString()}`
        : `device ${device.id} (${device.kind}) is enrolled`
      : `device ${id} is not enrolled`,
    ...(passed ? {} : { reason: device?.revoked_at ? "device_revoked" : "device_unknown" }),
  };
}

function finish(checks: DoorCheckResult[], context: DoorDecision["context"]): DoorDecision {
  return {
    outcome: checks.every((c) => c.passed !== false) ? "granted" : "refused",
    checks,
    denyReasons: [
      ...new Set(checks.filter((c) => c.passed === false && c.reason).map((c) => c.reason!)),
    ],
    context,
  };
}

/** Decide whether the door opens. Reads only; the caller records and then acts. */
export async function decideEntry(tx: PoolClient, req: EntryRequest): Promise<DoorDecision> {
  const checks: DoorCheckResult[] = [];
  const add = (
    check: DoorCheckName,
    passed: boolean | undefined,
    evidence: string,
    reason?: DenyReason,
  ) => {
    checks.push({ check, passed, evidence, ...(reason && passed === false ? { reason } : {}) });
  };
  const now = new Date();
  const context: DoorDecision["context"] = {
    roomName: null,
    monitorDeviceId: null,
    secondsBetween: null,
    openVisits: 0,
    clockSkewMs: 0,
  };

  // ── the room ──
  const { rows: roomRows } = await tx.query<{
    id: string;
    name: string;
    place: string;
    monitor_device_id: string | null;
  }>("select id, name, place, monitor_device_id from ref.strong_room where id = $1::uuid", [
    req.roomId,
  ]);
  const room = roomRows[0];
  add(
    "room_known",
    Boolean(room),
    room ? `${room.name}, ${room.place}` : `no strong room with id ${req.roomId}`,
    "room_unknown",
  );
  if (room) {
    context.roomName = room.name;
    context.monitorDeviceId = room.monitor_device_id;
    const { rows } = await tx.query<{ n: number }>(
      `select count(*)::int as n from led.strongroom_visit v
        where v.room_id = $1::uuid
          and not exists (select 1 from led.strongroom_exit x where x.visit_id = v.id)`,
      [req.roomId],
    );
    context.openVisits = rows[0]?.n ?? 0;
  }

  // ── the device at the door ──
  const device = await loadDevice(tx, req.deviceId);
  checks.push(deviceCheck(device, req.deviceId));
  checks.push(signatureCheck(req.deviceSigned));

  const skewMs = Math.abs(now.getTime() - new Date(req.occurredAt).getTime());
  context.clockSkewMs = Number.isFinite(skewMs) ? skewMs : Number.MAX_SAFE_INTEGER;
  add(
    "clock_skew",
    context.clockSkewMs <= MAX_SKEW_MS,
    `door device clock differs from the server by ${Math.round(context.clockSkewMs / 1000)}s ` +
      `(limit ${MAX_SKEW_MS / 1000}s)`,
    "clock_skew_excessive",
  );

  // ── two people, and they are two different people ──
  const distinctPersons = new Set(req.entrants.map((e) => e.personId)).size;
  add(
    "two_entrants",
    req.entrants.length === 2 && distinctPersons === 2,
    req.entrants.length === 2
      ? distinctPersons === 2
        ? "two different people presented"
        : "the same person was presented twice; the door takes two people"
      : `${req.entrants.length} ${req.entrants.length === 1 ? "person" : "people"} presented; the door takes exactly two`,
    "two_person_required",
  );

  // ── who they are ──
  const ids = [...new Set(req.entrants.map((e) => e.personId))];
  const { rows: people } = await tx.query<{ id: string; display_name: string; role: string }>(
    "select id, display_name, role from ref.person where id = any($1::uuid[])",
    [ids],
  );
  const byId = new Map(people.map((p) => [p.id, p]));
  const unknown = ids.filter((id) => !byId.has(id));
  add(
    "persons_registered",
    req.entrants.length > 0 && unknown.length === 0,
    req.entrants.length === 0
      ? "nobody was named on the attempt"
      : unknown.length === 0
        ? people.map((p) => `${p.display_name} (${p.role})`).join(" and ")
        : `not registered: ${unknown.join(", ")}`,
    "person_not_on_roster",
  );

  if (people.length === 0) {
    add("roles_permitted", undefined, "not evaluated: no registered person was named");
  } else {
    const barred = people.filter((p) => !DOOR_ROLES.includes(p.role));
    add(
      "roles_permitted",
      barred.length === 0,
      barred.length === 0
        ? `roles ${people.map((p) => p.role).join(" and ")} may enter a strong room`
        : `${barred.map((p) => `${p.display_name} is ${p.role}`).join("; ")}; ` +
          `a strong room admits ${DOOR_ROLES.join(", ")}`,
      "person_role_not_permitted",
    );
  }

  // ── the fingers ──
  const withFinger = req.entrants.filter(
    (e) => e.biometricSlot !== undefined && e.biometricScore !== undefined,
  );
  if (withFinger.length < req.entrants.length || req.entrants.length === 0) {
    const missing = req.entrants.length - withFinger.length;
    add(
      "biometric_scores",
      false,
      req.entrants.length === 0
        ? "no fingerprint was presented"
        : `${missing} of ${req.entrants.length} presented no fingerprint`,
      "biometric_primary_missing",
    );
  } else {
    const weak = withFinger.filter((e) => e.biometricScore! < MIN_BIOMETRIC_SCORE);
    add(
      "biometric_scores",
      weak.length === 0,
      withFinger.map((e) => `slot ${e.biometricSlot} scored ${e.biometricScore}`).join("; ") +
        ` (minimum ${MIN_BIOMETRIC_SCORE})`,
      "biometric_primary_missing",
    );
  }

  if (!device || withFinger.length === 0) {
    add("slots_registered", undefined, "not evaluated: no device or no fingerprint to look up");
  } else {
    // The reader says "slot 4 matched". Whose finger slot 4 is comes from the
    // register, so a request cannot pair a real match with somebody else's name.
    const { rows: slots } = await tx.query<{ template_slot: number; person_id: string }>(
      `select template_slot, person_id from ref.fingerprint_enrolment
        where device_id = $1::uuid and revoked_at is null and template_slot = any($2::int[])`,
      [req.deviceId, withFinger.map((e) => e.biometricSlot)],
    );
    const owner = new Map(slots.map((s) => [s.template_slot, s.person_id]));
    const wrong = withFinger.filter((e) => owner.get(e.biometricSlot!) !== e.personId);
    add(
      "slots_registered",
      wrong.length === 0,
      wrong.length === 0
        ? `each slot is registered on this reader to the person named`
        : wrong
            .map((e) =>
              owner.has(e.biometricSlot!)
                ? `slot ${e.biometricSlot} is registered to someone other than the person named`
                : `slot ${e.biometricSlot} is not registered on this reader`,
            )
            .join("; "),
      "biometric_slot_not_registered",
    );
  }

  if (withFinger.length < 2) {
    add("distinct_fingers", undefined, "not evaluated: fewer than two fingerprints were presented");
  } else {
    const distinct = new Set(withFinger.map((e) => e.biometricSlot)).size === withFinger.length;
    add(
      "distinct_fingers",
      distinct,
      distinct
        ? `slots ${withFinger.map((e) => e.biometricSlot).join(" and ")} are different fingers`
        : `slot ${withFinger[0]!.biometricSlot} was presented twice; one finger is one person`,
      "two_person_required",
    );
  }

  // ── the faces ──
  // TODO(claim-12): "the door opens only when two people verify fingerprints
  // and faces". The check is here and is applied when a reading arrives, but no
  // device sends one: there is no camera at a door and no face matcher, so in
  // practice this is reported as not evaluated and the door opens on fingers.
  const faceRead = req.entrants.filter((e) => e.faceMatched !== undefined);
  if (faceRead.length === 0) {
    add(
      "faces_matched",
      undefined,
      "not evaluated: the door device sent no face reading for either person",
    );
  } else {
    const failed = faceRead.filter((e) => e.faceMatched === false).length;
    const unread = req.entrants.length - faceRead.length;
    add(
      "faces_matched",
      failed === 0 && unread === 0,
      `${faceRead.length - failed} of ${req.entrants.length} faces matched` +
        (unread > 0 ? `; ${unread} had no face reading` : ""),
      "face_not_matched",
    );
  }

  // ── together ──
  if (req.entrants.length !== 2) {
    add("two_person_window", undefined, "not evaluated: there are not two assertions to compare");
  } else {
    const [a, b] = req.entrants.map((e) => new Date(e.assertedAt).getTime()) as [number, number];
    const seconds = Math.abs(a - b) / 1000;
    const readable = Number.isFinite(seconds);
    if (readable) context.secondsBetween = Math.round(seconds);
    add(
      "two_person_window",
      readable && seconds <= TWO_PERSON_WINDOW_S,
      readable
        ? `${Math.round(seconds)}s between the two fingers (limit ${TWO_PERSON_WINDOW_S}s)`
        : "the times of the two assertions could not be read",
      "two_person_window_not_met",
    );
  }

  return finish(checks, context);
}

export interface VisitRow {
  id: string;
  room_id: string;
  persons: { personId: string }[];
  entered_at: Date;
  expected_minutes: number;
  exited: boolean;
}

/** Decide whether an exit can be recorded against a visit. */
export async function decideExit(
  tx: PoolClient,
  req: ExitRequest,
): Promise<{ decision: DoorDecision; visit: VisitRow | undefined }> {
  const checks: DoorCheckResult[] = [];
  const now = new Date();
  const context: DoorDecision["context"] = {
    roomName: null,
    monitorDeviceId: null,
    secondsBetween: null,
    openVisits: 0,
    clockSkewMs: 0,
  };

  const { rows: roomRows } = await tx.query<{ name: string; monitor_device_id: string | null }>(
    "select name, monitor_device_id from ref.strong_room where id = $1::uuid",
    [req.roomId],
  );
  const room = roomRows[0];
  checks.push({
    check: "room_known",
    passed: Boolean(room),
    evidence: room ? room.name : `no strong room with id ${req.roomId}`,
    ...(room ? {} : { reason: "room_unknown" as const }),
  });
  context.roomName = room?.name ?? null;
  context.monitorDeviceId = room?.monitor_device_id ?? null;

  checks.push(deviceCheck(await loadDevice(tx, req.deviceId), req.deviceId));
  checks.push(signatureCheck(req.deviceSigned));

  const skewMs = Math.abs(now.getTime() - new Date(req.occurredAt).getTime());
  context.clockSkewMs = Number.isFinite(skewMs) ? skewMs : Number.MAX_SAFE_INTEGER;
  checks.push({
    check: "clock_skew",
    passed: context.clockSkewMs <= MAX_SKEW_MS,
    evidence:
      `door device clock differs from the server by ${Math.round(context.clockSkewMs / 1000)}s ` +
      `(limit ${MAX_SKEW_MS / 1000}s)`,
    ...(context.clockSkewMs <= MAX_SKEW_MS ? {} : { reason: "clock_skew_excessive" as const }),
  });

  const { rows } = await tx.query<VisitRow>(
    `select v.id, v.room_id, v.persons, v.entered_at, v.expected_minutes,
            exists (select 1 from led.strongroom_exit x where x.visit_id = v.id) as exited
       from led.strongroom_visit v where v.id = $1::uuid`,
    [req.visitId],
  );
  const visit = rows[0];
  if (!visit || visit.room_id !== req.roomId) {
    checks.push({
      check: "visit_open",
      passed: false,
      evidence: visit
        ? `visit ${req.visitId} belongs to a different room`
        : `no visit with id ${req.visitId}`,
      reason: "visit_unknown",
    });
  } else {
    checks.push({
      check: "visit_open",
      passed: !visit.exited,
      evidence: visit.exited
        ? "an exit is already on record for this visit"
        : `entered ${visit.entered_at.toISOString()}; no exit on record yet`,
      ...(visit.exited ? { reason: "visit_already_closed" as const } : {}),
    });
  }

  return { decision: finish(checks, context), visit };
}

/** Write the attempt down. Called before anything else is done about it. */
export async function recordDoorAttempt(
  tx: PoolClient,
  kind: "entry" | "exit",
  roomId: string,
  deviceId: string,
  persons: unknown,
  extra: Record<string, unknown>,
  decision: DoorDecision,
  visitId: string | null,
): Promise<string> {
  const { rows: known } = await tx.query<{ device_id: string | null }>(
    "select (select id from ref.device where id = $1::uuid) as device_id",
    [deviceId],
  );
  const { rows } = await tx.query<{ id: string }>(
    `insert into led.strongroom_attempt (room_id, device_id, kind, persons, checks, outcome, visit_id)
     values ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6, $7::uuid)
     returning id`,
    [
      roomId,
      known[0]?.device_id ?? null,
      kind,
      JSON.stringify(persons),
      JSON.stringify({ ...extra, checks: decision.checks, context: decision.context }),
      decision.outcome,
      visitId,
    ],
  );
  return rows[0]!.id;
}

// ── how long is too long ────────────────────────────────────────────────────

export const DWELL_EXCEEDED = "DWELL_EXCEEDED";
export const FOOTFALL_MISMATCH = "FOOTFALL_MISMATCH";

/**
 * The stay at which a visit is raised for review.
 *
 * Judged against what the task was expected to take, not against an average:
 * collecting one packet and conducting an audit are both legitimate and take
 * very different times. Twice the expected time, and at least five minutes
 * over, so a four-minute task that runs to six is not an alert and one that
 * runs to forty is.
 */
export function dwellLimitSeconds(expectedMinutes: number): number {
  return Math.max(expectedMinutes * 2 * 60, expectedMinutes * 60 + 5 * 60);
}

export interface DwellFacts {
  visitId: string;
  roomId: string;
  roomName: string;
  entrants: { name: string; role: string }[];
  task: string | null;
  enteredAt: Date;
  expectedMinutes: number;
  /** Null while the people are still inside. */
  exitedAt: Date | null;
}

export interface DoorAlert {
  evidence: Record<string, unknown>;
  consequence: string;
}

const names = (e: { name: string; role: string }[]) =>
  e.map((p) => `${p.name} (${p.role.replace(/_/g, " ")})`).join(" and ") || "the people recorded";

const minutes = (seconds: number) => Math.round(seconds / 60);

/** Pure, so what the alert says can be tested without a database. */
export function describeDwell(f: DwellFacts, now: Date): DoorAlert {
  const until = f.exitedAt ?? now;
  const dwellSeconds = Math.max(0, Math.round((until.getTime() - f.enteredAt.getTime()) / 1000));
  const evidence: Record<string, unknown> = {
    visitId: f.visitId,
    roomId: f.roomId,
    roomName: f.roomName,
    enteredAt: f.enteredAt.toISOString(),
    expectedSeconds: f.expectedMinutes * 60,
    dwellSeconds,
    limitSeconds: dwellLimitSeconds(f.expectedMinutes),
    stillInside: f.exitedAt === null,
    detectedAt: now.toISOString(),
    entrants: f.entrants,
    ...(f.task ? { task: f.task } : {}),
    ...(f.exitedAt ? { exitedAt: f.exitedAt.toISOString() } : {}),
  };
  const what = f.task ? ` for "${f.task}"` : "";
  const consequence = f.exitedAt
    ? `${names(f.entrants)} were in ${f.roomName} for ${minutes(dwellSeconds)} minutes${what}, ` +
      `against ${f.expectedMinutes} expected. The visit is over; the control room reviews ` +
      `what was done in that time against the CCTV for the same period and records what it finds.`
    : `${names(f.entrants)} entered ${f.roomName}${what} ${minutes(dwellSeconds)} minutes ago, ` +
      `against ${f.expectedMinutes} expected, and no exit is on record. Either they are still ` +
      `inside or the exit was not recorded; the control room contacts them and records which.`;
  return { evidence, consequence };
}

export interface FootfallFacts {
  visitId: string;
  roomId: string;
  roomName: string;
  monitorDeviceId: string;
  authorisedEntrants: number;
  /** The monitor's own count over the visit. A floor: two abreast count as one. */
  countedAtLeast: number;
  monitorEvents: number;
  entrants: { name: string; role: string }[];
  enteredAt: Date;
  exitedAt: Date;
}

/** More bodies counted in than people let in. Fewer is not a finding: see docs/06. */
export function describeFootfall(f: FootfallFacts): DoorAlert {
  return {
    evidence: {
      visitId: f.visitId,
      roomId: f.roomId,
      roomName: f.roomName,
      monitorId: f.monitorDeviceId,
      authorisedEntrants: f.authorisedEntrants,
      countedAtLeast: f.countedAtLeast,
      monitorEvents: f.monitorEvents,
      enteredAt: f.enteredAt.toISOString(),
      exitedAt: f.exitedAt.toISOString(),
      entrants: f.entrants,
    },
    consequence:
      `The door monitor counted at least ${f.countedAtLeast} people going into ${f.roomName} ` +
      `during a visit that admitted ${f.authorisedEntrants}: ${names(f.entrants)}. Somebody ` +
      `went in who was not verified at the door. The control room reviews the CCTV for the ` +
      `visit and records who it was.`,
  };
}

async function entrantsOf(
  tx: PoolClient,
  persons: { personId: string }[],
): Promise<{ name: string; role: string }[]> {
  const { rows } = await tx.query<{ display_name: string; role: string }>(
    "select display_name, role from ref.person where id = any($1::uuid[]) order by display_name",
    [persons.map((p) => p.personId)],
  );
  return rows.map((r) => ({ name: r.display_name, role: r.role }));
}

async function raise(
  tx: PoolClient,
  kind: string,
  centreId: string | null,
  deviceId: string | null,
  alert: DoorAlert,
): Promise<void> {
  await tx.query(
    `insert into led.alert (kind, centre_id, device_id, evidence, requires_decision, consequence)
     values ($1, $2::uuid, $3::uuid, $4::jsonb, true, $5)`,
    [kind, centreId, deviceId, JSON.stringify(alert.evidence), alert.consequence],
  );
}

async function alreadyRaised(tx: PoolClient, kind: string, visitId: string): Promise<boolean> {
  const { rows } = await tx.query(
    "select 1 from led.alert where kind = $1 and evidence ->> 'visitId' = $2 limit 1",
    [kind, visitId],
  );
  return rows.length > 0;
}

export interface ExitOutcome {
  dwellSeconds: number;
  dwellExceeded: boolean;
  footfall: {
    evaluated: boolean;
    countedAtLeast: number | null;
    /** How many door events the monitor signed during the visit. */
    monitorEvents: number;
    mismatch: boolean;
    detail: string;
  };
  /** What went on the chain for this exit, and what could not and why. */
  chainEvents: ChainEventOutcome[];
}

/**
 * Record the exit and judge the visit: how long it lasted, and whether the
 * monitor counted more people in than the door admitted.
 */
export async function closeVisit(
  tx: PoolClient,
  visit: VisitRow,
  req: ExitRequest,
  now: Date = new Date(),
): Promise<ExitOutcome> {
  const dwellSeconds = Math.max(0, Math.round((now.getTime() - visit.entered_at.getTime()) / 1000));
  const { rows: room } = await tx.query<{
    name: string;
    centre_id: string | null;
    monitor_device_id: string | null;
  }>("select name, centre_id, monitor_device_id from ref.strong_room where id = $1::uuid", [
    visit.room_id,
  ]);
  const r = room[0]!;
  const entrants = await entrantsOf(tx, visit.persons);

  // ── what the monitor counted, from its own signed events ──
  let footfall: ExitOutcome["footfall"];
  if (!r.monitor_device_id) {
    footfall = {
      evaluated: false,
      countedAtLeast: null,
      monitorEvents: 0,
      mismatch: false,
      detail: "not evaluated: this room has no monitor on record",
    };
  } else {
    const { rows } = await tx.query<{ events: number; counted: number }>(
      `select count(*)::int as events,
              coalesce(sum((body -> 'payload' ->> 'enteredAtLeast')::int), 0)::int as counted
         from led.event
        where actor_device = $1::uuid and kind = 'ROOM_ENTRY'
          and occurred_at >= $2::timestamptz - interval '30 seconds'
          and occurred_at <= $3::timestamptz`,
      [r.monitor_device_id, visit.entered_at, now],
    );
    const events = rows[0]?.events ?? 0;
    const counted = rows[0]?.counted ?? 0;
    footfall =
      events === 0
        ? {
            evaluated: false,
            countedAtLeast: null,
            monitorEvents: 0,
            mismatch: false,
            detail: "not evaluated: the room's monitor signed no door event during this visit",
          }
        : {
            evaluated: true,
            countedAtLeast: counted,
            monitorEvents: events,
            mismatch: counted > visit.persons.length,
            detail: `the monitor counted at least ${counted} going in; the door admitted ${visit.persons.length}`,
          };
  }

  await tx.query(
    `insert into led.strongroom_exit (visit_id, exited_at, dwell_seconds, packages_touched, footfall_out)
     values ($1::uuid, $2, $3, $4, $5::jsonb)`,
    [visit.id, now, dwellSeconds, req.packagesTouched, JSON.stringify(footfall)],
  );
  const chainEvents: ChainEventOutcome[] = [
    await recordExitEvent(tx, {
      visitId: visit.id,
      roomId: visit.room_id,
      personIds: visit.persons.map((p) => p.personId),
      dwellSeconds,
      packagesTouched: req.packagesTouched,
    }),
  ];

  const dwellExceeded = dwellSeconds > dwellLimitSeconds(visit.expected_minutes);
  if (dwellExceeded && !(await alreadyRaised(tx, DWELL_EXCEEDED, visit.id))) {
    chainEvents.push(
      await recordDwellEvent(tx, {
        visitId: visit.id,
        roomId: visit.room_id,
        dwellSeconds,
        expectedMinutes: visit.expected_minutes,
      }),
    );
    await raise(
      tx,
      DWELL_EXCEEDED,
      r.centre_id,
      r.monitor_device_id,
      describeDwell(
        {
          visitId: visit.id,
          roomId: visit.room_id,
          roomName: r.name,
          entrants,
          task: null,
          enteredAt: visit.entered_at,
          expectedMinutes: visit.expected_minutes,
          exitedAt: now,
        },
        now,
      ),
    );
  }
  if (footfall.mismatch && r.monitor_device_id) {
    chainEvents.push(
      await recordFootfallEvent(tx, {
        visitId: visit.id,
        roomId: visit.room_id,
        authorisedEntrants: visit.persons.length,
        countedAtLeast: footfall.countedAtLeast ?? 0,
        monitorDeviceId: r.monitor_device_id,
      }),
    );
    await raise(
      tx,
      FOOTFALL_MISMATCH,
      r.centre_id,
      r.monitor_device_id,
      describeFootfall({
        visitId: visit.id,
        roomId: visit.room_id,
        roomName: r.name,
        monitorDeviceId: r.monitor_device_id,
        authorisedEntrants: visit.persons.length,
        countedAtLeast: footfall.countedAtLeast ?? 0,
        monitorEvents: footfall.monitorEvents,
        entrants,
        enteredAt: visit.entered_at,
        exitedAt: now,
      }),
    );
  }

  return { dwellSeconds, dwellExceeded, footfall, chainEvents };
}

/**
 * Raise DWELL_EXCEEDED for visits that have run past their limit with no exit.
 *
 * The exit route catches a long visit when it ends. This catches the one that
 * does not end: two people who went in forty minutes ago for a four-minute task
 * and have recorded nothing since. Run by the watchdog.
 */
export async function sweepOverstays(pool: Pool, now: Date = new Date()): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('watchdog:dwell'))");
    const { rows } = await client.query<{
      id: string;
      room_id: string;
      persons: { personId: string }[];
      entered_at: Date;
      expected_minutes: number;
      name: string;
      centre_id: string | null;
      monitor_device_id: string | null;
      task: string | null;
    }>(
      `select v.id, v.room_id, v.persons, v.entered_at, v.expected_minutes,
              r.name, r.centre_id, r.monitor_device_id,
              (select a.checks ->> 'task' from led.strongroom_attempt a
                where a.visit_id = v.id and a.kind = 'entry' limit 1) as task
         from led.strongroom_visit v
         join ref.strong_room r on r.id = v.room_id
        where not exists (select 1 from led.strongroom_exit x where x.visit_id = v.id)
          and v.entered_at > $1::timestamptz - interval '7 days'
          and not exists (
            select 1 from led.alert a
             where a.kind = $2 and a.evidence ->> 'visitId' = v.id::text)
        order by v.entered_at
        limit 200`,
      [now, DWELL_EXCEEDED],
    );
    const raised: string[] = [];
    for (const v of rows) {
      const dwell = (now.getTime() - v.entered_at.getTime()) / 1000;
      if (dwell <= dwellLimitSeconds(v.expected_minutes)) continue;
      await recordDwellEvent(client, {
        visitId: v.id,
        roomId: v.room_id,
        dwellSeconds: dwell,
        expectedMinutes: v.expected_minutes,
      });
      await raise(
        client,
        DWELL_EXCEEDED,
        v.centre_id,
        v.monitor_device_id,
        describeDwell(
          {
            visitId: v.id,
            roomId: v.room_id,
            roomName: v.name,
            entrants: await entrantsOf(client, v.persons),
            task: v.task,
            enteredAt: v.entered_at,
            expectedMinutes: v.expected_minutes,
            exitedAt: null,
          },
          now,
        ),
      );
      raised.push(v.id);
    }
    await client.query("commit");
    return raised;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
