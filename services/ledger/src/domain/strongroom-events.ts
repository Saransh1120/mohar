import type { PoolClient } from "pg";
import {
  appendServiceEvent,
  notRecorded,
  type ChainEventOutcome,
} from "./service-events.js";

/**
 * ── The strong room door, as signed events ───────────────────────────────────
 *
 *   entry granted         → STRONGROOM_ENTRY
 *   exit granted          → STRONGROOM_EXIT
 *   a visit ran long      → DWELL_EXCEEDED
 *   monitor counted more  → FOOTFALL_MISMATCH
 *
 * An event is filed under an exam, and a room reaches one only through its
 * centre. A room attached to no centre (a district treasury serving several)
 * has no exam to file under, so its events are not written and the caller is
 * told why. led.strongroom_attempt, _visit and _exit hold the record either
 * way. A refused entry has no event kind in the contract; it is in
 * led.strongroom_attempt.
 */

interface Filing {
  examId: string;
  centreId: string;
}

async function filingFor(tx: PoolClient, roomId: string): Promise<Filing | null> {
  const { rows } = await tx.query<{ centre_id: string | null; exam_id: string | null }>(
    `select r.centre_id, c.exam_id
       from ref.strong_room r
       left join ref.centre c on c.id = r.centre_id
      where r.id = $1::uuid`,
    [roomId],
  );
  const r = rows[0];
  return r?.centre_id && r.exam_id ? { examId: r.exam_id, centreId: r.centre_id } : null;
}

const NO_CENTRE = "this room is attached to no centre, so there is no exam to file the event under";

export interface EntryFacts {
  visitId: string;
  roomId: string;
  entrants: readonly {
    personId: string;
    biometricSlot?: number | undefined;
    faceMatched?: boolean | undefined;
  }[];
  secondsBetween: number | null;
  expectedMinutes: number;
}

export async function recordEntryEvent(tx: PoolClient, f: EntryFacts): Promise<ChainEventOutcome> {
  const kind = "STRONGROOM_ENTRY";
  const filing = await filingFor(tx, f.roomId);
  if (!filing) return notRecorded(kind, NO_CENTRE);

  // A granted entry had two people, two fingers and a readable gap between
  // them; the engine refuses otherwise. Checked rather than assumed.
  const slots = f.entrants.map((e) => e.biometricSlot);
  if (f.entrants.length !== 2 || slots.some((s) => s === undefined) || f.secondsBetween === null) {
    return notRecorded(kind, "the granted entry did not carry two fingerprint readings and their times");
  }
  const faces = f.entrants.map((e) => e.faceMatched);
  const facesRead = faces.every((m): m is boolean => m !== undefined);

  return appendServiceEvent(tx, {
    kind,
    ...filing,
    payload: {
      visitId: f.visitId,
      roomId: f.roomId,
      personIds: f.entrants.map((e) => e.personId),
      secondsBetweenConfirmations: f.secondsBetween,
      biometricSlots: slots as number[],
      // Both or neither: one reading of two says nothing about the pair.
      ...(facesRead ? { faceMatched: faces as boolean[] } : {}),
      expectedMinutes: f.expectedMinutes,
    },
  });
}

export interface ExitFacts {
  visitId: string;
  roomId: string;
  personIds: string[];
  dwellSeconds: number;
  packagesTouched: number;
}

export async function recordExitEvent(tx: PoolClient, f: ExitFacts): Promise<ChainEventOutcome> {
  const kind = "STRONGROOM_EXIT";
  const filing = await filingFor(tx, f.roomId);
  if (!filing) return notRecorded(kind, NO_CENTRE);
  if (f.personIds.length === 0) return notRecorded(kind, "the visit names nobody");
  return appendServiceEvent(tx, {
    kind,
    ...filing,
    payload: {
      visitId: f.visitId,
      roomId: f.roomId,
      personIds: f.personIds,
      dwellSeconds: f.dwellSeconds,
      packagesTouched: f.packagesTouched,
    },
  });
}

export async function recordDwellEvent(
  tx: PoolClient,
  f: { visitId: string; roomId: string; dwellSeconds: number; expectedMinutes: number },
): Promise<ChainEventOutcome> {
  const kind = "DWELL_EXCEEDED";
  const filing = await filingFor(tx, f.roomId);
  if (!filing) return notRecorded(kind, NO_CENTRE);
  return appendServiceEvent(tx, {
    kind,
    ...filing,
    payload: {
      visitId: f.visitId,
      roomId: f.roomId,
      dwellSeconds: Math.max(1, Math.round(f.dwellSeconds)),
      // What the entrants said the task would take, not the limit derived from it.
      expectedSeconds: f.expectedMinutes * 60,
    },
  });
}

export async function recordFootfallEvent(
  tx: PoolClient,
  f: {
    visitId: string;
    roomId: string;
    authorisedEntrants: number;
    countedAtLeast: number;
    monitorDeviceId: string;
  },
): Promise<ChainEventOutcome> {
  const kind = "FOOTFALL_MISMATCH";
  const filing = await filingFor(tx, f.roomId);
  if (!filing) return notRecorded(kind, NO_CENTRE);
  return appendServiceEvent(tx, {
    kind,
    ...filing,
    payload: {
      visitId: f.visitId,
      roomId: f.roomId,
      authorisedEntrants: f.authorisedEntrants,
      countedAtLeast: f.countedAtLeast,
      monitorId: f.monitorDeviceId,
    },
  });
}
