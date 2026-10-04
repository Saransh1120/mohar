import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { DenyReason } from "@mohar/contracts";
import type { ChainEventOutcome } from "./service-events.js";
import {
  recordCeremonyIncomplete,
  recordEnvelopeIssued,
  recordOpenCeremony,
  recordPacketOpened,
  recordSharesRewrapped,
} from "./opening-events.js";
import {
  roundAt,
  seamLabelMatches,
  shareContext,
  splitOpeningKey,
  wrapControlPart,
  wrapShare,
  type ControlEnvelope,
  type FieldHolder,
} from "@mohar/crypto-core";

/**
 * ── The opening: roster lock, then the ceremony ──────────────────────────────
 *
 * Two moments, a day apart.
 *
 * **When the duty roster is locked** an opening key is made for each of the
 * centre's packets and immediately taken apart: the control room's part is
 * time-locked to the drand round fifteen minutes before the exam, each of the
 * three officials' shares is wrapped to the station that will run the opening,
 * and the key, the part and the shares are dropped. What this process keeps is
 * ciphertext it cannot read and the commitments a reconstruction is checked
 * against. From that moment nobody here can open a packet early, including
 * whoever runs this server: the control room's part does not exist in readable
 * form until the beacon publishes.
 *
 * **At the opening** the station walks five steps, each decided and recorded
 * before it is answered:
 *
 *     scan       both codes on the packet still match what was sealed
 *     authorize  right centre, right station, roster locked, inside the window
 *     identify   two officials from two institutions, 120 s apart at most;
 *                each one's wrapped share is handed to the station only now
 *     confirm    the senior officer types the packet's printed serial
 *     release    the station presents the key it assembled; it must hash to
 *                the commitment, and the scheduled minute must have passed
 *
 * The server never assembles the key and could not. `release` passing means the
 * station held the control room's part (so the round had been published) and
 * two officials' shares (so two officials had been identified), because nothing
 * else hashes to that commitment.
 *
 * Only the live path is here. A station opening from a cached envelope with no
 * network, and an opening outside its window with all three officials and the
 * control room's approval, are designed and not built.
 */

/** The packet opens this long before the exam starts. */
export const OPEN_LEAD_MS = 15 * 60_000;
/** The ceremony may begin this long before the exam starts. */
export const CEREMONY_LEAD_MS = 30 * 60_000;
export const TWO_OFFICIAL_WINDOW_S = 120;
const MIN_BIOMETRIC_SCORE = 60;
const SERIAL_ATTEMPT_LIMIT = 3;

/** The three officials who each hold a share, in share order. */
export const DUTY_ROLES: readonly FieldHolder[] = Object.freeze([
  "superintendent",
  "observer",
  "police_escort",
]);

/** The body each official answers to. Two shares from one of these open nothing. */
export function institutionOf(role: FieldHolder, centreCode: string): string {
  if (role === "superintendent") return `Examination centre ${centreCode}`;
  if (role === "observer") return "Board of examinations";
  return "State police";
}

export interface OpeningCheck {
  check: string;
  /** Undefined where the check could not be run. Not run is not passed. */
  passed: boolean | undefined;
  evidence: string;
  reason?: DenyReason;
}

export interface StepDecision {
  outcome: "passed" | "refused";
  checks: OpeningCheck[];
  denyReasons: DenyReason[];
}

class Checks {
  readonly list: OpeningCheck[] = [];
  add(check: string, passed: boolean | undefined, evidence: string, reason?: DenyReason): void {
    this.list.push({ check, passed, evidence, ...(reason && passed === false ? { reason } : {}) });
  }
  decide(): StepDecision {
    return {
      outcome: this.list.every((c) => c.passed !== false) ? "passed" : "refused",
      checks: this.list,
      denyReasons: [
        ...new Set(this.list.filter((c) => c.passed === false && c.reason).map((c) => c.reason!)),
      ],
    };
  }
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return null;
  return new Uint8Array(Buffer.from(hex, "hex"));
}

// ── locking the roster ──────────────────────────────────────────────────────

/** A roster is locked this long before the exam starts. */
export const LOCK_LEAD_MS = 24 * 3600_000;

export interface LockRequest {
  centreId: string;
  examSession: string;
  stationDeviceId: string;
  /** The operator locking it, where there is one. Recorded on the issue. */
  accountId?: string | undefined;
  /**
   * Why it is being locked inside the last day. Required then, and recorded;
   * ignored when the lock is on time.
   */
  lateReason?: string | undefined;
}

export interface LockedPacket {
  packageId: string;
  packetSerial: string | null;
  drandRound: number;
  scheduledOpenAt: string;
  keyCommitment: string;
}

export interface LockResult {
  decision: StepDecision;
  lockedAt: string | null;
  issueNo: number | null;
  late: boolean;
  packets: LockedPacket[];
  /** What went on the chain for this lock, and what could not and why. */
  chainEvents: ChainEventOutcome[];
}

interface CentreRow {
  id: string;
  code: string;
  exam_id: string;
  starts_at: Date;
  suspended_at: Date | null;
}

interface DutyRow {
  role: string;
  person_id: string;
  locked_at: Date | null;
  display_name: string;
  person_role: string;
}

interface StationRow {
  id: string;
  kind: string;
  revoked_at: Date | null;
  centre_id: string | null;
  wrap_pub: Buffer | null;
}

async function loadCentre(tx: PoolClient, centreId: string): Promise<CentreRow | undefined> {
  const { rows } = await tx.query<CentreRow>(
    `select c.id, c.code, c.exam_id, e.starts_at, e.suspended_at
       from ref.centre c join ref.exam e on e.id = c.exam_id where c.id = $1::uuid`,
    [centreId],
  );
  return rows[0];
}

async function loadDuty(tx: PoolClient, centreId: string, session: string): Promise<DutyRow[]> {
  const { rows } = await tx.query<DutyRow>(
    `select d.role, d.person_id, d.locked_at, p.display_name, p.role as person_role
       from ref.duty_roster d join ref.person p on p.id = d.person_id
      where d.centre_id = $1::uuid and d.exam_session = $2`,
    [centreId, session],
  );
  return rows;
}

async function loadStation(tx: PoolClient, deviceId: string): Promise<StationRow | undefined> {
  const { rows } = await tx.query<StationRow>(
    `select d.id, d.kind, d.revoked_at, d.centre_id, w.x25519_pub as wrap_pub
       from ref.device d left join ref.device_wrap_key w on w.device_id = d.id
      where d.id = $1::uuid`,
    [deviceId],
  );
  return rows[0];
}

/** The checks a roster of three has to pass, whether it is being locked or re-issued. */
function rosterChecks(c: Checks, duty: DutyRow[]): void {
  const byRole = new Map(duty.map((d) => [d.role, d]));
  const missing = DUTY_ROLES.filter((r) => !byRole.has(r));
  c.add(
    "roster_complete",
    missing.length === 0,
    missing.length === 0
      ? DUTY_ROLES.map((r) => `${r.replace(/_/g, " ")}: ${byRole.get(r)!.display_name}`).join("; ")
      : `nobody is assigned as ${missing.map((r) => r.replace(/_/g, " ")).join(", ")}`,
    "person_not_on_roster",
  );
  const distinct = new Set(duty.map((d) => d.person_id)).size === duty.length;
  c.add(
    "officials_distinct",
    duty.length > 0 ? distinct : undefined,
    duty.length === 0
      ? "not evaluated: the roster is empty"
      : distinct
        ? "each role is held by a different person"
        : "one person is assigned to more than one role; each share needs its own official",
    "same_institution_pair",
  );
  const mismatched = duty.filter((d) => d.person_role !== d.role);
  c.add(
    "roles_match",
    duty.length > 0 ? mismatched.length === 0 : undefined,
    duty.length === 0
      ? "not evaluated: the roster is empty"
      : mismatched.length === 0
        ? "each person is on record in the role they are assigned"
        : mismatched
            .map((d) => `${d.display_name} is on record as ${d.person_role}, assigned as ${d.role}`)
            .join("; "),
    "person_role_not_permitted",
  );
}

function stationChecks(
  c: Checks,
  station: StationRow | undefined,
  centre: CentreRow | undefined,
  deviceId: string,
): void {
  c.add(
    "station_enrolled",
    Boolean(station) && !station?.revoked_at,
    station
      ? station.revoked_at
        ? `station ${station.id} was revoked at ${station.revoked_at.toISOString()}`
        : `station ${station.id} (${station.kind}) is enrolled`
      : `device ${deviceId} is not enrolled`,
    station?.revoked_at ? "device_revoked" : "device_unknown",
  );
  c.add(
    "station_paired",
    station ? Boolean(station.wrap_pub) : undefined,
    !station
      ? "not evaluated: the station is unknown"
      : station.wrap_pub
        ? "the station has an unwrap key on record; shares can be wrapped to it"
        : "the station has registered no unwrap key, so there is nothing to wrap a share to",
    "station_not_paired",
  );
  c.add(
    "station_at_centre",
    station && centre ? station.centre_id === null || station.centre_id === centre.id : undefined,
    !station || !centre
      ? "not evaluated: station or centre unknown"
      : station.centre_id === null
        ? "the station is not bound to a single centre"
        : station.centre_id === centre.id
          ? `the station is bound to centre ${centre.code}`
          : "the station is bound to a different centre",
    "device_not_bound_to_centre",
  );
}

function hoursAndMinutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

export interface LeadTime {
  leadSeconds: number;
  /** Inside the last day before the exam. */
  late: boolean;
  passed: boolean;
  evidence: string;
}

/**
 * Is this lock a day ahead, and if it is not, was a reason given.
 *
 * The procedure locks a roster twenty-four hours before the exam, so that the
 * names are fixed while there is still a day in which to notice a wrong one. A
 * lock inside that day is not forbidden - an exam moved at short notice is a
 * real thing - but it is no longer routine: it has to say why, and the record
 * keeps both how late it was and the reason given. Pure, so it can be tested.
 */
export function judgeLead(startsAt: Date, now: Date, lateReason: string | undefined): LeadTime {
  const lead = startsAt.getTime() - now.getTime();
  const late = lead < LOCK_LEAD_MS;
  const reason = lateReason?.trim() ?? "";
  const before = `${hoursAndMinutes(lead)} before the exam starts`;
  if (!late) {
    return {
      leadSeconds: Math.round(lead / 1000),
      late,
      passed: true,
      evidence: `locked ${before}; the procedure asks for at least 24 h`,
    };
  }
  return {
    leadSeconds: Math.round(lead / 1000),
    late,
    passed: reason.length >= 10,
    evidence:
      reason.length >= 10
        ? `locked ${before}, inside the last day, with the reason given: "${reason}"`
        : `this is ${before}; a roster is locked 24 h ahead, and a lock inside the last day ` +
          "has to state why in at least a few words",
  };
}

/**
 * Make an opening key for each packet and take it apart: time-lock the control
 * room's part, wrap each official's share to the station, write the
 * commitments, keep nothing readable.
 */
async function issueKeys(
  tx: PoolClient,
  centre: CentreRow,
  station: StationRow & { wrap_pub: Buffer },
  duty: DutyRow[],
  packets: { id: string; seal_serial: string | null; issue_no: number }[],
  examSession: string,
  chainEvents: ChainEventOutcome[],
): Promise<LockedPacket[]> {
  const openAt = new Date(centre.starts_at.getTime() - OPEN_LEAD_MS);
  const byRole = new Map(duty.map((d) => [d.role, d]));
  const wrapPubHex = station.wrap_pub.toString("hex");
  const institutions = Object.fromEntries(
    DUTY_ROLES.map((r) => [r, institutionOf(r, centre.code)]),
  ) as Record<FieldHolder, string>;
  const issued: LockedPacket[] = [];

  for (const p of packets) {
    // The key lives for the length of this loop body and is never written.
    const openingKey = new Uint8Array(randomBytes(32));
    const split = await splitOpeningKey(openingKey, institutions);
    const envelope = await wrapControlPart(split.controlPart, openAt, {
      packageId: p.id,
      centreId: centre.id,
      // There is no room record for an exam hall; the station is the place.
      roomId: station.id,
      windowStart: new Date(centre.starts_at.getTime() - CEREMONY_LEAD_MS).toISOString(),
      windowEnd: centre.starts_at.toISOString(),
      eligibleRoles: DUTY_ROLES,
    });
    const envelopeText = JSON.stringify(envelope);
    await tx.query(
      `insert into led.share_envelope
         (package_id, kind, holder, ciphertext, ciphertext_sha256, drand_round, policy_sha256, issue_no)
       values ($1::uuid, 'control_timelock', $2, $3, $4, $5, $6, $7)`,
      [p.id, station.id, envelopeText, sha256Hex(envelopeText), envelope.round, envelope.policySha256, p.issue_no],
    );

    const meta = [];
    for (const share of split.fieldShares) {
      const official = byRole.get(share.holder)!;
      const wrapped = JSON.stringify(
        wrapShare(share.share, wrapPubHex, shareContext(p.id, share.holder, official.person_id)),
      );
      await tx.query(
        `insert into led.share_envelope (package_id, kind, holder, ciphertext, ciphertext_sha256, issue_no)
         values ($1::uuid, 'field_person', $2, $3, $4, $5)`,
        [p.id, official.person_id, wrapped, sha256Hex(wrapped), p.issue_no],
      );
      meta.push({
        holder: share.holder,
        institution: share.institution,
        index: share.index,
        commitment: share.commitment,
        personId: official.person_id,
      });
    }

    await tx.query(
      `insert into led.opening_key
         (package_id, key_commitment, control_commitment, field_shares, drand_round,
          scheduled_open_at, station_device_id, exam_session, issue_no)
       values ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7::uuid, $8, $9)`,
      [
        p.id, split.keyCommitment, split.controlCommitment, JSON.stringify(meta),
        envelope.round, openAt, station.id, examSession, p.issue_no,
      ],
    );
    openingKey.fill(0);
    split.controlPart.fill(0);
    for (const s of split.fieldShares) s.share.fill(0);

    chainEvents.push(
      await recordEnvelopeIssued(tx, {
        examId: centre.exam_id,
        centreId: centre.id,
        packageId: p.id,
        drandRound: envelope.round,
        drandChainHash: envelope.chainHash,
        scheduledOpenAt: openAt,
        ciphertextSha256: sha256Hex(envelopeText),
        stationDeviceId: station.id,
      }),
    );

    issued.push({
      packageId: p.id,
      packetSerial: p.seal_serial,
      drandRound: envelope.round,
      scheduledOpenAt: openAt.toISOString(),
      keyCommitment: split.keyCommitment,
    });
  }
  return issued;
}

async function nextIssueNo(tx: PoolClient, centreId: string, session: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `select coalesce(max(issue_no), 0)::int + 1 as n from led.roster_issue
      where centre_id = $1::uuid and exam_session = $2`,
    [centreId, session],
  );
  return rows[0]?.n ?? 1;
}

/**
 * Decide whether a roster can be locked and, if it can, lock it and issue the
 * opening key for each of the centre's packets. One transaction.
 */
export async function lockRoster(
  tx: PoolClient,
  req: LockRequest,
  now: Date = new Date(),
): Promise<LockResult> {
  const c = new Checks();
  const refused = (decision: StepDecision): LockResult => ({
    decision,
    lockedAt: null,
    issueNo: null,
    late: false,
    packets: [],
    chainEvents: [],
  });

  const centre = await loadCentre(tx, req.centreId);
  c.add(
    "centre_known",
    Boolean(centre) && centre?.exam_id === req.examSession,
    !centre
      ? `no centre with id ${req.centreId}`
      : centre.exam_id === req.examSession
        ? `centre ${centre.code}`
        : `centre ${centre.code} belongs to a different exam session`,
    "person_not_on_roster",
  );

  const duty = await loadDuty(tx, req.centreId, req.examSession);
  rosterChecks(c, duty);
  const alreadyLocked = duty.find((d) => d.locked_at);
  c.add(
    "roster_unlocked",
    !alreadyLocked,
    alreadyLocked
      ? `this roster was locked at ${alreadyLocked.locked_at!.toISOString()}; a change after ` +
        "locking is a re-issue, which states its reason and is recorded as one"
      : "the roster has not been locked before",
    "duplicate_session",
  );

  const station = await loadStation(tx, req.stationDeviceId);
  stationChecks(c, station, centre, req.stationDeviceId);

  // ── the exam and its packets ──
  const openAt = centre ? new Date(centre.starts_at.getTime() - OPEN_LEAD_MS) : null;
  c.add(
    "opening_in_future",
    centre ? openAt!.getTime() > now.getTime() && !centre.suspended_at : undefined,
    !centre
      ? "not evaluated: the centre is unknown"
      : centre.suspended_at
        ? "the exam is suspended"
        : openAt!.getTime() > now.getTime()
          ? `the packets open at ${openAt!.toISOString()}, ` +
            `${Math.round((openAt!.getTime() - now.getTime()) / 60_000)} minutes from now`
          : `the opening time ${openAt!.toISOString()} has already passed; a key time-locked ` +
            "to a round already published is locked to nothing",
    centre?.suspended_at ? "exam_suspended" : "ceremony_window_closed",
  );

  const lead = centre ? judgeLead(centre.starts_at, now, req.lateReason) : null;
  c.add(
    "lock_lead_time",
    lead ? lead.passed : undefined,
    lead ? lead.evidence : "not evaluated: the centre is unknown",
    "roster_lock_late",
  );

  const { rows: packets } = centre
    ? await tx.query<{ id: string; seal_serial: string | null }>(
        `select p.id, p.seal_serial from ref.package p
          where p.centre_id = $1::uuid
            and not exists (select 1 from led.opening_key k where k.package_id = p.id)
          order by p.id`,
        [centre.id],
      )
    : { rows: [] };
  c.add(
    "packets_to_key",
    centre ? packets.length > 0 : undefined,
    !centre
      ? "not evaluated: the centre is unknown"
      : packets.length > 0
        ? `${packets.length} packet${packets.length === 1 ? "" : "s"} at this centre without an opening key`
        : "every packet at this centre already has an opening key",
    "duplicate_session",
  );

  const decision = c.decide();
  if (decision.outcome !== "passed" || !centre || !station?.wrap_pub || !lead) return refused(decision);

  const issueNo = await nextIssueNo(tx, centre.id, req.examSession);
  const chainEvents: ChainEventOutcome[] = [];
  const issued = await issueKeys(
    tx,
    centre,
    { ...station, wrap_pub: station.wrap_pub },
    duty,
    packets.map((p) => ({ ...p, issue_no: 1 })),
    req.examSession,
    chainEvents,
  );

  const { rows: locked } = await tx.query<{ locked_at: Date }>(
    `update ref.duty_roster set locked_at = now()
      where centre_id = $1::uuid and exam_session = $2 returning locked_at`,
    [req.centreId, req.examSession],
  );
  await tx.query(
    `insert into led.roster_issue
       (centre_id, exam_session, issue_no, kind, account_id, station_device_id, roster,
        packets, lead_seconds, late, reason)
     values ($1::uuid, $2, $3, 'lock', $4::uuid, $5::uuid, $6::jsonb, $7, $8, $9, $10)`,
    [
      centre.id, req.examSession, issueNo, req.accountId ?? null, station.id,
      JSON.stringify(duty.map((d) => ({ role: d.role, personId: d.person_id }))),
      issued.length, lead.leadSeconds, lead.late, lead.late ? req.lateReason!.trim() : null,
    ],
  );
  chainEvents.push(
    await recordSharesRewrapped(tx, {
      examId: centre.exam_id,
      centreId: centre.id,
      examSession: req.examSession,
      duty,
      stationDeviceId: station.id,
      rosterLockedAt: locked[0]?.locked_at,
    }),
  );
  return {
    decision,
    lockedAt: locked[0]?.locked_at.toISOString() ?? null,
    issueNo,
    late: lead.late,
    packets: issued,
    chainEvents,
  };
}

