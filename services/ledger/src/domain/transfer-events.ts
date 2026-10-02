import type { PoolClient } from "pg";
import { PackageState, PersonRole } from "@mohar/contracts";
import {
  appendServiceEvent,
  checkLines,
  notRecorded,
  type ChainEventOutcome,
} from "./service-events.js";
import type { TransferDecision, TransferRequest } from "./transfer.js";

/**
 * ── A hand-off step, as a signed event ───────────────────────────────────────
 *
 *   dispatch granted  → HANDOVER_INITIATED
 *   confirm granted   → HANDOVER_COMPLETED
 *   any step refused  → HANDOVER_REFUSED
 *
 * A granted receive has no event of its own: it issues the key, and the leg is
 * not closed until that key comes back at confirm.
 *
 * Everything in the payload is read back from what the engine recorded or from
 * the reference tables. Where a required field has no honest value (a packet
 * with no label has no seam id), the event is not written and the reason is
 * returned; led.transfer_attempt already holds the attempt either way.
 */

interface Facts {
  leg_no: number;
  from_role: string;
  to_role: string;
  expected_by: Date;
  package_id: string;
  exam_id: string;
  centre_id: string;
  seal_serial: string | null;
  state: string;
  seam_id: string | null;
  dispatched_by: string | null;
  person_known: string | null;
}

export async function recordHandoverEvent(
  tx: PoolClient,
  req: TransferRequest,
  decision: TransferDecision,
): Promise<ChainEventOutcome | null> {
  const kind =
    decision.outcome === "refused"
      ? "HANDOVER_REFUSED"
      : req.step === "dispatch"
        ? "HANDOVER_INITIATED"
        : req.step === "confirm"
          ? "HANDOVER_COMPLETED"
          : null;
  if (!kind) return null;

  const { rows } = await tx.query<Facts>(
    `select r.leg_no, r.from_role, r.to_role, r.expected_by,
            p.id as package_id, p.exam_id, p.centre_id, p.seal_serial, p.state,
            l.seam_id,
            (select a.person_id from led.transfer_attempt a
              where a.leg_id = r.id and a.outcome = 'granted'
                and a.checks ->> 'step' = 'dispatch'
              order by a.recorded_at limit 1) as dispatched_by,
            (select id from ref.person where id = $2::uuid) as person_known
       from ref.route_leg r
       join ref.package p on p.id = r.package_id
       left join ref.seal_label l on l.package_id = p.id
      where r.id = $1::uuid`,
    [req.legId, req.personId ?? null],
  );
  const f = rows[0];
  if (!f) return notRecorded(kind, "the leg is not planned, so there is no exam to file the event under");

  const envelope = {
    examId: f.exam_id,
    packageId: f.package_id,
    centreId: f.centre_id,
    actorPersonId: f.person_known,
  };

  if (kind === "HANDOVER_REFUSED") {
    if (decision.denyReasons.length === 0) {
      return notRecorded(kind, "the refusal carries no deny reason");
    }
    return appendServiceEvent(tx, {
      kind,
      ...envelope,
      payload: {
        legId: req.legId,
        legNo: f.leg_no,
        ...(req.personId ? { attemptedByPersonId: req.personId } : {}),
        ...(req.seamIdRead ? { seamId: req.seamIdRead } : {}),
        ...(req.packetSerialTyped ? { packetSerialTyped: req.packetSerialTyped.slice(0, 280) } : {}),
        denyReasons: decision.denyReasons,
        evidence: [`step: ${req.step}`, ...checkLines(decision.checks)],
        attemptNo: decision.attemptNo,
      },
    });
  }

  const fromRole = PersonRole.safeParse(f.from_role);
  const toRole = PersonRole.safeParse(f.to_role);
  if (!fromRole.success || !toRole.success) {
    return notRecorded(kind, `leg roles ${f.from_role} to ${f.to_role} are not roles an event can name`);
  }
  if (!f.seam_id) return notRecorded(kind, "this packet has no seam label on record");
  // A granted step always carried a named person and a fingerprint; the engine
  // refuses without them. Checked rather than assumed.
  if (!req.personId || req.biometricSlot === undefined || req.biometricScore === undefined) {
    return notRecorded(kind, "the granted step carried no person or no fingerprint reading");
  }

  if (kind === "HANDOVER_INITIATED") {
    return appendServiceEvent(tx, {
      kind,
      ...envelope,
      payload: {
        legId: req.legId,
        legNo: f.leg_no,
        fromPersonId: req.personId,
        fromRole: fromRole.data,
        toRole: toRole.data,
        seamId: f.seam_id,
        biometricSlot: req.biometricSlot,
        biometricScore: req.biometricScore,
        expectedBy: f.expected_by.toISOString(),
      },
    });
  }

  if (!f.dispatched_by) return notRecorded(kind, "no granted dispatch names who handed the packet over");
  if (!f.seal_serial) return notRecorded(kind, "no serial is registered for this packet");
  // Read after the route moved the packet, so this is the state it is now in.
  const toState = PackageState.safeParse(f.state);
  if (!toState.success) return notRecorded(kind, `package state ${f.state} is not one an event can name`);

  return appendServiceEvent(tx, {
    kind,
    ...envelope,
    payload: {
      legId: req.legId,
      legNo: f.leg_no,
      fromPersonId: f.dispatched_by,
      toPersonId: req.personId,
      fromRole: fromRole.data,
      toRole: toRole.data,
      seamId: f.seam_id,
      packetSerial: f.seal_serial,
      biometricSlot: req.biometricSlot,
      biometricScore: req.biometricScore,
      toState: toState.data,
      lateBySeconds: decision.context.lateBySeconds ?? 0,
    },
  });
}
