import type { PoolClient } from "pg";
import { appendServiceEvent, notRecorded, type ChainEventOutcome } from "./service-events.js";

interface ApprovedRequest {
  packageId: string;
  centreId: string;
  examId: string;
  personId: string | null;
  seamIdTyped: string;
  photoSha256: string;
}

interface Approval {
  accountId: string;
  note: string;
  /** What the ledger had on record about this operator's call when they approved. */
  callOnRecord: boolean;
}

/**
 * How the override was approved, read from what each approval was made on and
 * not from how the ledger is configured at the moment the second one lands:
 * `live-video` only when every approval had a call on record, and
 * `operator-attestation` when any rested on the operator's statement alone.
 */
export function approvalChannelOf(
  approvals: readonly { callOnRecord: boolean }[],
): "live-video" | "operator-attestation" {
  return approvals.length > 0 && approvals.every((a) => a.callOnRecord)
    ? "live-video"
    : "operator-attestation";
}

/** The two recorded operators, rather than an invented approver person. */
export async function recordSeamManualOverride(
  tx: PoolClient,
  request: ApprovedRequest,
  approvals: Approval[],
): Promise<ChainEventOutcome> {
  const kind = "SEAM_MANUAL_OVERRIDE";
  if (!request.personId) return notRecorded(kind, "the request did not name a registered field person");
  if (approvals.length !== 2 || approvals[0]?.accountId === approvals[1]?.accountId) {
    return notRecorded(kind, "the approval did not name two distinct operator accounts");
  }
  return appendServiceEvent(tx, {
    kind,
    examId: request.examId,
    packageId: request.packageId,
    centreId: request.centreId,
    actorPersonId: request.personId,
    payload: {
      packageId: request.packageId,
      seamIdTyped: request.seamIdTyped,
      approverAccountIds: [approvals[0]!.accountId, approvals[1]!.accountId],
      approvalChannel: approvalChannelOf(approvals),
      fieldPersonIds: [request.personId],
      photoSha256: request.photoSha256,
      justification: approvals.map((approval) => approval.note).join("; "),
    },
  });
}