// ── re-issuing a locked roster ──────────────────────────────────────────────

export interface ReissueRequest {
  centreId: string;
  examSession: string;
  /** Who replaces whom: the role, and the person now holding it. */
  changes: { role: string; personId: string }[];
  /** Always required. A re-issue is never routine. */
  reason: string;
  accountId?: string | undefined;
}

export interface ReissueResult {
  decision: StepDecision;
  issueNo: number | null;
  changes: { role: string; fromPersonId: string; toPersonId: string }[];
  packets: LockedPacket[];
  chainEvents: ChainEventOutcome[];
}

/**
 * Change who holds a share after the roster was locked.
 *
 * The share wrapped for the official who is no longer coming cannot be handed
 * to their replacement, because nothing readable was kept when it was made. So
 * every packet at the centre that has not been opened gets a new key: a new
 * split, new wrapped shares for all three, a new time-locked envelope, as the
 * next issue. The earlier issue is not deleted - nothing here can be - but the
 * engine reads the latest, and a key assembled from the superseded shares no
 * longer hashes to the commitment it is checked against.
 *
 * It is refused once the opening minute has passed. By then the earlier
 * envelope can be opened by whoever holds it, and replacing the key afterwards
 * would be changing the lock on a door that may already be open.
 */
export async function reissueRoster(
  tx: PoolClient,
  req: ReissueRequest,
  now: Date = new Date(),
): Promise<ReissueResult> {
  const c = new Checks();
  const refused = (decision: StepDecision): ReissueResult => ({
    decision,
    issueNo: null,
    chainEvents: [],
    changes: [],
    packets: [],
  });

  const centre = await loadCentre(tx, req.centreId);
  c.add(
    "centre_known",
    Boolean(centre) && centre?.exam_id === req.examSession,
    !centre
      ? `no centre with id ${req.centreId}`
      : centre.exam_id === req.examSession
        ? `centre ${centre.code}`
        : `centre ${centre.code} belongs to a different exam session`,
    "person_not_on_roster",
  );

  const before = await loadDuty(tx, req.centreId, req.examSession);
  const lockedAt = before.find((d) => d.locked_at)?.locked_at ?? null;
  c.add(
    "roster_locked",
    Boolean(lockedAt),
    lockedAt
      ? `the roster was locked at ${lockedAt.toISOString()}`
      : "this roster has not been locked; assign it and lock it instead",
    "roster_not_locked",
  );

  const reason = req.reason.trim();
  c.add(
    "reason_given",
    reason.length >= 10,
    reason.length >= 10
      ? `reason given: "${reason}"`
      : "a re-issue has to state why in at least a few words",
    "roster_lock_late",
  );

  // ── the people coming in ──
  const { rows: incoming } = await tx.query<{ id: string; display_name: string; role: string }>(
    "select id, display_name, role from ref.person where id = any($1::uuid[])",
    [req.changes.map((ch) => ch.personId)],
  );
  const person = new Map(incoming.map((p) => [p.id, p]));
  const unknown = req.changes.filter((ch) => !person.has(ch.personId));
  const notDuty = req.changes.filter((ch) => !(DUTY_ROLES as readonly string[]).includes(ch.role));
  const same = req.changes.filter(
    (ch) => before.find((d) => d.role === ch.role)?.person_id === ch.personId,
  );
  c.add(
    "changes_named",
    req.changes.length > 0 && unknown.length === 0 && notDuty.length === 0 && same.length === 0,
    req.changes.length === 0
      ? "no change was named; a re-issue replaces at least one official"
      : unknown.length > 0
        ? `not registered: ${unknown.map((u) => u.personId).join(", ")}`
        : notDuty.length > 0
          ? `${notDuty.map((n) => n.role).join(", ")} is not one of the three officials' roles`
          : same.length > 0
            ? `${same.map((x) => x.role.replace(/_/g, " ")).join(", ")} already is that person; nothing would change`
            : req.changes
                .map((ch) => `${ch.role.replace(/_/g, " ")}: ${person.get(ch.personId)!.display_name}`)
                .join("; "),
    "person_not_on_roster",
  );

  // The roster as it would stand after the change, judged like any roster.
  const after: DutyRow[] = before.map((d) => {
    const ch = req.changes.find((x) => x.role === d.role);
    const p = ch ? person.get(ch.personId) : undefined;
    return p ? { ...d, person_id: p.id, display_name: p.display_name, person_role: p.role } : d;
  });
  rosterChecks(c, after);

  // ── the station the first issue was wrapped to ──
  const { rows: stationOf } = centre
    ? await tx.query<{ station_device_id: string }>(
        `select station_device_id from led.roster_issue
          where centre_id = $1::uuid and exam_session = $2 order by issue_no desc limit 1`,
        [centre.id, req.examSession],
      )
    : { rows: [] };
  // A roster locked before issues were recorded has its station on its keys.
  const { rows: stationOfKey } = centre && !stationOf[0]
    ? await tx.query<{ station_device_id: string }>(
        `select k.station_device_id from led.opening_key k join ref.package p on p.id = k.package_id
          where p.centre_id = $1::uuid order by k.issued_at desc limit 1`,
        [centre.id],
      )
    : { rows: [] };
  const stationId = stationOf[0]?.station_device_id ?? stationOfKey[0]?.station_device_id ?? null;
  const station = stationId ? await loadStation(tx, stationId) : undefined;
  stationChecks(c, station, centre, stationId ?? "(none on record)");

  // ── still time ──
  const openAt = centre ? new Date(centre.starts_at.getTime() - OPEN_LEAD_MS) : null;
  c.add(
    "opening_in_future",
    centre ? openAt!.getTime() > now.getTime() && !centre.suspended_at : undefined,
    !centre
      ? "not evaluated: the centre is unknown"
      : centre.suspended_at
        ? "the exam is suspended"
        : openAt!.getTime() > now.getTime()
          ? `the packets open at ${openAt!.toISOString()}, ` +
            `${hoursAndMinutes(openAt!.getTime() - now.getTime())} from now`
          : `the opening time ${openAt!.toISOString()} has passed; the earlier envelope can ` +
            "already be opened, so the key is not replaced now",
    centre?.suspended_at ? "exam_suspended" : "ceremony_window_closed",
  );

  // Every packet with a key that no ceremony has released. An opened packet
  // keeps the key it was opened with.
  const { rows: packets } = centre
    ? await tx.query<{ id: string; seal_serial: string | null; issue_no: number }>(
        `select p.id, p.seal_serial,
                (select max(k.issue_no)::int + 1 from led.opening_key k where k.package_id = p.id) as issue_no
           from ref.package p
          where p.centre_id = $1::uuid
            and exists (select 1 from led.opening_key k where k.package_id = p.id)
            and not exists (
              select 1 from led.ceremony cy join led.ceremony_step s on s.ceremony_id = cy.id
               where cy.package_id = p.id and s.step = 'release' and s.outcome = 'passed')
          order by p.id`,
        [centre.id],
      )
    : { rows: [] };
  c.add(
    "packets_to_rekey",
    centre ? packets.length > 0 : undefined,
    !centre
      ? "not evaluated: the centre is unknown"
      : packets.length > 0
        ? `${packets.length} packet${packets.length === 1 ? "" : "s"} at this centre with a key and no opening`
        : "no packet at this centre has a key that has not already been used",
    "package_already_opened",
  );

  const decision = c.decide();
  if (decision.outcome !== "passed" || !centre || !station?.wrap_pub) return refused(decision);

  const changes = req.changes.map((ch) => ({
    role: ch.role,
    fromPersonId: before.find((d) => d.role === ch.role)!.person_id,
    toPersonId: ch.personId,
  }));
  for (const ch of req.changes) {
    await tx.query(
      `update ref.duty_roster set person_id = $4::uuid
        where centre_id = $1::uuid and exam_session = $2 and role = $3`,
      [centre.id, req.examSession, ch.role, ch.personId],
    );
  }
  const issueNo = await nextIssueNo(tx, centre.id, req.examSession);
  const chainEvents: ChainEventOutcome[] = [];
  const issued = await issueKeys(
    tx,
    centre,
    { ...station, wrap_pub: station.wrap_pub },
    after,
    packets,
    req.examSession,
    chainEvents,
  );
  const lead = centre.starts_at.getTime() - now.getTime();
  await tx.query(
    `insert into led.roster_issue
       (centre_id, exam_session, issue_no, kind, account_id, station_device_id, roster, changes,
        packets, lead_seconds, late, reason)
     values ($1::uuid, $2, $3, 'reissue', $4::uuid, $5::uuid, $6::jsonb, $7::jsonb, $8, $9, $10, $11)`,
    [
      centre.id, req.examSession, issueNo, req.accountId ?? null, station.id,
      JSON.stringify(after.map((d) => ({ role: d.role, personId: d.person_id }))),
      JSON.stringify(changes), issued.length, Math.round(lead / 1000), lead < LOCK_LEAD_MS, reason,
    ],
  );
  chainEvents.push(
    await recordSharesRewrapped(tx, {
      examId: centre.exam_id,
      centreId: centre.id,
      examSession: req.examSession,
      duty: after,
      stationDeviceId: station.id,
      rosterLockedAt: after.find((d) => d.locked_at)?.locked_at,
    }),
  );
  return { decision, issueNo, changes, packets: issued, chainEvents };
}

