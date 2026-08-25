import type { Pool } from "pg";
import { canTransition, type EventBody, type PackageState } from "@mohar/contracts";
import { projectCustody, custodyRiskScore, type CustodyProjection } from "../domain/custody.js";

/**
 * Reads over reference data, plus the joins that turn a package into something
 * the control room can act on.
 *
 * Everything here is SELECT-heavy and deliberately not cached: a control-room
 * operator refreshing during an incident must see the ledger as it is now, not a
 * projection that was correct thirty seconds ago.
 */

export interface DeviceRecord {
  id: string;
  kind: string;
  pubkey: string;
  centreId: string | null;
  enrolledAt: string;
  revokedAt: string | null;
}

export async function listDevices(pool: Pool): Promise<DeviceRecord[]> {
  const { rows } = await pool.query(
    `select id, kind, encode(pubkey,'hex') as pubkey, centre_id,
            enrolled_at, revoked_at
       from ref.device
      order by enrolled_at desc`,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    pubkey: r.pubkey,
    centreId: r.centre_id,
    enrolledAt: (r.enrolled_at as Date).toISOString(),
    revokedAt: r.revoked_at ? (r.revoked_at as Date).toISOString() : null,
  }));
}

export async function enrolDevice(
  pool: Pool,
  input: {
    kind: string;
    pubkeyHex: string;
    centreId?: string | undefined;
    attestationB64?: string | undefined;
  },
): Promise<DeviceRecord> {
  const { rows } = await pool.query(
    `insert into ref.device (kind, pubkey, centre_id, attestation)
     values ($1, decode($2,'hex'), $3, $4)
     returning id, kind, encode(pubkey,'hex') as pubkey, centre_id, enrolled_at, revoked_at`,
    [
      input.kind,
      input.pubkeyHex,
      input.centreId ?? null,
      input.attestationB64 ? Buffer.from(input.attestationB64, "base64") : null,
    ],
  );
  const r = rows[0]!;
  return {
    id: r.id,
    kind: r.kind,
    pubkey: r.pubkey,
    centreId: r.centre_id,
    enrolledAt: (r.enrolled_at as Date).toISOString(),
    revokedAt: null,
  };
}

/**
 * Revocation is a timestamp, never a delete. Events this device already signed
 * stay valid and stay in the chain — revoking a key says "trust nothing signed
 * after now", not "this device never existed".
 */
