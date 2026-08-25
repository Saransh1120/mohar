import { canTransition, type EventBody, type PackageState, type PersonRole } from "@mohar/contracts";

/**
 * ── Custody as a projection, not a column ────────────────────────────────────
 *
 * `ref.package.state` records what was *planned*. The truth about where a
 * package actually is comes from replaying its events, and the two are allowed
 * to disagree — that disagreement is precisely the signal an investigation
 * wants. See docs/04: "never reconcile by editing the ledger to match the plan."
 *
 * So nothing here writes. Given a package's events in sequence order, this
 * module answers: who holds it, what state is it in, and what is wrong with the
 * chain of custody so far.
 */

export type CustodyAnomaly =
  | { code: "illegal_transition"; seq: string; from: PackageState; to: PackageState }
  | { code: "handoff_holder_mismatch"; seq: string; expectedHolder: string; claimedFrom: string }
  | { code: "seal_serial_changed"; seq: string; registered: string; read: string }
  | { code: "custody_gap"; fromSeq: string; toSeq: string; gapMinutes: number }
  | { code: "printed_without_grant"; seq: string }
  | { code: "opened_before_window"; seq: string; windowOpensAt: string }
  | { code: "key_not_destroyed"; lastPrintSeq: string };

export interface CustodyHop {
  seq: string;
  at: string;
  kind: string;
  fromPersonId?: string;
  toPersonId?: string;
  fromRole?: PersonRole;
  toRole?: PersonRole;
  state: PackageState;
}

export interface CustodyProjection {
  state: PackageState;
  /** Person currently accountable, or undefined before the first handoff. */
  holderPersonId?: string;
  holderRole?: PersonRole;
  sealSerial?: string;
  hops: CustodyHop[];
  anomalies: CustodyAnomaly[];
  /** Set once a grant has been issued; printing before this is an anomaly. */
  accessGranted: boolean;
  printed: boolean;
  keyDestroyed: boolean;
  lastEventAt?: string;
}

export interface ProjectionInput {
  seq: string;
  body: EventBody;
  occurredAt: string;
}

/**
 * A gap longer than this between two custody events, while a package is in
 * transit, is unexplained handling time — the window in which a package can be
 * photographed with nothing recorded. Six hours is deliberately generous: real
 * road transport between districts is slow, and we want the flag to mean
 * something when it fires.
 */
const CUSTODY_GAP_MINUTES = 6 * 60;