// ── the ceremony ────────────────────────────────────────────────────────────

export type CeremonyStep =
  | "scan"
  | "authorize"
  | "identify"
  | "confirm"
  | "release"
  | "opened"
  | "incomplete";

interface KeyRow {
  package_id: string;
  key_commitment: string;
  field_shares: {
    holder: FieldHolder;
    institution: string;
    index: number;
    commitment: string;
    personId: string;
  }[];
  drand_round: string;
  scheduled_open_at: Date;
  station_device_id: string;
  exam_session: string;
  issue_no: number;
  issued_at: Date;
}

interface StepRow {
  step: CeremonyStep;
  outcome: "passed" | "refused";
  officials: { personId: string; role: FieldHolder; institution: string; assertedAt?: string }[];
  evidence: { checks?: OpeningCheck[]; [k: string]: unknown };
  recorded_at: Date;
}

export interface CeremonyState {
  id: string;
  packageId: string;
  centreId: string;
  scheduledOpenAt: Date;
  startedAt: Date;
  steps: StepRow[];
  /** Officials whose identification passed, in the order they presented. */
  officials: StepRow["officials"];
  /** The furthest step that has passed. Null before the scan passes. */
  reached: CeremonyStep | null;
  /**
   * The issue of the packet's key this ceremony began under, as its scan step
   * recorded it. Null where no key had been issued, or for a ceremony recorded
   * before issues were numbered.
   */
  issueNo: number | null;
}

const ORDER: CeremonyStep[] = ["scan", "authorize", "identify", "confirm", "release", "opened"];

/** A ceremony's state is read from its steps; nothing stores it. */
export function stateFromSteps(
  steps: readonly Pick<StepRow, "step" | "outcome" | "officials">[],
): { reached: CeremonyStep | null; officials: StepRow["officials"] } {
  const passed = (s: CeremonyStep) => steps.some((x) => x.step === s && x.outcome === "passed");
  const officials = steps
    .filter((x) => x.step === "identify" && x.outcome === "passed")
    .flatMap((x) => x.officials);
  let reached: CeremonyStep | null = null;
  for (const s of ORDER) {
    // Identification is reached only when two officials have passed it.
    const done = s === "identify" ? officials.length >= 2 : passed(s);
    if (!done) break;
    reached = s;
  }
  return { reached, officials };
}

export async function loadCeremony(tx: PoolClient | Pool, id: string): Promise<CeremonyState | undefined> {
  const { rows } = await tx.query<{
    id: string;
    package_id: string;
    centre_id: string;
    scheduled_open_at: Date;
    started_at: Date;
  }>(
    "select id, package_id, centre_id, scheduled_open_at, started_at from led.ceremony where id = $1::uuid",
    [id],
  );
  const c = rows[0];
  if (!c) return undefined;
  const { rows: steps } = await tx.query<StepRow>(
    `select step, outcome, officials, evidence, recorded_at
       from led.ceremony_step where ceremony_id = $1::uuid order by recorded_at, id`,
    [id],
  );
  return {
    id: c.id,
    packageId: c.package_id,
    centreId: c.centre_id,
    scheduledOpenAt: c.scheduled_open_at,
    startedAt: c.started_at,
    steps,
    ...stateFromSteps(steps),
    issueNo: (() => {
      const n = steps.find((x) => x.step === "scan")?.evidence["issueNo"];
      return typeof n === "number" ? n : null;
    })(),
  };
}

async function loadKey(tx: PoolClient, packageId: string): Promise<KeyRow | undefined> {
  const { rows } = await tx.query<KeyRow>(
    // The latest issue. An earlier one stays on record and is no longer read.
    `select package_id, key_commitment, field_shares, drand_round, scheduled_open_at,
            station_device_id, exam_session, issue_no, issued_at
       from led.opening_key where package_id = $1::uuid
      order by issue_no desc limit 1`,
    [packageId],
  );
  return rows[0];
}

/**
 * A ceremony carries on only under the issue it began with.
 *
 * If the roster was re-issued after this ceremony started, the shares already
 * handed to the station belong to a key that is no longer the packet's. Mixing
 * them with the new issue's would assemble nothing, so the ceremony is told to
 * start again rather than left to fail at the last step.
 */
function currentIssue(c: Checks, key: KeyRow | undefined, ceremony: CeremonyState): void {
  if (!key || ceremony.issueNo === null) return;
  const stale = key.issue_no !== ceremony.issueNo;
  c.add(
    "current_issue",
    !stale,
    stale
      ? `this ceremony began under issue ${ceremony.issueNo}; the roster was re-issued at ` +
        `${key.issued_at.toISOString()} and the packet's key is now issue ${key.issue_no}. ` +
        "Its shares belong to the earlier issue and it has to be started again"
      : `this ceremony began under issue ${key.issue_no}, which is still the packet's`,
    "ceremony_step_out_of_order",
  );
}

/** Write one step down. Called before the step is answered. */
export async function recordStep(
  tx: PoolClient,
  ceremonyId: string,
  step: CeremonyStep,
  decision: StepDecision,
  extra: Record<string, unknown> = {},
  officials: unknown[] = [],
  photoSha256: string | null = null,
): Promise<void> {
  await tx.query(
    `insert into led.ceremony_step (ceremony_id, step, outcome, officials, photo_sha256, evidence)
     values ($1::uuid, $2, $3, $4::jsonb, $5, $6::jsonb)`,
    [
      ceremonyId, step, decision.outcome, JSON.stringify(officials), photoSha256,
      JSON.stringify({ ...extra, checks: decision.checks }),
    ],
  );
}

export interface StartRequest {
  packageId: string;
  deviceId: string;
  seamIdRead?: string | undefined;
  seamSecretHex?: string | undefined;
  /** What the gateway established about who signed the request. See gateway-guard. */
  deviceSigned?: { passed: boolean | undefined; evidence: string } | undefined;
}

export interface StartDecision {
  scan: StepDecision;
  authorize: StepDecision;
  centreId: string | null;
  scheduledOpenAt: Date | null;
  drandRound: number | null;
  /** The issue of the key this ceremony begins under. Null if none is issued. */
  issueNo: number | null;
  /** True when the scan found a label that reads cleanly and is not this packet's. */
  sealMismatch: boolean;
}

