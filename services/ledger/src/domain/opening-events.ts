import type { PoolClient } from "pg";
import { PersonRole } from "@mohar/contracts";
import {
  appendServiceEvent,
  notRecorded,
  type ChainEventOutcome,
} from "./service-events.js";

/**
 * ── The roster lock and the opening, as signed events ────────────────────────
 *
 *   a key issued for a packet       → CONTROL_ENVELOPE_ISSUED
 *   shares wrapped to the station   → SHARES_REWRAPPED   (lock and re-issue)
 *   the key released                → OPEN_CEREMONY
 *   the packet opened               → PACKET_OPENED
 *   not released by the minute      → CEREMONY_INCOMPLETE
 *
 * Nothing here carries key material: a round number, the hash of a ciphertext,
 * who and which device. This file reads the ceremony's own rows rather than
 * importing the engine, so the engine can call it without a cycle.
 */

export async function recordEnvelopeIssued(
  tx: PoolClient,
  f: {
    examId: string;
    centreId: string;
    packageId: string;
    drandRound: number;
    drandChainHash: string;
    scheduledOpenAt: Date;
    ciphertextSha256: string;
    stationDeviceId: string;
  },
): Promise<ChainEventOutcome> {
  return appendServiceEvent(tx, {
    kind: "CONTROL_ENVELOPE_ISSUED",
    examId: f.examId,
    centreId: f.centreId,
    packageId: f.packageId,
    payload: {
      packageId: f.packageId,
      drandRound: f.drandRound,
      drandChainHash: f.drandChainHash,
      scheduledOpenAt: f.scheduledOpenAt.toISOString(),
      ciphertextSha256: f.ciphertextSha256,
      stationDeviceId: f.stationDeviceId,
    },
  });
}

export async function recordSharesRewrapped(
  tx: PoolClient,
  f: {
    examId: string;
    centreId: string;
    examSession: string;
    duty: readonly { role: string; person_id: string }[];
    stationDeviceId: string;
    rosterLockedAt: Date | null | undefined;
  },
): Promise<ChainEventOutcome> {
  const kind = "SHARES_REWRAPPED";
  if (!f.rosterLockedAt) return notRecorded(kind, "the roster has no lock time on record");
  const rewrapped = [];
  for (const d of f.duty) {
    const role = PersonRole.safeParse(d.role);
    if (!role.success) return notRecorded(kind, `duty role ${d.role} is not a role an event can name`);
    rewrapped.push({ role: role.data, personId: d.person_id, deviceId: f.stationDeviceId });
  }
  if (rewrapped.length === 0) return notRecorded(kind, "the roster names nobody");
  return appendServiceEvent(tx, {
    kind,
    examId: f.examId,
    centreId: f.centreId,
    payload: {
      centreId: f.centreId,
      examSession: f.examSession,
      rewrapped,
      rosterLockedAt: f.rosterLockedAt.toISOString(),
    },
  });
}

interface CeremonyRow {
  package_id: string;
  centre_id: string;
  mode: "live-authorized" | "envelope-authorized";
  scheduled_open_at: Date;
  exam_id: string;
  seal_serial: string | null;
  drand_round: string | null;
}

async function ceremonyRow(tx: PoolClient, ceremonyId: string): Promise<CeremonyRow | undefined> {
  const { rows } = await tx.query<CeremonyRow>(
    `select c.package_id, c.centre_id, c.mode, c.scheduled_open_at, p.exam_id, p.seal_serial,
            (select k.drand_round::text from led.opening_key k
              where k.package_id = c.package_id order by k.issue_no desc limit 1) as drand_round
       from led.ceremony c join ref.package p on p.id = c.package_id
      where c.id = $1::uuid`,
    [ceremonyId],
  );
  return rows[0];
}

interface RecordedOfficial {
  personId?: string;
  role?: string;
  institution?: string;
  biometricSlot?: number;
  biometricScore?: number;
  faceMatched?: boolean;
  assertedAt?: string;
}

/** The officials whose identification passed, as the identify steps wrote them. */
async function identified(tx: PoolClient, ceremonyId: string): Promise<RecordedOfficial[]> {
  const { rows } = await tx.query<{ officials: RecordedOfficial[] }>(
    `select officials from led.ceremony_step
      where ceremony_id = $1::uuid and step = 'identify' and outcome = 'passed'
      order by recorded_at, id`,
    [ceremonyId],
  );
  // In the order they presented, by the time each put a finger down. Two steps
  // written in one transaction share a recorded_at, so that cannot order them.
  return rows
    .flatMap((r) => r.officials)
    .sort((x, y) => Date.parse(x.assertedAt ?? "") - Date.parse(y.assertedAt ?? ""));
}

