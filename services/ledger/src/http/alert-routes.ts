import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { accountForToken } from "../domain/accounts.js";
import { bearerToken } from "./auth-routes.js";

/**
 * ── Alerts over HTTP ─────────────────────────────────────────────────────────
 *
 *   GET  /alerts?open=true&limit=     raised alerts, newest first, with their acknowledgements
 *   GET  /alerts/summary              how many, and how many nobody has acknowledged
 *   POST /alerts/:id/ack              a signed-in operator acknowledges one, with a note
 *
 * An alert is never updated. It is raised once, with the evidence known at that
 * moment, and everything after it — who looked, what they did — is a new row in
 * led.alert_ack. The response also carries what has changed since: whether the
 * leg the alert is about has closed in the meantime. That is read live and kept
 * apart from the evidence, so the page can show both "what was known when it
 * was raised" and "what is known now" without one overwriting the other.
 */

const AckBody = z.object({
  // An acknowledgement with no note records that someone clicked, not what
  // they did about it. The note is the part an enquiry will actually read.
  note: z.string().trim().min(3, "say what was done or decided").max(1000),
});

/** Postgres: the column named in the statement does not exist. */
const UNDEFINED_COLUMN = "42703";

export function registerAlertRoutes(app: FastifyInstance, pool: Pool): void {
  app.get<{ Querystring: { open?: string; limit?: string } }>("/alerts", async (req, reply) => {
    const onlyOpen = req.query.open === "true";
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);

    const { rows } = await pool.query(
      `select a.id, a.kind, a.package_id, a.leg_id, a.device_id, a.evidence,
              a.requires_decision, a.consequence, a.raised_at,
              p.seal_serial, c.code as centre_code,
              r.leg_no, r.from_place, r.to_place, r.from_role, r.to_role, r.expected_by,
              (select min(t.recorded_at) from led.transfer_attempt t
                where t.leg_id = a.leg_id and t.outcome = 'granted'
                  and t.checks ->> 'step' = 'confirm') as leg_closed_at,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                         'id', k.id,
                         'note', k.note,
                         'ackedAt', k.acked_at,
                         'personName', pp.display_name,
                         'personRole', pp.role,
                         'accountName', ac.display_name,
                         'accountUsername', ac.username)
                       order by k.acked_at)
                  from led.alert_ack k
                  left join ref.person pp on pp.id = k.person_id
                  -- Read through to_jsonb so this query still runs on a
                  -- database where 007 has not been applied yet.
                  left join ref.account ac on ac.id = (to_jsonb(k) ->> 'account_id')::uuid
                 where k.alert_id = a.id), '[]'::jsonb) as acks
         from led.alert a
         left join ref.package p on p.id = a.package_id
         left join ref.centre c on c.id = coalesce(a.centre_id, p.centre_id)
         left join ref.route_leg r on r.id = a.leg_id
        where not $1::boolean
           or (a.requires_decision
               and not exists (select 1 from led.alert_ack k where k.alert_id = a.id))
        order by a.raised_at desc
        limit $2`,
      [onlyOpen, limit],
    );
    return reply.send({ alerts: rows });
  });

  app.get("/alerts/summary", async (_req, reply) => {
    const { rows } = await pool.query<{ total: number; unacknowledged: number }>(
      `select count(*)::int as total,
              count(*) filter (
                where a.requires_decision
                  and not exists (select 1 from led.alert_ack k where k.alert_id = a.id)
              )::int as unacknowledged
         from led.alert a`,
    );
    return reply.send(rows[0] ?? { total: 0, unacknowledged: 0 });
  });

  app.post<{ Params: { id: string } }>("/alerts/:id/ack", async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) {
      return reply.code(400).send({ error: "alert id must be a uuid" });
    }
    // The acknowledgement is only worth anything if it names who made it, so
    // this is the one alert route that will not answer an anonymous caller.
    const account = await accountForToken(pool, bearerToken(req));
    if (!account) return reply.code(401).send({ error: "Sign in to acknowledge an alert." });

    const parsed = AckBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? "invalid acknowledgement",
      });
    }

    const { rows: found } = await pool.query("select 1 from led.alert where id = $1::uuid", [
      req.params.id,
    ]);
    if (found.length === 0) return reply.code(404).send({ error: "no such alert" });

    try {
      const { rows } = await pool.query<{ id: string; acked_at: Date }>(
        `insert into led.alert_ack (alert_id, person_id, account_id, note)
         values ($1::uuid, $2::uuid, $3::uuid, $4)
         returning id, acked_at`,
        [req.params.id, account.personId, account.id, parsed.data.note],
      );
      req.log.info(
        { alertId: req.params.id, username: account.username },
        "alert acknowledged",
      );
      return reply.code(201).send({ id: rows[0]?.id, ackedAt: rows[0]?.acked_at });
    } catch (err) {
      if ((err as { code?: string }).code === UNDEFINED_COLUMN) {
        return reply.code(503).send({
          error:
            "This database cannot record who acknowledged an alert yet: apply " +
            "infra/migrations/007_alert_ack_by_account.sql as mohar_migrator.",
        });
      }
      throw err;
    }
  });
}