/** The first two steps: is this the sealed packet, and may it be opened here and now. */
export async function decideStart(
  tx: PoolClient,
  req: StartRequest,
  now: Date = new Date(),
): Promise<StartDecision> {
  const { rows: pkgs } = await tx.query<{
    id: string;
    centre_id: string;
    state: string;
    starts_at: Date;
    suspended_at: Date | null;
    seam_id: string | null;
    commitment_hex: string | null;
  }>(
    `select p.id, p.centre_id, p.state, e.starts_at, e.suspended_at, l.seam_id, l.commitment_hex
       from ref.package p
       join ref.exam e on e.id = p.exam_id
       left join ref.seal_label l on l.package_id = p.id
      where p.id = $1::uuid`,
    [req.packageId],
  );
  const pkg = pkgs[0];
  const key = pkg ? await loadKey(tx, pkg.id) : undefined;

  // ── scan ──
  const scan = new Checks();
  let sealMismatch = false;
  if (!pkg?.commitment_hex || !pkg.seam_id) {
    scan.add(
      "seam_commitment",
      false,
      pkg
        ? "this packet has no seam label on record, so there is nothing to verify a scan against"
        : `no packet with id ${req.packageId}`,
      "seam_token_absent",
    );
  } else if (!req.seamSecretHex) {
    scan.add(
      "seam_commitment",
      false,
      "both codes must be scanned; no seam secret was presented",
      "seam_token_absent",
    );
  } else {
    const secret = hexToBytes(req.seamSecretHex);
    const idSeen = req.seamIdRead ?? pkg.seam_id;
    const matches =
      secret !== null && idSeen === pkg.seam_id
        ? seamLabelMatches(pkg.seam_id, secret, pkg.commitment_hex)
        : false;
    sealMismatch = !matches;
    scan.add(
      "seam_commitment",
      matches,
      matches
        ? `label ${pkg.seam_id} matches the commitment recorded at sealing; the seal is intact`
        : `scanned label ${idSeen} does not match the commitment recorded for ${pkg.seam_id}`,
      "seam_token_mismatch",
    );
  }

  // ── authorize ──
  const auth = new Checks();
  auth.add(
    "opening_key_issued",
    Boolean(key),
    key
      ? `an opening key was issued for this packet; its control part opens at drand round ${key.drand_round}`
      : "no opening key has been issued for this packet; its centre's roster has not been locked",
    "opening_key_not_issued",
  );

  const { rows: devs } = await tx.query<{ id: string; kind: string; revoked_at: Date | null }>(
    "select id, kind, revoked_at from ref.device where id = $1::uuid",
    [req.deviceId],
  );
  const device = devs[0];
  auth.add(
    "station_enrolled",
    Boolean(device) && !device?.revoked_at,
    device
      ? device.revoked_at
        ? `station ${device.id} was revoked at ${device.revoked_at.toISOString()}`
        : `station ${device.id} (${device.kind}) is enrolled`
      : `device ${req.deviceId} is not enrolled`,
    device?.revoked_at ? "device_revoked" : "device_unknown",
  );
  auth.add(
    "station_signature",
    req.deviceSigned?.passed,
    req.deviceSigned?.evidence ?? "not evaluated: nothing was reported about who signed this request",
    "device_signature_mismatch",
  );
  auth.add(
    "station_holds_envelopes",
    key ? key.station_device_id === req.deviceId : undefined,
    !key
      ? "not evaluated: no opening key was issued"
      : key.station_device_id === req.deviceId
        ? "this is the station the shares were wrapped to"
        : "the shares for this packet were wrapped to a different station; this one cannot unwrap them",
    "device_not_bound_to_centre",
  );
  auth.add(
    "package_state",
    pkg ? pkg.state === "at_centre" : false,
    pkg
      ? pkg.state === "at_centre"
        ? "the packet is at its centre"
        : `the packet is ${pkg.state}, not at its centre`
      : "the packet is not registered",
    pkg?.state === "opened"
      ? "package_already_opened"
      : pkg?.state === "compromised"
        ? "package_compromised"
        : "package_state_unexpected",
  );
  auth.add(
    "exam_active",
    pkg ? !pkg.suspended_at : undefined,
    !pkg ? "not evaluated: the packet is unknown" : pkg.suspended_at ? "the exam is suspended" : "the exam is not suspended",
    "exam_suspended",
  );
  if (!pkg) {
    auth.add("ceremony_window", undefined, "not evaluated: the packet is unknown");
  } else {
    const from = new Date(pkg.starts_at.getTime() - CEREMONY_LEAD_MS);
    const inWindow = now >= from && now <= pkg.starts_at;
    auth.add(
      "ceremony_window",
      inWindow,
      `now ${now.toISOString()}; the ceremony may run from ${from.toISOString()} until the exam ` +
        `starts at ${pkg.starts_at.toISOString()}` +
        (now < from
          ? `; ${Math.round((from.getTime() - now.getTime()) / 60_000)} minutes early`
          : now > pkg.starts_at
            ? "; the exam has started, and an opening outside its window needs all three " +
              "officials and the control room's approval, which is not built"
            : ""),
      "ceremony_window_closed",
    );
  }

  return {
    scan: scan.decide(),
    authorize: auth.decide(),
    centreId: pkg?.centre_id ?? null,
    scheduledOpenAt: key?.scheduled_open_at ?? (pkg ? new Date(pkg.starts_at.getTime() - OPEN_LEAD_MS) : null),
    drandRound: key ? Number(key.drand_round) : null,
    issueNo: key?.issue_no ?? null,
    sealMismatch,
  };
}

export interface OfficialRequest {
  personId: string;
  biometricSlot?: number | undefined;
  biometricScore?: number | undefined;
  faceMatched?: boolean | undefined;
  assertedAt: string;
}

export interface OfficialDecision {
  decision: StepDecision;
  official: { personId: string; role: FieldHolder; institution: string } | null;
}

/** One official at the reader. Passing is what releases that official's wrapped share. */
export async function decideOfficial(
  tx: PoolClient,
  ceremony: CeremonyState,
  req: OfficialRequest,
): Promise<OfficialDecision> {
  const c = new Checks();
  const key = await loadKey(tx, ceremony.packageId);

  const authorized = ceremony.reached !== null && ORDER.indexOf(ceremony.reached) >= ORDER.indexOf("authorize");
  c.add(
    "ceremony_authorized",
    authorized,
    authorized
      ? "the scan and the authorisation both passed"
      : "this ceremony has not passed its scan and authorisation; nobody is identified before that",
    "ceremony_step_out_of_order",
  );
  const released = ceremony.steps.some((s) => s.step === "release" && s.outcome === "passed");
  c.add(
    "ceremony_open",
    !released,
    released ? "this ceremony has already released its key" : "the key has not been released yet",
    "package_already_opened",
  );
  currentIssue(c, key, ceremony);

  const share = key?.field_shares.find((s) => s.personId === req.personId);
  const { rows: people } = await tx.query<{ display_name: string; role: string }>(
    "select display_name, role from ref.person where id = $1::uuid",
    [req.personId],
  );
  const person = people[0];
  c.add(
    "on_duty_roster",
    Boolean(share),
    share
      ? `${person?.display_name ?? req.personId} holds the ${share.holder.replace(/_/g, " ")}'s share for this packet`
      : person
        ? `${person.display_name} (${person.role}) was not on the roster locked for this packet`
        : `person ${req.personId} is not registered`,
    "person_not_on_roster",
  );

  const already = ceremony.officials.find((o) => o.personId === req.personId);
  c.add(
    "not_already_identified",
    !already,
    already ? "this official has already been identified in this ceremony" : "first time at the reader in this ceremony",
    "two_person_required",
  );
  c.add(
    "third_official",
    ceremony.officials.length < 2,
    ceremony.officials.length < 2
      ? `${ceremony.officials.length} official${ceremony.officials.length === 1 ? "" : "s"} identified so far`
      : "two officials are already identified; a third share is not released",
    "two_person_required",
  );

  // ── two institutions ──
  const first = ceremony.officials[0];
  if (!first || !share) {
    c.add("different_institution", undefined, first ? "not evaluated: this person holds no share" : "not evaluated: this is the first official");
  } else {
    const differs = first.institution.trim().toLowerCase() !== share.institution.trim().toLowerCase();
    c.add(
      "different_institution",
      differs,
      `the first official answers to ${first.institution}; this one to ${share.institution}`,
      "same_institution_pair",
    );
  }

  // ── the finger ──
  if (req.biometricSlot === undefined || req.biometricScore === undefined) {
    c.add("biometric_presented", false, "no fingerprint was presented", first ? "biometric_secondary_missing" : "biometric_primary_missing");
    c.add("slot_registered", undefined, "not evaluated: no fingerprint to look up");
  } else {
    c.add(
      "biometric_presented",
      req.biometricScore >= MIN_BIOMETRIC_SCORE,
      `slot ${req.biometricSlot} matched with score ${req.biometricScore} (minimum ${MIN_BIOMETRIC_SCORE})`,
      first ? "biometric_secondary_missing" : "biometric_primary_missing",
    );
    if (!key) {
      c.add("slot_registered", undefined, "not evaluated: no station is on record for this packet");
    } else {
      const { rows } = await tx.query<{ person_id: string }>(
        `select person_id from ref.fingerprint_enrolment
          where device_id = $1::uuid and template_slot = $2 and revoked_at is null`,
        [key.station_device_id, req.biometricSlot],
      );
      const owner = rows[0]?.person_id;
      c.add(
        "slot_registered",
        owner === req.personId,
        owner === undefined
          ? `slot ${req.biometricSlot} is not registered on this station`
          : owner === req.personId
            ? `slot ${req.biometricSlot} is registered on this station to this official`
            : `slot ${req.biometricSlot} is registered to someone other than the official named`,
        "biometric_slot_not_registered",
      );
    }
  }

  c.add(
    "face_matched",
    req.faceMatched,
    req.faceMatched === undefined
      ? "not evaluated: the station sent no face reading"
      : req.faceMatched
        ? "the face matched"
        : "the face did not match",
    "face_not_matched",
  );

  // ── together ──
  if (!first?.assertedAt) {
    c.add("two_person_window", undefined, "not evaluated: this is the first official");
  } else {
    const seconds = Math.abs(new Date(req.assertedAt).getTime() - new Date(first.assertedAt).getTime()) / 1000;
    const readable = Number.isFinite(seconds);
    c.add(
      "two_person_window",
      readable && seconds <= TWO_OFFICIAL_WINDOW_S,
      readable
        ? `${Math.round(seconds)}s after the first official (limit ${TWO_OFFICIAL_WINDOW_S}s)` +
          (seconds > TWO_OFFICIAL_WINDOW_S ? "; the two were not at the reader together, and this ceremony has to be started again" : "")
        : "the time of this assertion could not be read",
      "two_person_window_not_met",
    );
  }

  const decision = c.decide();
  return {
    decision,
    official:
      decision.outcome === "passed" && share
        ? { personId: req.personId, role: share.holder, institution: share.institution }
        : null,
  };
}