/**
 * The key was released. `keyMatchedCommitment` is the engine's own check: the
 * key hashes to the commitment only if the control room's part was in it.
 */
export async function recordOpenCeremony(
  tx: PoolClient,
  ceremonyId: string,
  keyMatchedCommitment: boolean,
  occurredAt?: Date,
): Promise<ChainEventOutcome> {
  const kind = "OPEN_CEREMONY";
  const c = await ceremonyRow(tx, ceremonyId);
  if (!c) return notRecorded(kind, "no such ceremony");
  if (!c.drand_round) return notRecorded(kind, "no opening key was issued for this packet");

  const people = await identified(tx, ceremonyId);
  if (people.length !== 2) {
    return notRecorded(kind, `${people.length} officials were identified; the event names exactly two`);
  }
  const officials = [];
  for (const o of people) {
    const role = PersonRole.safeParse(o.role);
    if (
      !o.personId || !role.success || !o.institution ||
      o.biometricSlot === undefined || o.biometricScore === undefined
    ) {
      return notRecorded(kind, "an identified official has no role, institution or fingerprint reading on record");
    }
    officials.push({
      personId: o.personId,
      role: role.data,
      institution: o.institution,
      biometricSlot: o.biometricSlot,
      biometricScore: o.biometricScore,
      ...(o.faceMatched === undefined ? {} : { faceMatched: o.faceMatched }),
    });
  }
  const [a, b] = people.map((o) => Date.parse(o.assertedAt ?? ""));
  if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) {
    return notRecorded(kind, "the times the two officials presented could not be read");
  }

  return appendServiceEvent(tx, {
    kind,
    examId: c.exam_id,
    centreId: c.centre_id,
    packageId: c.package_id,
    occurredAt,
    payload: {
      ceremonyId,
      packageId: c.package_id,
      mode: c.mode,
      officials,
      secondsBetweenOfficials: Math.round(Math.abs(a - b) / 1000),
      controlPartUsed: keyMatchedCommitment,
      drandRound: Number(c.drand_round),
    },
  });
}

export async function recordPacketOpened(
  tx: PoolClient,
  ceremonyId: string,
  f: { photoSha256: string | null | undefined; candidateWitnesses?: number | undefined },
  occurredAt: Date = new Date(),
): Promise<ChainEventOutcome> {
  const kind = "PACKET_OPENED";
  const c = await ceremonyRow(tx, ceremonyId);
  if (!c) return notRecorded(kind, "no such ceremony");
  if (!c.seal_serial) return notRecorded(kind, "no serial is registered for this packet");
  if (!f.photoSha256) return notRecorded(kind, "no photograph of the opened packet was reported");

  return appendServiceEvent(tx, {
    kind,
    examId: c.exam_id,
    centreId: c.centre_id,
    packageId: c.package_id,
    occurredAt,
    payload: {
      ceremonyId,
      packageId: c.package_id,
      packetSerial: c.seal_serial,
      // Whose hands opened it is not something the ceremony records; the two
      // officials are named on OPEN_CEREMONY.
      photoSha256: f.photoSha256,
      ...(f.candidateWitnesses === undefined ? {} : { candidateWitnesses: f.candidateWitnesses }),
      offsetFromScheduledSeconds: Math.round(
        (occurredAt.getTime() - c.scheduled_open_at.getTime()) / 1000,
      ),
    },
  });
}

export async function recordCeremonyIncomplete(
  tx: PoolClient,
  ceremonyId: string,
  f: { reached: string | null; officialsIdentified: number },
): Promise<ChainEventOutcome> {
  const kind = "CEREMONY_INCOMPLETE";
  const c = await ceremonyRow(tx, ceremonyId);
  if (!c) return notRecorded(kind, "no such ceremony");
  const reached = f.reached ?? "none";
  if (
    reached !== "none" && reached !== "scan" && reached !== "authorize" &&
    reached !== "identify" && reached !== "confirm" && reached !== "release"
  ) {
    return notRecorded(kind, `the ceremony stands at "${reached}", which is not an unfinished step`);
  }
  return appendServiceEvent(tx, {
    kind,
    examId: c.exam_id,
    centreId: c.centre_id,
    packageId: c.package_id,
    payload: {
      ceremonyId,
      packageId: c.package_id,
      reachedStep: reached,
      officialsConfirmed: Math.min(3, f.officialsIdentified),
      deadline: c.scheduled_open_at.toISOString(),
    },
  });
}
