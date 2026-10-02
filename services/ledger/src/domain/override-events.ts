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
}

/** The two recorded operators, rather than an invented approver person. */
export async function recordSeamManualOverride(
  tx: PoolClient,
  request: ApprovedRequest,
  approvals: Approval[],
  callRequired: boolean,
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
      approvalChannel: callRequired ? "live-video" : "operator-attestation",
      fieldPersonIds: [request.personId],
      photoSha256: request.photoSha256,
      justification: approvals.map((approval) => approval.note).join("; "),
    },
  });
}