/** The wrapped share for one official of one packet. Read only after they pass. */
export async function wrappedShareFor(
  tx: PoolClient,
  packageId: string,
  personId: string,
): Promise<{ wrapped: unknown; holder: FieldHolder; institution: string; index: number; commitment: string } | null> {
  const key = await loadKey(tx, packageId);
  const meta = key?.field_shares.find((s) => s.personId === personId);
  if (!meta) return null;
  const { rows } = await tx.query<{ ciphertext: string }>(
    `select ciphertext from led.share_envelope
      where package_id = $1::uuid and kind = 'field_person' and holder = $2 and issue_no = $3
      order by issued_at desc limit 1`,
    [packageId, personId, key!.issue_no],
  );
  if (!rows[0]) return null;
  return {
    wrapped: JSON.parse(rows[0].ciphertext),
    holder: meta.holder,
    institution: meta.institution,
    index: meta.index,
    commitment: meta.commitment,
  };
}

export interface ConfirmDecision {
  decision: StepDecision;
  raisesAlert: boolean;
}

/** The senior officer types the serial printed on the packet. */
export async function decideConfirm(
  tx: PoolClient,
  ceremony: CeremonyState,
  packetSerialTyped: string,
): Promise<ConfirmDecision> {
  const c = new Checks();
  c.add(
    "two_officials_identified",
    ceremony.officials.length >= 2,
    `${ceremony.officials.length} of 2 officials identified`,
    "ceremony_step_out_of_order",
  );
  currentIssue(c, await loadKey(tx, ceremony.packageId), ceremony);

  const { rows } = await tx.query<{ seal_serial: string | null }>(
    "select seal_serial from ref.package where id = $1::uuid",
    [ceremony.packageId],
  );
  const registered = rows[0]?.seal_serial?.trim().toUpperCase() ?? null;
  const typed = packetSerialTyped.trim().toUpperCase();
  const matches = registered !== null && typed === registered;
  c.add(
    "packet_serial",
    registered === null ? undefined : matches,
    registered === null
      ? "not evaluated: no serial is registered for this packet"
      : `typed ${typed}; registered ${registered}`,
    "packet_serial_mismatch",
  );

  const wrongBefore = ceremony.steps.filter(
    (s) =>
      s.step === "confirm" &&
      s.outcome === "refused" &&
      (s.evidence.checks ?? []).some((k) => k.reason === "packet_serial_mismatch"),
  ).length;
  c.add(
    "attempt_rate",
    wrongBefore < SERIAL_ATTEMPT_LIMIT,
    `${wrongBefore} wrong serial entr${wrongBefore === 1 ? "y" : "ies"} in this ceremony before this one (limit ${SERIAL_ATTEMPT_LIMIT})`,
    "duplicate_session",
  );

  return {
    decision: c.decide(),
    raisesAlert: registered !== null && !matches && wrongBefore + 1 === SERIAL_ATTEMPT_LIMIT,
  };
}

/**
 * The two commitments a station checks its reconstruction against. They are
 * hashes, and are handed out freely: neither says anything about the key.
 */
export async function commitmentsFor(
  tx: PoolClient | Pool,
  packageId: string,
): Promise<{ controlCommitment: string; keyCommitment: string } | null> {
  const { rows } = await tx.query<{ control_commitment: string; key_commitment: string }>(
    `select control_commitment, key_commitment from led.opening_key
      where package_id = $1::uuid order by issue_no desc limit 1`,
    [packageId],
  );
  return rows[0]
    ? { controlCommitment: rows[0].control_commitment, keyCommitment: rows[0].key_commitment }
    : null;
}

/** The control envelope for a packet, as the station needs it to unwrap. */
export async function controlEnvelopeFor(
  tx: PoolClient | Pool,
  packageId: string,
): Promise<ControlEnvelope | null> {
  const { rows } = await tx.query<{ ciphertext: string }>(
    `select ciphertext from led.share_envelope
      where package_id = $1::uuid and kind = 'control_timelock'
      order by issue_no desc, issued_at desc limit 1`,
    [packageId],
  );
  return rows[0] ? (JSON.parse(rows[0].ciphertext) as ControlEnvelope) : null;
}

/**
 * The station presents the key it assembled.
 *
 * Only the hash is compared, in constant time, and the key is not kept: it
 * proved what it had to prove by matching, and after the opening it is worth
 * nothing.
 */
export async function decideRelease(
  tx: PoolClient,
  ceremony: CeremonyState,
  openingKeyHex: string,
  now: Date = new Date(),
): Promise<StepDecision> {
  const c = new Checks();
  const key = await loadKey(tx, ceremony.packageId);

  const confirmed = ceremony.reached !== null && ORDER.indexOf(ceremony.reached) >= ORDER.indexOf("confirm");
  c.add(
    "serial_confirmed",
    confirmed,
    confirmed ? "two officials were identified and the serial was confirmed" : "the serial has not been confirmed in this ceremony",
    "ceremony_step_out_of_order",
  );
  const released = ceremony.steps.some((s) => s.step === "release" && s.outcome === "passed");
  c.add(
    "not_already_released",
    !released,
    released ? "this ceremony has already released its key" : "no key has been released in this ceremony",
    "package_already_opened",
  );
  currentIssue(c, key, ceremony);

  if (!key) {
    c.add("round_published", undefined, "not evaluated: no opening key was issued for this packet");
    c.add("key_commitment", false, "no opening key was issued for this packet", "opening_key_not_issued");
  } else {
    // The server's own reading of the public clock. The cryptography already
    // enforces this - a key assembled before the round cannot exist - and the
    // check is here so that the record says so in words.
    const current = roundAt(now);
    const round = Number(key.drand_round);
    c.add(
      "round_published",
      current >= round,
      current >= round
        ? `drand round ${round} has been published (the current round is ${current})`
        : `drand round ${round} is not published yet (the current round is ${current}); ` +
          `the control room's part opens at ${key.scheduled_open_at.toISOString()}`,
      "control_part_still_locked",
    );
    const presented = hexToBytes(openingKeyHex);
    const matches =
      presented !== null &&
      presented.length === 32 &&
      timingSafeEqual(Buffer.from(sha256Hex(presented), "hex"), Buffer.from(key.key_commitment, "hex"));
    c.add(
      "key_commitment",
      matches,
      matches
        ? "the key the station assembled hashes to the commitment made when it was split"
        : "what the station presented does not hash to the commitment made when the key was split",
      "opening_key_mismatch",
    );
  }

  return c.decide();
}

// ── the opening with no link to the ledger ──────────────────────────────────

/**
 * What a station needs to open one packet with the ledger out of reach: the
 * time-locked envelope, all three officials' wrapped shares, and what to check
 * a scan, a finger and a serial against.
 *
 * Handing this over changes who is trusted with what, and it is as well to say
 * so. On the live path a share leaves the ledger only when the engine has
 * identified its official. A station holding this cache has all three shares
 * and can unwrap any of them with its own key; that two officials stood at the
 * reader is then something the station enforces and reports, not something the
 * ledger watched. What does not change is the time lock: no cache opens the
 * control room's part before its round, so an early opening stays impossible
 * whichever path is taken.
 */
