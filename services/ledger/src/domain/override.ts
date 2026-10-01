import type { PoolClient } from "pg";

/**
 * ── The label that will not scan ─────────────────────────────────────────────
 *
 * A seam label gets rained on, scuffed in a truck, half peeled by a strap. The
 * hand-off engine refuses a packet whose label it cannot check, and it should:
 * a label that does not read is also exactly what a swapped label looks like.
 * So there has to be a way through that is slower, witnessed and recorded,
 * rather than a way around.
 *
 * This is that way. The officer photographs the label and types the seam id
 * printed on it. Two control room operators, separately signed in, each state
 * that they saw the packet and both officers on live video and approve. Only
 * then does the hand-off engine accept the override in place of a scan, for
 * that one leg, and the packet is flagged for inspection where it arrives.
 *
 * It is a recorded override and not a bypass. Every other check on the leg
 * still runs. And how often it is used is itself a measurement: a centre, a
 * route or an officer whose labels fail far more often than everyone else's is
 * a finding.
 */

/** Two operators, not one. An approval by a single account approves nothing. */
export const APPROVALS_REQUIRED = 2;

export type OverrideStatus = "pending" | "approved" | "refused" | "unusable";

export interface OverrideDecisionRow {
  accountId: string;
  decision: "approved" | "refused";
  videoConfirmed: boolean;
  officersPresent: boolean;
}

export interface OverrideStanding {
  status: OverrideStatus;
  approvals: number;
  /** In words, for the record and for the page. */
  detail: string;
}

/**
 * Where a request stands, from its decisions. Pure, so the two-person rule can
 * be tested without a database.
 *
 * A request whose typed seam id is not the one on record for the packet can
 * never be used, whoever approves it: the override stands in for a scan of
 * this packet's label, and a different label's id is a different packet.
 */
export function overrideStanding(
  seamIdMatches: boolean,
  decisions: readonly OverrideDecisionRow[],
): OverrideStanding {
  const approvals = new Set(
    decisions
      .filter((d) => d.decision === "approved" && d.videoConfirmed && d.officersPresent)
      .map((d) => d.accountId),
  ).size;

  if (!seamIdMatches) {
    return {
      status: "unusable",
      approvals,
      detail: "the seam id typed is not the one recorded for this packet at sealing",
    };
  }
  if (decisions.some((d) => d.decision === "refused")) {
    return { status: "refused", approvals, detail: "a control room operator refused it" };
  }
  if (approvals >= APPROVALS_REQUIRED) {
    return {
      status: "approved",
      approvals,
      detail: `${approvals} control room operators approved it over live video`,
    };
  }
  return {
    status: "pending",
    approvals,
    detail: `${approvals} of ${APPROVALS_REQUIRED} operators have approved`,
  };
}

interface RequestRow {
  id: string;
  leg_id: string;
  evidence: { seamIdMatches?: boolean };
  requested_at: Date;
}

export interface LoadedOverride {
  id: string;
  legId: string;
  requestedAt: Date;
  standing: OverrideStanding;
  approvers: string[];
}

/** One override request and where it stands, or undefined if there is none. */
export async function loadOverride(
  tx: PoolClient,
  overrideId: string,
): Promise<LoadedOverride | undefined> {
  const { rows } = await tx.query<RequestRow>(
    `select id, leg_id, evidence, requested_at
       from led.seam_override_request where id = $1::uuid`,
    [overrideId],
  );
  const r = rows[0];
  if (!r) return undefined;
  const { rows: decisions } = await tx.query<{
    account_id: string;
    decision: "approved" | "refused";
    video_confirmed: boolean;
    officers_present: boolean;
    display_name: string;
  }>(
    `select d.account_id, d.decision, d.video_confirmed, d.officers_present, a.display_name
       from led.seam_override_decision d
       join ref.account a on a.id = d.account_id
      where d.request_id = $1::uuid
      order by d.decided_at`,
    [overrideId],
  );
  return {
    id: r.id,
    legId: r.leg_id,
    requestedAt: r.requested_at,
    standing: overrideStanding(
      r.evidence.seamIdMatches === true,
      decisions.map((d) => ({
        accountId: d.account_id,
        decision: d.decision,
        videoConfirmed: d.video_confirmed,
        officersPresent: d.officers_present,
      })),
    ),
    approvers: decisions.filter((d) => d.decision === "approved").map((d) => d.display_name),
  };
}

export interface OverrideRate {
  key: string;
  label: string;
  legs: number;
  overrides: number;
  /** Approved overrides per hundred legs. */
  per100: number;
  /** How many times the rate across everything this one is. Null when that is zero. */
  timesBaseline: number | null;
}

/** Rates against the baseline. Pure; the SQL only counts. */
export function rateAgainstBaseline(
  rows: readonly { key: string; label: string; legs: number; overrides: number }[],
  baseline: { legs: number; overrides: number },
): OverrideRate[] {
  const base = baseline.legs > 0 ? baseline.overrides / baseline.legs : 0;
  return rows
    .filter((r) => r.legs > 0)
    .map((r) => {
      const rate = r.overrides / r.legs;
      return {
        ...r,
        per100: Math.round(rate * 1000) / 10,
        timesBaseline: base > 0 ? Math.round((rate / base) * 10) / 10 : null,
      };
    })
    .sort((a, b) => b.per100 - a.per100 || b.overrides - a.overrides);
}