export async function revokeDevice(pool: Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "update ref.device set revoked_at = now() where id = $1 and revoked_at is null",
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export interface PackageSummary {
  id: string;
  examId: string;
  examName: string;
  centreId: string;
  centreCode: string;
  copies: number;
  sealSerial: string | null;
  /** What was planned. */
  declaredState: PackageState;
  /** What the ledger says actually happened. */
  observedState: PackageState;
  /** True when the two disagree — always worth a look. */
  divergent: boolean;
  riskScore: number;
  anomalyCount: number;
  eventCount: number;
  lastEventAt: string | null;
  custodyFrom: string | null;
  custodyTo: string | null;
}

/** Events for one package, oldest first — the order `projectCustody` expects. */
async function loadPackageEvents(pool: Pool, packageId: string) {
  const { rows } = await pool.query(
    `select seq, body, occurred_at
       from led.event
      where package_id = $1
      order by seq asc`,
    [packageId],
  );
  return rows.map((r) => ({
    seq: r.seq as string,
    body: r.body as EventBody,
    occurredAt: (r.occurred_at as Date).toISOString(),
  }));
}

export async function listPackages(
  pool: Pool,
  filter: { examId?: string; centreId?: string } = {},
): Promise<PackageSummary[]> {
  const { rows } = await pool.query(
    `select p.id, p.exam_id, p.centre_id, p.copies, p.seal_serial, p.state,
            p.custody_from, p.custody_to,
            e.name as exam_name, e.starts_at,
            c.code as centre_code
       from ref.package p
       join ref.exam   e on e.id = p.exam_id
       join ref.centre c on c.id = p.centre_id
      where ($1::uuid is null or p.exam_id   = $1::uuid)
        and ($2::uuid is null or p.centre_id = $2::uuid)
      order by e.starts_at asc, c.code asc`,
    [filter.examId ?? null, filter.centreId ?? null],
  );

  // Projecting each package separately keeps the logic identical to the detail
  // view. At pilot scale (20–50 centres) this is a few dozen small queries; if
  // it ever needs to serve a whole state, this becomes one grouped query.
  const out: PackageSummary[] = [];
  for (const r of rows) {
    const events = await loadPackageEvents(pool, r.id);
    const projection = projectCustody(events, {
      ...(r.seal_serial ? { registeredSealSerial: r.seal_serial } : {}),
      ...(r.custody_from ? { windowOpensAt: (r.custody_from as Date).toISOString() } : {}),
    });
    out.push({
      id: r.id,
      examId: r.exam_id,
      examName: r.exam_name,
      centreId: r.centre_id,
      centreCode: r.centre_code,
      copies: r.copies,
      sealSerial: r.seal_serial,
      declaredState: r.state,
      observedState: projection.state,
      divergent: r.state !== projection.state,
      riskScore: custodyRiskScore(projection),
      anomalyCount: projection.anomalies.length,
      eventCount: events.length,
      lastEventAt: projection.lastEventAt ?? null,
      custodyFrom: r.custody_from ? (r.custody_from as Date).toISOString() : null,
      custodyTo: r.custody_to ? (r.custody_to as Date).toISOString() : null,
    });
  }
  return out;
}

export interface PackageDetail extends PackageSummary {
  projection: CustodyProjection;
  timeline: TimelineEvent[];
}

/** One event, with everything the ledger holds about it. */
export interface TimelineEvent {
  seq: string;
  id: string;
  kind: string;
  occurredAt: string;
  receivedAt: string;
  clockSkewMs: number;
  actorPersonId: string | null;
  actorName: string | null;
  actorRole: string | null;
  actorDeviceId: string;
  deviceKind: string | null;
  /** Present on two-person acts; its absence on a HANDOFF would be a defect. */
  cosignDeviceId: string | null;
  lat: number | null;
  lon: number | null;
  geoAccuracyM: number | null;
  payload: unknown;
  /** SHA-256 of the canonical body — what the device signature covers. */
  bodyHash: string;
  prevHash: string;
  /** SHA-256(prevHash ‖ bodyHash) — what fixes this event in sequence. */
  hash: string;
}

export async function getPackage(
  pool: Pool,
  packageId: string,
): Promise<PackageDetail | null> {
  const { rows } = await pool.query(
    `select p.id, p.exam_id, p.centre_id, p.copies, p.seal_serial, p.state,
            p.custody_from, p.custody_to,
            e.name as exam_name, c.code as centre_code
       from ref.package p
       join ref.exam   e on e.id = p.exam_id
       join ref.centre c on c.id = p.centre_id
      where p.id = $1`,
    [packageId],
  );
  const r = rows[0];
  if (!r) return null;

  const events = await loadPackageEvents(pool, packageId);
  const projection = projectCustody(events, {
    ...(r.seal_serial ? { registeredSealSerial: r.seal_serial } : {}),
    ...(r.custody_from ? { windowOpensAt: (r.custody_from as Date).toISOString() } : {}),
  });

  // Everything recorded about each event. The custody timeline is the screen an
  // investigator reads, so nothing is withheld from it: position and both
  // hashes are part of the evidence, not debug detail.
  const detailed = await pool.query(
    `select e.seq, e.id, e.kind, e.occurred_at, e.received_at, e.clock_skew_ms,
            e.actor_person, e.actor_device, e.body,
            e.lat, e.lon, e.geo_accuracy_m,
            e.cosign_device,
            encode(e.body_hash,'hex') as body_hash,
            encode(e.prev_hash,'hex') as prev_hash,
            encode(e.hash,'hex')      as hash,
            p.display_name as actor_name, p.role as actor_role,
            d.kind as device_kind
       from led.event e
       left join ref.person p on p.id = e.actor_person
       left join ref.device d on d.id = e.actor_device
      where e.package_id = $1
      order by e.seq asc`,
    [packageId],
  );

  return {
    id: r.id,
    examId: r.exam_id,
    examName: r.exam_name,
    centreId: r.centre_id,
    centreCode: r.centre_code,
    copies: r.copies,
    sealSerial: r.seal_serial,
    declaredState: r.state,
    observedState: projection.state,
    divergent: r.state !== projection.state,
    riskScore: custodyRiskScore(projection),
    anomalyCount: projection.anomalies.length,
    eventCount: events.length,
    lastEventAt: projection.lastEventAt ?? null,
    custodyFrom: r.custody_from ? (r.custody_from as Date).toISOString() : null,
    custodyTo: r.custody_to ? (r.custody_to as Date).toISOString() : null,
    projection,
    timeline: detailed.rows.map(
      (e): TimelineEvent => ({
        seq: e.seq,
        id: e.id,
        kind: e.kind,
        occurredAt: (e.occurred_at as Date).toISOString(),
        receivedAt: (e.received_at as Date).toISOString(),
        clockSkewMs: Number(e.clock_skew_ms),
        actorPersonId: e.actor_person,
        actorName: e.actor_name,
        actorRole: e.actor_role,
        actorDeviceId: e.actor_device,
        deviceKind: e.device_kind,
        cosignDeviceId: e.cosign_device,
        lat: e.lat,
        lon: e.lon,
        geoAccuracyM: e.geo_accuracy_m,
        payload: (e.body as { payload: unknown }).payload,
        bodyHash: e.body_hash,
        prevHash: e.prev_hash,
        hash: e.hash,
      }),
    ),
  };
}

/**
 * Advance the *planned* state. This never touches the ledger — it records the
 * operator's intent so that a later divergence between plan and reality is
 * visible. Refused when the transition is not legal, so the plan itself stays
 * coherent even though reality is allowed to depart from it.
 */
export async function setPackageDeclaredState(
  pool: Pool,
  packageId: string,
  to: PackageState,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { rows } = await pool.query<{ state: PackageState }>(
    "select state from ref.package where id = $1",
    [packageId],
  );
  const current = rows[0]?.state;
  if (!current) return { ok: false, reason: "unknown package" };

  if (!canTransition(current, to)) {
    return { ok: false, reason: `${current} → ${to} is not a legal transition` };
  }
  await pool.query(
    "update ref.package set state = $2, updated_at = now() where id = $1",
    [packageId, to],
  );
  return { ok: true };
}

/** Exams and centres, for populating selectors and the map. */
export async function listExams(pool: Pool) {
  const { rows } = await pool.query(
    `select e.id, e.name, e.mode, e.starts_at, e.drand_round, e.sides_per_copy,
            e.suspended_at, a.name as authority,
            (select count(*) from ref.centre c where c.exam_id = e.id) as centre_count,
            (select count(*) from ref.package p where p.exam_id = e.id) as package_count
       from ref.exam e
       join ref.authority a on a.id = e.authority_id
      order by e.starts_at desc`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    mode: r.mode,
    authority: r.authority,
    startsAt: (r.starts_at as Date).toISOString(),
    drandRound: Number(r.drand_round),
    sidesPerCopy: r.sides_per_copy,
    suspended: r.suspended_at !== null,
    centreCount: Number(r.centre_count),
    packageCount: Number(r.package_count),
  }));
}