export interface StationCache {
  packageId: string;
  packetSerial: string | null;
  centreCode: string;
  examStartsAt: string;
  scheduledOpenAt: string;
  issueNo: number;
  drandRound: number;
  seam: { seamId: string; commitmentHex: string } | null;
  commitments: { controlCommitment: string; keyCommitment: string };
  envelope: ControlEnvelope;
  officials: {
    personId: string;
    name: string;
    holder: FieldHolder;
    institution: string;
    index: number;
    commitment: string;
    /** The slot this official's finger is registered in on this station, if any. */
    slot: number | null;
    wrapped: unknown;
  }[];
}

export type CacheResult =
  | { ok: true; cache: StationCache }
  | { ok: false; code: 403 | 404; error: string };

export async function stationCache(
  tx: PoolClient,
  deviceId: string,
  packageId: string,
): Promise<CacheResult> {
  const key = await loadKey(tx, packageId);
  if (!key) return { ok: false, code: 404, error: "no opening key has been issued for this packet" };
  if (key.station_device_id !== deviceId) {
    return {
      ok: false,
      code: 403,
      error: "this packet's shares were wrapped to a different station",
    };
  }
  const { rows: pk } = await tx.query<{
    seal_serial: string | null;
    code: string;
    starts_at: Date;
    seam_id: string | null;
    commitment_hex: string | null;
  }>(
    `select p.seal_serial, c.code, e.starts_at, l.seam_id, l.commitment_hex
       from ref.package p
       join ref.centre c on c.id = p.centre_id
       join ref.exam e on e.id = p.exam_id
       left join ref.seal_label l on l.package_id = p.id
      where p.id = $1::uuid`,
    [packageId],
  );
  const p = pk[0]!;
  const envelope = await controlEnvelopeFor(tx, packageId);
  const commitments = await commitmentsFor(tx, packageId);
  if (!envelope || !commitments) {
    return { ok: false, code: 404, error: "the envelope for this packet is not on record" };
  }

  const officials: StationCache["officials"] = [];
  for (const meta of key.field_shares) {
    const share = await wrappedShareFor(tx, packageId, meta.personId);
    const { rows: who } = await tx.query<{ display_name: string; slot: number | null }>(
      `select p.display_name,
              (select f.template_slot from ref.fingerprint_enrolment f
                where f.person_id = p.id and f.device_id = $2::uuid and f.revoked_at is null
                order by f.enrolled_at desc limit 1) as slot
         from ref.person p where p.id = $1::uuid`,
      [meta.personId, deviceId],
    );
    if (!share) continue;
    officials.push({
      personId: meta.personId,
      name: who[0]?.display_name ?? meta.personId,
      holder: meta.holder,
      institution: meta.institution,
      index: meta.index,
      commitment: meta.commitment,
      slot: who[0]?.slot ?? null,
      wrapped: share.wrapped,
    });
  }

  return {
    ok: true,
    cache: {
      packageId,
      packetSerial: p.seal_serial,
      centreCode: p.code,
      examStartsAt: p.starts_at.toISOString(),
      scheduledOpenAt: key.scheduled_open_at.toISOString(),
      issueNo: key.issue_no,
      drandRound: Number(key.drand_round),
      seam: p.seam_id && p.commitment_hex ? { seamId: p.seam_id, commitmentHex: p.commitment_hex } : null,
      commitments,
      envelope,
      officials,
    },
  };
}

/** What a station reports once it can reach the ledger again. */
export interface OfflineTranscript {
  /** Made by the station when the opening began. Sending it twice records it once. */
  transcriptId: string;
  packageId: string;
  deviceId: string;
  seamIdRead?: string | undefined;
  seamSecretHex?: string | undefined;
  officials: OfficialRequest[];
  packetSerialTyped: string;
  openingKeyHex: string;
  photoSha256?: string | undefined;
  /** By the station's own clock. */
  startedAt: string;
  releasedAt: string;
}

export interface OfflineRuling {
  ceremonyId: string;
  /** True when this transcript had already been recorded. */
  duplicate: boolean;
  outcome: "accepted" | "disputed";
  steps: { step: CeremonyStep; decision: StepDecision }[];
  denyReasons: DenyReason[];
  /** Empty for a duplicate: its events went on the chain the first time. */
  chainEvents: ChainEventOutcome[];
}

export const OFFLINE_OPENING_DISPUTED = "OFFLINE_OPENING_DISPUTED";

/**
 * Rule on an opening that already happened.
 *
 * The station opened the packet from its cache with no link to the ledger, and
 * this is its account of it. Every step is put to the same checks as the live
 * path, in the same order, and written down as a ceremony whose mode is
 * `envelope-authorized`. The difference is what a refusal means. On the live
 * path a refused step stops the opening. Here the packet is open whatever is
 * decided, so a transcript that fails a check does not undo anything: it is
 * recorded as it was reported and raised for the control room, because an
 * opening that cannot account for itself is the finding.
 *
 * The times are the station's own, and each step says so. One of them can be
 * held to something outside the station: the key in the transcript hashes to
 * the commitment only if the control room's part was opened, and that could
 * not be done before the round was published.
 */
