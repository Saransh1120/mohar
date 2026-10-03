import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { accountForToken } from "../domain/accounts.js";
import { withTransaction } from "../db.js";
import { appendServiceEvent } from "../domain/service-events.js";
import { recordSeamManualOverride } from "../domain/override-events.js";
import { bearerToken } from "./auth-routes.js";
import {
  APPROVALS_REQUIRED,
  overrideStanding,
  rateAgainstBaseline,
  type OverrideDecisionRow,
} from "../domain/override.js";
import { CallRooms, judgeCall, loadCallRows, recordCall } from "../domain/override-call.js";
import { registerCallRoutes } from "./call-routes.js";

/**
 * ── The damaged-label override over HTTP ─────────────────────────────────────
 *
 *   POST /legs/:legId/override       the field reports a label that will not scan
 *   GET  /overrides?status=          requests with their evidence and decisions
 *   POST /overrides/:id/decision     a signed-in operator approves or refuses
 *   GET  /overrides/stats            how often it is used, by centre, route and officer
 *
 * A request raises SEAM_DECODE_FAILED so the control room is told. Approval is
 * two decisions from two accounts, each given over a video call with the phone
 * that made the request (call-routes carries the call; an approval with no such
 * call on record is turned away); the second one raises SEAM_MANUAL_OVERRIDE,
 * which is what flags the packet for inspection at its destination. The
 * override itself is used by the hand-off routes: `overrideId` on a dispatch,
 * receive or confirm stands in for the scan on that leg.
 */

const Uuid = z.string().uuid();

const RequestBody = z.object({
  deviceId: Uuid,
  personId: Uuid.optional(),
  seamIdTyped: z.string().trim().min(1).max(64),
  serialTyped: z.string().trim().min(1).max(64).optional(),
  attemptedSeconds: z.number().int().positive().max(3600),
  whichCodes: z.enum(["A", "B", "both"]),
  photoSha256: z.string().regex(/^[0-9a-f]{64}$/, "expected the sha-256 of the photograph"),
});

const DecisionBody = z.object({
  decision: z.enum(["approved", "refused"]),
  videoConfirmed: z.boolean(),
  officersPresent: z.boolean(),
  note: z.string().trim().min(3, "say what was seen or why it was refused").max(1000),
});

const norm = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();

export interface OverrideOptions {
  /**
   * Whether an approval needs a video call on record between that operator and
   * the requesting phone. On unless OVERRIDE_CALL_REQUIRED=0, which goes back
   * to taking the operator's word and says so on every decision it records.
   */
  callRequired?: boolean;
}