export function projectCustody(
  events: readonly ProjectionInput[],
  opts: { registeredSealSerial?: string; windowOpensAt?: string } = {},
): CustodyProjection {
  let state: PackageState = "sealed";
  let holderPersonId: string | undefined;
  let holderRole: PersonRole | undefined;
  let sealSerial = opts.registeredSealSerial;
  let accessGranted = false;
  let printed = false;
  let keyDestroyed = false;
  let lastPrintSeq: string | undefined;

  const hops: CustodyHop[] = [];
  const anomalies: CustodyAnomaly[] = [];

  // Only movement events count toward a custody gap. A room-monitor heartbeat
  // proves the monitor is alive, not that anyone is accountable for the package.
  let lastMovement: { seq: string; at: string } | undefined;

  for (const ev of events) {
    const { body, seq } = ev;

    switch (body.kind) {
      case "SEAL_APPLIED": {
        sealSerial = body.payload.sealSerial;
        break;
      }

      case "HANDOFF": {
        const p = body.payload;

        // The outgoing party must be whoever we last recorded as holding it.
        // A handoff "from" someone who never had it means either a missed hop
        // or a fabricated one; both are worth surfacing.
        if (holderPersonId && p.fromPersonId !== holderPersonId) {
          anomalies.push({
            code: "handoff_holder_mismatch",
            seq,
            expectedHolder: holderPersonId,
            claimedFrom: p.fromPersonId,
          });
        }

        if (sealSerial && p.sealSerial !== sealSerial) {
          anomalies.push({
            code: "seal_serial_changed",
            seq,
            registered: sealSerial,
            read: p.sealSerial,
          });
        }

        if (!canTransition(state, p.toState)) {
          anomalies.push({ code: "illegal_transition", seq, from: state, to: p.toState });
        }

        // Only unexplained time *in transit* counts. `state` here is still the
        // pre-transition state — the one the package sat in during the gap —
        // and a package resting in a custodian's strongroom for a day is the
        // system working, not a finding. Flagging that too would bury the one
        // case that matters under noise from every normal overnight hold.
        if (lastMovement && state === "in_transit") {
          const gapMs = Date.parse(ev.occurredAt) - Date.parse(lastMovement.at);
          const gapMinutes = Math.round(gapMs / 60_000);
          if (gapMinutes > CUSTODY_GAP_MINUTES) {
            anomalies.push({
              code: "custody_gap",
              fromSeq: lastMovement.seq,
              toSeq: seq,
              gapMinutes,
            });
          }
        }

        state = p.toState;
        holderPersonId = p.toPersonId;
        holderRole = p.toRole;
        lastMovement = { seq, at: ev.occurredAt };

        hops.push({
          seq,
          at: ev.occurredAt,
          kind: body.kind,
          fromPersonId: p.fromPersonId,
          toPersonId: p.toPersonId,
          fromRole: p.fromRole,
          toRole: p.toRole,
          state,
        });
        break;
      }

      case "SEAL_MISMATCH": {
        // Presumed compromised. docs/07 is unambiguous: stop, do not print.
        anomalies.push({
          code: "seal_serial_changed",
          seq,
          registered: sealSerial ?? body.payload.expectedSerial,
          read: body.payload.observedSerial,
        });
        state = "compromised";
        hops.push({ seq, at: ev.occurredAt, kind: body.kind, state });
        break;
      }

      case "OVERRIDE_USED": {
        state = "compromised";
        hops.push({ seq, at: ev.occurredAt, kind: body.kind, state });
        break;
      }

      case "ACCESS_GRANTED": {
        accessGranted = true;
        break;
      }

      case "PRINT_STARTED": {
        // Printing is the moment plaintext exists. Reaching it without a
        // recorded grant means the policy engine was bypassed, not merely
        // overruled — an override at least leaves its own event.
        if (!accessGranted) anomalies.push({ code: "printed_without_grant", seq });
        if (opts.windowOpensAt && Date.parse(ev.occurredAt) < Date.parse(opts.windowOpensAt)) {
          anomalies.push({
            code: "opened_before_window",
            seq,
            windowOpensAt: opts.windowOpensAt,
          });
        }
        if (canTransition(state, "opened")) state = "opened";
        printed = true;
        lastPrintSeq = seq;
        hops.push({ seq, at: ev.occurredAt, kind: body.kind, state });
        break;
      }

      case "PRINT_COMPLETED": {
        printed = true;
        lastPrintSeq = seq;
        break;
      }

      case "KEY_DESTROYED": {
        keyDestroyed = true;
        break;
      }

      default:
        break;
    }
  }

  // A print that never produced a zeroisation record leaves a content key
  // unaccounted for. That is an open exposure, not a paperwork slip.
  if (printed && !keyDestroyed && lastPrintSeq) {
    anomalies.push({ code: "key_not_destroyed", lastPrintSeq });
  }

  const last = events[events.length - 1];

  return {
    state,
    ...(holderPersonId ? { holderPersonId } : {}),
    ...(holderRole ? { holderRole } : {}),
    ...(sealSerial ? { sealSerial } : {}),
    hops,
    anomalies,
    accessGranted,
    printed,
    keyDestroyed,
    ...(last ? { lastEventAt: last.occurredAt } : {}),
  };
}

/**
 * A single 0-100 risk score per package, so the control room can rank a few
 * hundred packages by where attention is worth spending. Weighted by what a
 * finding actually implies, not by how many findings there are.
 */
export function custodyRiskScore(p: CustodyProjection): number {
  let score = 0;
  for (const a of p.anomalies) {
    switch (a.code) {
      case "illegal_transition": score += 25; break;
      case "handoff_holder_mismatch": score += 30; break;
      case "seal_serial_changed": score += 60; break;
      case "custody_gap": score += Math.min(30, Math.round(a.gapMinutes / 60) * 5); break;
      case "printed_without_grant": score += 50; break;
      case "opened_before_window": score += 70; break;
      case "key_not_destroyed": score += 20; break;
    }
  }
  if (p.state === "compromised") score += 40;
  return Math.min(100, score);
}