export async function recordOfflineOpening(
  tx: PoolClient,
  t: OfflineTranscript,
  now: Date = new Date(),
): Promise<OfflineRuling | null> {
  const { rows: seen } = await tx.query<{ ceremony_id: string }>(
    `select s.ceremony_id from led.ceremony_step s join led.ceremony c on c.id = s.ceremony_id
      where c.package_id = $1::uuid and s.step = 'scan' and s.evidence ->> 'transcriptId' = $2
      limit 1`,
    [t.packageId, t.transcriptId],
  );
  if (seen[0]) {
    const state = await loadCeremony(tx, seen[0].ceremony_id);
    const steps = (state?.steps ?? []).map((s) => ({
      step: s.step,
      decision: {
        outcome: s.outcome,
        checks: s.evidence.checks ?? [],
        denyReasons: [
          ...new Set((s.evidence.checks ?? []).filter((c) => c.passed === false && c.reason).map((c) => c.reason!)),
        ],
      },
    }));
    return {
      ceremonyId: seen[0].ceremony_id,
      duplicate: true,
      outcome: steps.every((s) => s.decision.outcome === "passed") ? "accepted" : "disputed",
      steps,
      denyReasons: [...new Set(steps.flatMap((s) => s.decision.denyReasons))],
      chainEvents: [],
    };
  }

  const startedAt = new Date(t.startedAt);
  const releasedAt = new Date(t.releasedAt);
  const start = await decideStart(tx, t, startedAt);
  if (!start.centreId || !start.scheduledOpenAt) return null;

  const { rows } = await tx.query<{ id: string }>(
    `insert into led.ceremony (package_id, mode, centre_id, scheduled_open_at)
     values ($1::uuid, 'envelope-authorized', $2::uuid, $3) returning id`,
    [t.packageId, start.centreId, start.scheduledOpenAt],
  );
  const id = rows[0]!.id;
  const claimed = {
    mode: "envelope-authorized",
    transcriptId: t.transcriptId,
    deviceId: t.deviceId,
    // Whose clock. The station's times are evidence of what it says happened,
    // and the ledger's is when it was told.
    stationStartedAt: t.startedAt,
    stationReleasedAt: t.releasedAt,
    uploadedAt: now.toISOString(),
    secondsUntilUpload: Math.round((now.getTime() - releasedAt.getTime()) / 1000),
  };
  const steps: OfflineRuling["steps"] = [];
  const note = async (
    step: CeremonyStep,
    decision: StepDecision,
    extra: Record<string, unknown> = {},
    officials: unknown[] = [],
    photo: string | null = null,
  ) => {
    await recordStep(tx, id, step, decision, { ...claimed, ...extra }, officials, photo);
    steps.push({ step, decision });
  };

  await note("scan", start.scan, {
    ...(t.seamIdRead ? { seamIdRead: t.seamIdRead } : {}),
    ...(start.issueNo === null ? {} : { issueNo: start.issueNo }),
  });
  await note("authorize", start.authorize);

  for (const official of t.officials) {
    const state = (await loadCeremony(tx, id))!;
    const d = await decideOfficial(tx, state, official);
    await note(
      "identify",
      d.decision,
      { personId: official.personId },
      d.official
        ? [
            {
              ...d.official,
              biometricSlot: official.biometricSlot,
              biometricScore: official.biometricScore,
              ...(official.faceMatched === undefined ? {} : { faceMatched: official.faceMatched }),
              assertedAt: official.assertedAt,
            },
          ]
        : [],
    );
  }

  const confirm = await decideConfirm(tx, (await loadCeremony(tx, id))!, t.packetSerialTyped);
  await note("confirm", confirm.decision, { serialTyped: t.packetSerialTyped });

  // Judged at the time the station says it released. The key matching is what
  // holds that claim to the public clock.
  const beforeRelease = (await loadCeremony(tx, id))!;
  const release = await decideRelease(tx, beforeRelease, t.openingKeyHex, releasedAt);
  const ordered = startedAt.getTime() <= releasedAt.getTime() && releasedAt.getTime() <= now.getTime() + 120_000;
  release.checks.push({
    check: "station_times",
    passed: ordered,
    evidence: ordered
      ? `by the station's clock it began ${t.startedAt} and released ${t.releasedAt}; ` +
        `the ledger was told ${claimed.secondsUntilUpload}s after the release`
      : `the station's times are out of order: began ${t.startedAt}, released ${t.releasedAt}, ` +
        `told to the ledger ${now.toISOString()}`,
    ...(ordered ? {} : { reason: "clock_skew_excessive" as const }),
  });
  const releaseDecision: StepDecision = {
    outcome: release.checks.every((c) => c.passed !== false) ? "passed" : "refused",
    checks: release.checks,
    denyReasons: [
      ...new Set(release.checks.filter((c) => c.passed === false && c.reason).map((c) => c.reason!)),
    ],
  };
  await note("release", releaseDecision, {}, beforeRelease.officials);

  const allPassed = steps.every((s) => s.decision.outcome === "passed");
  // The station says the packet is open. That is recorded either way; whether
  // the opening is accepted is what the steps above decided.
  await note(
    "opened",
    {
      outcome: allPassed ? "passed" : "refused",
      checks: [
        {
          check: "transcript_accepted",
          passed: allPassed,
          evidence: allPassed
            ? "every step of the station's account passed the checks the live path applies"
            : "the station reports the packet opened, and its account of the opening fails at least one check",
          ...(allPassed ? {} : { reason: "ceremony_step_out_of_order" as const }),
        },
      ],
      denyReasons: allPassed ? [] : ["ceremony_step_out_of_order"],
    },
    {},
    beforeRelease.officials,
    t.photoSha256 ?? null,
  );

  const denyReasons = [...new Set(steps.flatMap((s) => s.decision.denyReasons))];
  // The key in the transcript is the packet's key or it is not. If it is, the
  // key has been assembled and the packet is open in fact, whatever else the
  // account gets wrong, and the plan says so. If it is not, all the ledger has
  // is a station's word, and the plan is left as it was.
  const keyProven = release.checks.find((c) => c.check === "key_commitment")?.passed === true;
  if (keyProven) {
    await tx.query(
      "update ref.package set state = 'opened', updated_at = now() where id = $1::uuid and state <> 'compromised'",
      [t.packageId],
    );
  }

  // On the chain at the time the station says it happened. The append records
  // how long after that the ledger was told, so the claim is not mistaken for
  // an observation.
  const chainEvents: ChainEventOutcome[] = [];
  if (releaseDecision.outcome === "passed") {
    chainEvents.push(await recordOpenCeremony(tx, id, keyProven, releasedAt));
  }
  if (keyProven) {
    chainEvents.push(await recordPacketOpened(tx, id, { photoSha256: t.photoSha256 }, releasedAt));
  }
  if (!allPassed) {
    const failed = steps
      .filter((s) => s.decision.outcome === "refused")
      .map((s) => s.step)
      .filter((s, i, a) => a.indexOf(s) === i);
    await tx.query(
      `insert into led.alert (kind, package_id, centre_id, evidence, requires_decision, consequence)
       values ($1, $2::uuid, $3::uuid, $4::jsonb, true, $5)`,
      [
        OFFLINE_OPENING_DISPUTED,
        t.packageId,
        start.centreId,
        JSON.stringify({ ceremonyId: id, ...claimed, failedSteps: failed, denyReasons }),
        `A station reports that it opened this packet with no link to the ledger, and the ` +
          `account it uploaded afterwards does not pass: ${failed.join(", ")} failed ` +
          `(${denyReasons.join(", ")}). ` +
          (keyProven
            ? "The key it presents is the packet's, so the packet is open. "
            : "The key it presents is not the packet's, so whether the packet is open is the station's word. ") +
          `Nobody was in a position to refuse it at the time, so the control room establishes ` +
          `from the officials named, the photograph and the CCTV what happened, and records it.`,
      ],
    );
  }

  return {
    ceremonyId: id,
    duplicate: false,
    outcome: allPassed ? "accepted" : "disputed",
    steps,
    denyReasons,
    chainEvents,
  };
}

// ── the hard floor ──────────────────────────────────────────────────────────

export const CEREMONY_INCOMPLETE = "CEREMONY_INCOMPLETE";

export interface IncompleteFacts {
  ceremonyId: string;
  packageId: string;
  centreCode: string | null;
  packetSerial: string | null;
  scheduledOpenAt: Date;
  reached: CeremonyStep | null;
  officials: { name: string; role: string }[];
  refusedSteps: number;
}

/** Pure, so the wording can be tested. */
export function describeIncomplete(f: IncompleteFacts, now: Date): {
  evidence: Record<string, unknown>;
  consequence: string;
} {
  const overdueBySeconds = Math.max(1, Math.round((now.getTime() - f.scheduledOpenAt.getTime()) / 1000));
  const got =
    f.reached === null
      ? "did not pass its scan"
      : f.reached === "identify" || f.reached === "confirm"
        ? `reached "${f.reached}" with ${f.officials.map((o) => `${o.name} (${o.role.replace(/_/g, " ")})`).join(" and ")} identified`
        : `reached "${f.reached}"`;
  return {
    evidence: {
      ceremonyId: f.ceremonyId,
      packageId: f.packageId,
      scheduledOpenAt: f.scheduledOpenAt.toISOString(),
      detectedAt: now.toISOString(),
      overdueBySeconds,
      reached: f.reached ?? "nothing",
      refusedSteps: f.refusedSteps,
      officials: f.officials,
      ...(f.centreCode ? { centreCode: f.centreCode } : {}),
      ...(f.packetSerial ? { packetSerial: f.packetSerial } : {}),
    },
    consequence:
      `An opening ceremony for this packet was started at ${f.centreCode ? `centre ${f.centreCode}` : "its centre"} ` +
      `and ${got}, but the key had not been released when the packet was due to open. ` +
      `${f.refusedSteps} step${f.refusedSteps === 1 ? " was" : "s were"} refused along the way. ` +
      `The centre cannot open this packet on its own from here; the control room takes over ` +
      `the opening with the centre on the line and records how it proceeds.`,
  };
}

/**
 * Raise CEREMONY_INCOMPLETE for every packet whose ceremony was started and had
 * not released by the scheduled minute. Once per packet. Run by the watchdog.
 */
export async function sweepIncompleteCeremonies(pool: Pool, now: Date = new Date()): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('watchdog:ceremony_incomplete'))");
    const { rows } = await client.query<{
      id: string;
      package_id: string;
      centre_id: string;
      scheduled_open_at: Date;
      centre_code: string | null;
      seal_serial: string | null;
    }>(
      `select distinct on (c.package_id)
              c.id, c.package_id, c.centre_id, c.scheduled_open_at,
              ce.code as centre_code, p.seal_serial
         from led.ceremony c
         join ref.package p on p.id = c.package_id
         left join ref.centre ce on ce.id = c.centre_id
        where c.scheduled_open_at < $1::timestamptz
          and c.scheduled_open_at > $1::timestamptz - interval '48 hours'
          and not exists (
            select 1 from led.ceremony c2 join led.ceremony_step s on s.ceremony_id = c2.id
             where c2.package_id = c.package_id and s.step = 'release' and s.outcome = 'passed')
          and not exists (
            select 1 from led.alert a where a.package_id = c.package_id and a.kind = $2)
        order by c.package_id, c.started_at desc`,
      [now, CEREMONY_INCOMPLETE],
    );
    const raised: string[] = [];
    for (const r of rows) {
      const state = await loadCeremony(client, r.id);
      if (!state) continue;
      const { rows: people } = await client.query<{ display_name: string; role: string }>(
        "select display_name, role from ref.person where id = any($1::uuid[])",
        [state.officials.map((o) => o.personId)],
      );
      const alert = describeIncomplete(
        {
          ceremonyId: r.id,
          packageId: r.package_id,
          centreCode: r.centre_code,
          packetSerial: r.seal_serial,
          scheduledOpenAt: r.scheduled_open_at,
          reached: state.reached,
          officials: people.map((p) => ({ name: p.display_name, role: p.role })),
          refusedSteps: state.steps.filter((s) => s.outcome === "refused").length,
        },
        now,
      );
      await client.query(
        `insert into led.alert (kind, package_id, centre_id, evidence, requires_decision, consequence)
         values ($1, $2::uuid, $3::uuid, $4::jsonb, true, $5)`,
        [CEREMONY_INCOMPLETE, r.package_id, r.centre_id, JSON.stringify(alert.evidence), alert.consequence],
      );
      // The ceremony's own record of the floor being hit.
      await recordStep(
        client,
        r.id,
        "incomplete",
        { outcome: "refused", checks: [], denyReasons: [] },
        { reached: state.reached ?? "nothing", scheduledOpenAt: r.scheduled_open_at.toISOString() },
      );
      await recordCeremonyIncomplete(client, r.id, {
        reached: state.reached,
        officialsIdentified: state.officials.length,
      });
      raised.push(r.package_id);
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