export function registerOverrideRoutes(
  app: FastifyInstance,
  pool: Pool,
  options: OverrideOptions = {},
): void {
  const callRequired = options.callRequired ?? process.env["OVERRIDE_CALL_REQUIRED"] !== "0";
  registerCallRoutes(app, pool, new CallRooms());

  app.post<{ Params: { legId: string } }>("/legs/:legId/override", async (req, reply) => {
    if (!Uuid.safeParse(req.params.legId).success) {
      return reply.code(400).send({ error: "leg id must be a uuid" });
    }
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", detail: parsed.error.issues });
    }
    const b = parsed.data;

    const out = await withTransaction(pool, async (tx) => {
      const { rows: legs } = await tx.query<{
        package_id: string;
        leg_no: number;
        from_place: string;
        to_place: string;
        centre_id: string;
        exam_id: string;
        seal_serial: string | null;
        seam_id: string | null;
      }>(
        `select r.package_id, r.leg_no, r.from_place, r.to_place, p.centre_id, p.exam_id, p.seal_serial, l.seam_id
           from ref.route_leg r
           join ref.package p on p.id = r.package_id
           left join ref.seal_label l on l.package_id = p.id
          where r.id = $1::uuid`,
        [req.params.legId],
      );
      const leg = legs[0];
      if (!leg) return null;

      const { rows: known } = await tx.query<{ person_id: string | null; device_id: string | null }>(
        `select (select id from ref.person where id = $1::uuid) as person_id,
                (select id from ref.device where id = $2::uuid) as device_id`,
        [b.personId ?? null, b.deviceId],
      );
      const { rows: person } = await tx.query<{ display_name: string; role: string }>(
        "select display_name, role from ref.person where id = $1::uuid",
        [b.personId ?? null],
      );

      // What was typed against what is on record, kept as found. A typed id
      // that is not this packet's makes the request unusable, and it is still
      // recorded: somebody held a packet up with a label that names another.
      const seamIdMatches = leg.seam_id !== null && norm(b.seamIdTyped) === norm(leg.seam_id);
      const serialMatches =
        b.serialTyped && leg.seal_serial ? norm(b.serialTyped) === norm(leg.seal_serial) : null;
      const evidence = {
        legNo: leg.leg_no,
        seamIdMatches,
        labelOnRecord: leg.seam_id !== null,
        ...(serialMatches === null ? {} : { serialMatches }),
        deviceKnown: known[0]?.device_id !== null,
        personKnown: known[0]?.person_id !== null,
        attemptedSeconds: b.attemptedSeconds,
        whichCodes: b.whichCodes,
      };

      const { rows } = await tx.query<{ id: string; requested_at: Date }>(
        `insert into led.seam_override_request
           (leg_id, package_id, person_id, device_id, seam_id_typed, serial_typed,
            attempted_seconds, which_codes, photo_sha256, evidence)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10::jsonb)
         returning id, requested_at`,
        [
          req.params.legId, leg.package_id, known[0]?.person_id ?? null, known[0]?.device_id ?? null,
          b.seamIdTyped, b.serialTyped ?? null, b.attemptedSeconds, b.whichCodes, b.photoSha256,
          JSON.stringify(evidence),
        ],
      );
      const id = rows[0]!.id;

      const who = person[0] ? `${person[0].display_name} (${person[0].role.replace(/_/g, " ")})` : "An officer";
      await tx.query(
        `insert into led.alert (kind, package_id, leg_id, centre_id, device_id, evidence, requires_decision, consequence)
         values ('SEAM_DECODE_FAILED', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, true, $6)`,
        [
          leg.package_id, req.params.legId, leg.centre_id, known[0]?.device_id ?? null,
          JSON.stringify({ overrideId: id, photoSha256: b.photoSha256, seamIdTyped: b.seamIdTyped, ...evidence }),
          `${who} reports that the seam label on this packet would not scan after ` +
            `${b.attemptedSeconds} seconds, on leg ${leg.leg_no} (${leg.from_place} to ${leg.to_place}). ` +
            (seamIdMatches
              ? "The seam id typed off the label is the one on record. "
              : "The seam id typed off the label is NOT the one on record for this packet. ") +
            `The hand-off cannot proceed until ${APPROVALS_REQUIRED} control room operators have ` +
            `each seen the packet and both officers on live video and approved or refused it.`,
        ],
      );
      // What the officer reported, on the chain. The two decisions that follow
      // are operator accounts, not registered persons, and stay in
      // led.seam_override_decision: the event contract names an approver by
      // person id, which an account does not have.
      const chainEvent = await appendServiceEvent(tx, {
        kind: "SEAM_DECODE_FAILED",
        examId: leg.exam_id,
        centreId: leg.centre_id,
        packageId: leg.package_id,
        actorPersonId: known[0]?.person_id,
        payload: {
          seamIdTyped: b.seamIdTyped,
          packageId: leg.package_id,
          attemptedSeconds: b.attemptedSeconds,
          whichCodes: b.whichCodes,
          photoSha256: b.photoSha256,
        },
      });
      return { id, requestedAt: rows[0]!.requested_at, evidence, chainEvent };
    });

    if (!out) return reply.code(404).send({ error: "no such leg" });
    req.log.info(
      { legId: req.params.legId, overrideId: out.id, chainEvent: out.chainEvent },
      "seam override requested",
    );
    return reply.code(201).send({
      overrideId: out.id,
      requestedAt: out.requestedAt,
      chainEvent: out.chainEvent,
      evidence: out.evidence,
      standing: overrideStanding(out.evidence.seamIdMatches, []),
    });
  });

  app.get<{ Querystring: { status?: string } }>("/overrides", async (req, reply) => {
    const { rows } = await pool.query(
      `select q.id, q.leg_id, q.package_id, q.seam_id_typed, q.serial_typed, q.attempted_seconds,
              q.which_codes, q.photo_sha256, q.evidence, q.requested_at,
              r.leg_no, r.from_place, r.to_place, p.seal_serial, c.code as centre_code,
              pe.display_name as person_name, pe.role as person_role,
              exists (select 1 from led.transfer_attempt t
                       where t.leg_id = q.leg_id and t.outcome = 'granted'
                         and t.checks -> 'context' ->> 'overrideId' = q.id::text) as used,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                         'accountId', d.account_id,
                         'accountName', a.display_name,
                         'accountUsername', a.username,
                         'decision', d.decision,
                         'videoConfirmed', d.video_confirmed,
                         'officersPresent', d.officers_present,
                         'callEvidence', to_jsonb(d) -> 'call_evidence',
                         'note', d.note,
                         'decidedAt', d.decided_at)
                       order by d.decided_at)
                  from led.seam_override_decision d
                  join ref.account a on a.id = d.account_id
                 where d.request_id = q.id), '[]'::jsonb) as decisions
         from led.seam_override_request q
         join ref.route_leg r on r.id = q.leg_id
         join ref.package p on p.id = q.package_id
         join ref.centre c on c.id = p.centre_id
         left join ref.person pe on pe.id = q.person_id
        order by q.requested_at desc
        limit 200`,
    );
    const overrides = rows.map((r) => ({
      ...r,
      standing: overrideStanding(
        r.evidence?.seamIdMatches === true,
        r.decisions as OverrideDecisionRow[],
      ),
    }));
    const wanted = req.query.status;
    return reply.send({
      overrides: wanted ? overrides.filter((o) => o.standing.status === wanted) : overrides,
    });
  });

  app.post<{ Params: { id: string } }>("/overrides/:id/decision", async (req, reply) => {
    if (!Uuid.safeParse(req.params.id).success) {
      return reply.code(400).send({ error: "override id must be a uuid" });
    }
    // A decision is only worth anything if it names who made it.
    const account = await accountForToken(pool, bearerToken(req));
    if (!account) return reply.code(401).send({ error: "Sign in to decide an override." });

    const parsed = DecisionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid decision" });
    }
    const b = parsed.data;
    if (b.decision === "approved" && !(b.videoConfirmed && b.officersPresent)) {
      return reply.code(400).send({
        error:
          "An approval states that the packet was seen on live video with both officers " +
          "present. Without both, refuse it or leave it pending.",
      });
    }

    const decide = () => withTransaction(pool, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`override:${req.params.id}`]);
      const { rows: reqs } = await tx.query<{
        leg_id: string;
        package_id: string;
        evidence: { seamIdMatches?: boolean; legNo?: number };
        photo_sha256: string;
        centre_id: string;
        exam_id: string;
        person_id: string | null;
        seam_id_typed: string;
      }>(
        `select q.leg_id, q.package_id, q.evidence, q.photo_sha256,
                q.person_id, q.seam_id_typed, p.centre_id, p.exam_id
           from led.seam_override_request q join ref.package p on p.id = q.package_id
          where q.id = $1::uuid`,
        [req.params.id],
      );
      const request = reqs[0];
      if (!request) return { code: 404 as const, body: { error: "no such override request" } };

      const load = async () =>
        (
          await tx.query<{
            account_id: string;
            decision: "approved" | "refused";
            video_confirmed: boolean;
            officers_present: boolean;
            display_name: string;
            note: string;
            call_evidence: { onRecord?: boolean } | null;
          }>(
            `select d.account_id, d.decision, d.video_confirmed, d.officers_present,
                    d.note, a.display_name, d.call_evidence
               from led.seam_override_decision d join ref.account a on a.id = d.account_id
              where d.request_id = $1::uuid order by d.decided_at`,
            [req.params.id],
          )
        ).rows;
      const standingOf = (rows: Awaited<ReturnType<typeof load>>) =>
        overrideStanding(
          request.evidence.seamIdMatches === true,
          rows.map((d) => ({
            accountId: d.account_id,
            decision: d.decision,
            videoConfirmed: d.video_confirmed,
            officersPresent: d.officers_present,
          })),
        );

      const before = await load();
      if (before.some((d) => d.account_id === account.id)) {
        return {
          code: 409 as const,
          body: {
            error:
              "This account has already decided this request. The second decision has to " +
              "come from a second operator.",
          },
        };
      }
      const was = standingOf(before);
      if (was.status !== "pending") {
        return {
          code: 409 as const,
          body: { error: `This request is already ${was.status}: ${was.detail}.` },
        };
      }

      // The operator states what they saw. Whether there was a call for them
      // to see it on is something the ledger has its own record of.
      const call = judgeCall(await loadCallRows(tx, req.params.id), account.id, new Date());
      const callEvidence = { required: callRequired, onRecord: call.onRecord, checks: call.checks };
      if (b.decision === "approved" && callRequired && !call.onRecord) {
        await recordCall(tx, {
          requestId: req.params.id, party: "operator", accountId: account.id, deviceId: null,
          event: "approval_refused", detail: { checks: call.checks },
        });
        return {
          code: 409 as const,
          body: {
            error:
              "An approval is given over a video call with the phone that made this request, " +
              "and there is no such call on record for this account. Open the call, see the " +
              "packet and both officers, then decide. A refusal needs no call.",
            call: callEvidence,
          },
        };
      }

      await tx.query(
        `insert into led.seam_override_decision
           (request_id, account_id, decision, video_confirmed, officers_present, note, call_evidence)
         values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)`,
        [
          req.params.id, account.id, b.decision, b.videoConfirmed, b.officersPresent, b.note,
          JSON.stringify(callEvidence),
        ],
      );
      const after = await load();
      const now = standingOf(after);

      // The second approval is the moment the override exists, and the moment
      // the packet becomes one that has to be inspected where it arrives.
      let chainEvent = null;
      if (now.status === "approved") {
        const approvers = after.filter((d) => d.decision === "approved").map((d) => d.display_name);
        await tx.query(
          `insert into led.alert (kind, package_id, leg_id, centre_id, evidence, requires_decision, consequence)
           values ('SEAM_MANUAL_OVERRIDE', $1::uuid, $2::uuid, $3::uuid, $4::jsonb, true, $5)`,
          [
            request.package_id, request.leg_id, request.centre_id,
            JSON.stringify({
              overrideId: req.params.id,
              legNo: request.evidence.legNo,
              photoSha256: request.photo_sha256,
              approvers,
            }),
            `${approvers.join(" and ")} approved a hand-off of this packet without a scan of its ` +
              `seam label, which would not read. The seal on this packet has not been checked by ` +
              `the system on this leg. It is to be inspected by hand where it arrives, and what ` +
              `the inspection finds is recorded here.`,
          ],
        );
        chainEvent = await recordSeamManualOverride(tx, {
          packageId: request.package_id,
          centreId: request.centre_id,
          examId: request.exam_id,
          personId: request.person_id,
          seamIdTyped: request.seam_id_typed,
          photoSha256: request.photo_sha256,
        }, after.filter((d) => d.decision === "approved").map((d) => ({
          accountId: d.account_id, note: d.note, callOnRecord: d.call_evidence?.onRecord === true,
        })));
      }
      return { code: 201 as const, body: { standing: now, call: callEvidence,
        ...(chainEvent ? { chainEvent } : {}) } };
    });

    let out: Awaited<ReturnType<typeof decide>>;
    try {
      out = await decide();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "42P01" || code === "42703") {
        return reply.code(503).send({ error: "migration 015 has not been applied to this database" });
      }
      throw err;
    }

    if (out.code === 201) {
      req.log.info(
        { overrideId: req.params.id, username: account.username, decision: b.decision },
        "seam override decided",
      );
    }
    return reply.code(out.code).send(out.body);
  });

  app.get("/overrides/stats", async (_req, reply) => {
    // An override counts once it was approved by two operators, whether or not
    // the hand-off then went through: the label failed either way.
    const approved = `
      select q.id, q.leg_id, q.package_id, q.person_id
        from led.seam_override_request q
       where (q.evidence ->> 'seamIdMatches')::boolean
         and not exists (select 1 from led.seam_override_decision d
                          where d.request_id = q.id and d.decision = 'refused')
         and (select count(distinct d.account_id) from led.seam_override_decision d
               where d.request_id = q.id and d.decision = 'approved'
                 and d.video_confirmed and d.officers_present) >= ${APPROVALS_REQUIRED}`;

    const { rows: total } = await pool.query<{ legs: number; overrides: number }>(
      `select (select count(*)::int from ref.route_leg) as legs,
              (select count(distinct leg_id)::int from (${approved}) a) as overrides`,
    );
    const { rows: byCentre } = await pool.query<{ key: string; label: string; legs: number; overrides: number }>(
      `select c.id as key, c.code as label, count(distinct r.id)::int as legs,
              count(distinct a.leg_id)::int as overrides
         from ref.route_leg r
         join ref.package p on p.id = r.package_id
         join ref.centre c on c.id = p.centre_id
         left join (${approved}) a on a.leg_id = r.id
        group by c.id, c.code`,
    );
    const { rows: byRoute } = await pool.query<{ key: string; label: string; legs: number; overrides: number }>(
      `select r.from_place || ' → ' || r.to_place as key, r.from_place || ' → ' || r.to_place as label,
              count(distinct r.id)::int as legs, count(distinct a.leg_id)::int as overrides
         from ref.route_leg r
         left join (${approved}) a on a.leg_id = r.id
        group by r.from_place, r.to_place`,
    );
    // An officer's legs are the ones they were verified on, at any step.
    const { rows: byOfficer } = await pool.query<{ key: string; label: string; legs: number; overrides: number }>(
      `select pe.id as key, pe.display_name || ' (' || replace(pe.role, '_', ' ') || ')' as label,
              count(distinct t.leg_id)::int as legs,
              (select count(distinct a.leg_id)::int from (${approved}) a where a.person_id = pe.id) as overrides
         from ref.person pe
         join led.transfer_attempt t on t.person_id = pe.id
        group by pe.id, pe.display_name, pe.role`,
    );
    const baseline = total[0] ?? { legs: 0, overrides: 0 };
    return reply.send({
      baseline: {
        ...baseline,
        per100: baseline.legs > 0 ? Math.round((baseline.overrides / baseline.legs) * 1000) / 10 : 0,
      },
      byCentre: rateAgainstBaseline(byCentre, baseline),
      byRoute: rateAgainstBaseline(byRoute, baseline),
      byOfficer: rateAgainstBaseline(byOfficer, baseline),
    });
  });
}