export async function listCentres(pool: Pool, examId?: string) {
  const { rows } = await pool.query(
    `select id, exam_id, code, lat, lon, geofence_m, capacity, printers,
            has_genset, accredited_at
       from ref.centre
      where ($1::uuid is null or exam_id = $1::uuid)
      order by code asc`,
    [examId ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    examId: r.exam_id,
    code: r.code,
    lat: r.lat,
    lon: r.lon,
    geofenceM: r.geofence_m,
    capacity: r.capacity,
    printers: r.printers,
    hasGenset: r.has_genset,
    accredited: r.accredited_at !== null,
  }));
}

// ── fingerprint enrolments ──────────────────────────────────────────────────

export interface FingerprintEnrolment {
  id: string;
  deviceId: string;
  templateSlot: number;
  personId: string;
  personName: string;
  personRole: string;
  role: "superintendent" | "observer";
  fingerLabel: string | null;
  enrolledAt: string;
  enrolledNote: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

/**
 * Who each template slot belongs to.
 *
 * Retired enrolments are returned alongside live ones by default. An assertion
 * signed six weeks ago refers to whoever held that slot *then*, and a list that
 * silently dropped retired mappings would make old records unreadable.
 */
export async function listEnrolments(
  pool: Pool,
  opts: { deviceId?: string; liveOnly?: boolean } = {},
): Promise<FingerprintEnrolment[]> {
  const { rows } = await pool.query(
    `select e.id, e.device_id, e.template_slot, e.person_id, e.role,
            e.finger_label, e.enrolled_at, e.enrolled_note,
            e.revoked_at, e.revoked_reason,
            p.display_name, p.role as person_role
       from ref.fingerprint_enrolment e
       join ref.person p on p.id = e.person_id
      where ($1::uuid is null or e.device_id = $1::uuid)
        and ($2::boolean is false or e.revoked_at is null)
      order by e.device_id, e.template_slot, e.enrolled_at desc`,
    [opts.deviceId ?? null, opts.liveOnly ?? false],
  );
  return rows.map((r) => ({
    id: r.id,
    deviceId: r.device_id,
    templateSlot: Number(r.template_slot),
    personId: r.person_id,
    personName: r.display_name,
    personRole: r.person_role,
    role: r.role,
    fingerLabel: r.finger_label,
    enrolledAt: (r.enrolled_at as Date).toISOString(),
    enrolledNote: r.enrolled_note,
    revokedAt: r.revoked_at ? (r.revoked_at as Date).toISOString() : null,
    revokedReason: r.revoked_reason,
  }));
}

/**
 * Record that a named person's finger now lives in a numbered slot.
 *
 * Re-enrolling a live slot is refused rather than silently replacing it. A slot
 * quietly reassigned would make every assertion already signed against it point
 * at the wrong person, and nothing in the record would say so. Retire the old
 * enrolment first — that leaves the history intact and readable.
 */
export async function enrolFingerprint(
  pool: Pool,
  input: {
    deviceId: string;
    templateSlot: number;
    personId: string;
    role: "superintendent" | "observer";
    fingerLabel?: string | undefined;
    note?: string | undefined;
  },
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const { rows: live } = await pool.query(
    `select id, template_slot from ref.fingerprint_enrolment
      where device_id = $1 and template_slot = $2 and revoked_at is null`,
    [input.deviceId, input.templateSlot],
  );
  if (live[0]) {
    return {
      ok: false,
      reason:
        `slot ${input.templateSlot} on this station is already enrolled; ` +
        "retire that enrolment before reassigning the slot",
    };
  }

  const { rows } = await pool.query(
    `insert into ref.fingerprint_enrolment
       (device_id, template_slot, person_id, role, finger_label, enrolled_note)
     values ($1,$2,$3,$4,$5,$6)
     returning id`,
    [
      input.deviceId,
      input.templateSlot,
      input.personId,
      input.role,
      input.fingerLabel ?? null,
      input.note ?? null,
    ],
  );
  return { ok: true, id: rows[0]!.id };
}

/** Retire an enrolment. The row stays; only its validity ends. */
export async function revokeEnrolment(
  pool: Pool,
  id: string,
  reason: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update ref.fingerprint_enrolment
        set revoked_at = now(), revoked_reason = $2
      where id = $1 and revoked_at is null`,
    [id, reason],
  );
  return (rowCount ?? 0) > 0;
}

export async function listPersons(pool: Pool) {
  const { rows } = await pool.query(
    "select id, display_name, role, created_at from ref.person order by display_name asc",
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    role: r.role,
  }));
}
