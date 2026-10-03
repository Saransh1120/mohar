import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db.js";
import type { ChainEventOutcome } from "../domain/service-events.js";
import { recordEntryEvent } from "../domain/strongroom-events.js";
import {
  closeVisit,
  decideEntry,
  decideExit,
  dwellLimitSeconds,
  recordDoorAttempt,
  type EntryRequest,
  type ExitRequest,
} from "../domain/strongroom.js";

/**
 * ── The strong room door over HTTP ───────────────────────────────────────────
 *
 *   POST /rooms                     register a room (reference data)
 *   GET  /rooms                     rooms, who is inside, when the monitor last reported
 *   GET  /rooms/:roomId/visits      visits and every attempt at the door, newest first
 *   POST /rooms/:roomId/entry       two people, two fingers, within 120 s → door opens
 *   POST /rooms/:roomId/exit        the visit ends; its length and footfall are judged
 *
 * Like the hand-off routes, a refusal is a 200 with `outcome: "refused"`, and
 * every attempt is recorded before it is answered.
 */

const Uuid = z.string().uuid();

const RoomBody = z.object({
  name: z.string().trim().min(1).max(120),
  place: z.string().trim().min(1).max(200),
  centreId: Uuid.optional(),
  monitorDeviceId: Uuid.optional(),
});

const EntryBody = z.object({
  deviceId: Uuid,
  // Not capped at two: three people presenting is an attempt to record and
  // refuse, not a malformed request.
  entrants: z
    .array(
      z.object({
        personId: Uuid,
        biometricSlot: z.number().int().nonnegative().max(1000).optional(),
        biometricScore: z.number().int().nonnegative().max(1000).optional(),
        faceMatched: z.boolean().optional(),
        assertedAt: z.string().datetime(),
      }),
    )
    .max(8),
  task: z.string().trim().min(3, "say what the visit is for").max(200),
  expectedMinutes: z.number().int().positive().max(24 * 60),
  occurredAt: z.string().datetime().optional(),
});

const ExitBody = z.object({
  deviceId: Uuid,
  visitId: Uuid,
  packagesTouched: z.number().int().nonnegative().max(10_000),
  occurredAt: z.string().datetime().optional(),
});

export function registerStrongroomRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/rooms", async (req, reply) => {
    const parsed = RoomBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid room", detail: parsed.error.issues });
    }
    const b = parsed.data;
    const { rows } = await pool.query<{ id: string }>(
      `insert into ref.strong_room (name, place, centre_id, monitor_device_id)
       values ($1, $2, $3::uuid, $4::uuid) returning id`,
      [b.name, b.place, b.centreId ?? null, b.monitorDeviceId ?? null],
    );
    return reply.code(201).send({ roomId: rows[0]?.id });
  });

  app.get("/rooms", async (_req, reply) => {
    const { rows } = await pool.query(
      `select r.id, r.name, r.place, r.monitor_device_id, c.code as centre_code,
              (select max(e.occurred_at) from led.event e
                where e.actor_device = r.monitor_device_id
                  and e.kind in ('MONITOR_HEARTBEAT', 'ROOM_ENTRY')) as monitor_last_heard,
              (select count(*)::int from led.strongroom_visit v where v.room_id = r.id) as visits,
              (select count(*)::int from led.strongroom_attempt a
                where a.room_id = r.id and a.outcome = 'refused') as refused_attempts,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                         'visitId', v.id,
                         'enteredAt', v.entered_at,
                         'expectedMinutes', v.expected_minutes,
                         'persons', v.persons)
                       order by v.entered_at)
                  from led.strongroom_visit v
                 where v.room_id = r.id
                   and not exists (select 1 from led.strongroom_exit x where x.visit_id = v.id)
              ), '[]'::jsonb) as inside
         from ref.strong_room r
         left join ref.centre c on c.id = r.centre_id
        order by r.created_at desc`,
    );
    return reply.send({ rooms: rows });
  });

  app.get<{ Params: { roomId: string } }>("/rooms/:roomId/visits", async (req, reply) => {
    if (!Uuid.safeParse(req.params.roomId).success) {
      return reply.code(400).send({ error: "room id must be a uuid" });
    }
    const { rows: visits } = await pool.query(
      `select v.id, v.entered_at, v.expected_minutes, v.persons,
              x.exited_at, x.dwell_seconds, x.packages_touched, x.footfall_out,
              (select a.checks ->> 'task' from led.strongroom_attempt a
                where a.visit_id = v.id and a.kind = 'entry' limit 1) as task
         from led.strongroom_visit v
         left join led.strongroom_exit x on x.visit_id = v.id
        where v.room_id = $1::uuid
        order by v.entered_at desc
        limit 100`,
      [req.params.roomId],
    );
    const { rows: attempts } = await pool.query(
      `select a.id, a.kind, a.outcome, a.recorded_at, a.persons, a.visit_id,
              a.checks -> 'checks' as checks, a.checks ->> 'task' as task
         from led.strongroom_attempt a
        where a.room_id = $1::uuid
        order by a.recorded_at desc
        limit 100`,
      [req.params.roomId],
    );
    const now = Date.now();
    return reply.send({
      visits: visits.map((v) => ({
        ...v,
        limit_seconds: dwellLimitSeconds(v.expected_minutes),
        // Read now, for a visit that has not ended: how long they have been in.
        inside_seconds: v.exited_at
          ? null
          : Math.round((now - new Date(v.entered_at).getTime()) / 1000),
      })),
      attempts,
    });
  });

  app.post<{ Params: { roomId: string } }>("/rooms/:roomId/entry", async (req, reply) => {
    if (!Uuid.safeParse(req.params.roomId).success) {
      return reply.code(400).send({ error: "room id must be a uuid" });
    }
    const parsed = EntryBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", detail: parsed.error.issues });
    }
    const input: EntryRequest = {
      ...parsed.data,
      roomId: req.params.roomId,
      occurredAt: parsed.data.occurredAt ?? new Date().toISOString(),
    };

    const result = await withTransaction(pool, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`room:${input.roomId}`]);
      const decision = await decideEntry(tx, input);

      // The visit row first when the door opens, so the attempt can name it;
      // both are in this one transaction and neither is answered before both
      // are written.
      let visitId: string | null = null;
      let enteredAt: Date | null = null;
      let chainEvent: ChainEventOutcome | null = null;
      if (decision.outcome === "granted") {
        const { rows } = await tx.query<{ id: string; entered_at: Date }>(
          `insert into led.strongroom_visit (room_id, persons, entered_at, expected_minutes)
           values ($1::uuid, $2::jsonb, now(), $3)
           returning id, entered_at`,
          [input.roomId, JSON.stringify(input.entrants), input.expectedMinutes],
        );
        visitId = rows[0]!.id;
        enteredAt = rows[0]!.entered_at;
      }
      await recordDoorAttempt(
        tx,
        "entry",
        input.roomId,
        input.deviceId,
        input.entrants,
        { task: input.task, expectedMinutes: input.expectedMinutes },
        decision,
        visitId,
      );
      if (visitId) {
        chainEvent = await recordEntryEvent(tx, {
          visitId,
          roomId: input.roomId,
          entrants: input.entrants,
          secondsBetween: decision.context.secondsBetween,
          expectedMinutes: input.expectedMinutes,
        });
      }
      return { decision, visitId, enteredAt, chainEvent };
    });

    req.log.info(
      {
        roomId: input.roomId,
        outcome: result.decision.outcome,
        denyReasons: result.decision.denyReasons,
        chainEvent: result.chainEvent,
      },
      `strong room entry ${result.decision.outcome}`,
    );
    return reply.send({
      outcome: result.decision.outcome,
      denyReasons: result.decision.denyReasons,
      checks: result.decision.checks,
      context: result.decision.context,
      ...(result.visitId ? { visitId: result.visitId, enteredAt: result.enteredAt } : {}),
      ...(result.chainEvent ? { chainEvent: result.chainEvent } : {}),
    });
  });

  app.post<{ Params: { roomId: string } }>("/rooms/:roomId/exit", async (req, reply) => {
    if (!Uuid.safeParse(req.params.roomId).success) {
      return reply.code(400).send({ error: "room id must be a uuid" });
    }
    const parsed = ExitBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", detail: parsed.error.issues });
    }
    const input: ExitRequest = {
      ...parsed.data,
      roomId: req.params.roomId,
      occurredAt: parsed.data.occurredAt ?? new Date().toISOString(),
    };

    const result = await withTransaction(pool, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`room:${input.roomId}`]);
      const { decision, visit } = await decideExit(tx, input);
      await recordDoorAttempt(
        tx,
        "exit",
        input.roomId,
        input.deviceId,
        visit?.persons ?? [],
        { packagesTouched: input.packagesTouched },
        decision,
        // Only a visit that exists can be named; the column is a foreign key.
        visit ? visit.id : null,
      );
      const closed =
        decision.outcome === "granted" && visit ? await closeVisit(tx, visit, input) : null;
      return { decision, closed, expectedMinutes: visit?.expected_minutes ?? null };
    });

    req.log.info(
      {
        roomId: input.roomId,
        visitId: input.visitId,
        outcome: result.decision.outcome,
        chainEvents: result.closed?.chainEvents,
      },
      `strong room exit ${result.decision.outcome}`,
    );
    return reply.send({
      outcome: result.decision.outcome,
      denyReasons: result.decision.denyReasons,
      checks: result.decision.checks,
      ...(result.closed
        ? {
            dwellSeconds: result.closed.dwellSeconds,
            expectedMinutes: result.expectedMinutes,
            dwellExceeded: result.closed.dwellExceeded,
            footfall: result.closed.footfall,
            chainEvents: result.closed.chainEvents,
          }
        : {}),
    });
  });
}
