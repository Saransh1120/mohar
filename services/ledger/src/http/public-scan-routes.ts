import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db.js";
import { appendServiceEvent } from "../domain/service-events.js";

const Scan = z.object({
  seamId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{20,32}$/),
  whichCodes: z.enum(["A", "B", "both"]),
}).strict();

/**
 * How long every answer takes, at least.
 *
 * A label that exists costs a chain append and an alert; one that does not
 * costs a single lookup. Answered as fast as each allows, the difference would
 * tell a stranger which handles are real, which is the thing the identical
 * response is there to hide. So both are held to the same floor. The record is
 * still written before the answer.
 *
 * It is a floor, not a guarantee: a write that takes longer than this, on a
 * slow database or a busy chain, still shows. PUBLIC_SCAN_FLOOR_MS sets it.
 */
const DEFAULT_FLOOR_MS = 1200;

export function registerPublicScanRoutes(
  app: FastifyInstance,
  pool: Pool,
  options: { floorMs?: number } = {},
): void {
  const fromEnv = Number(process.env["PUBLIC_SCAN_FLOOR_MS"]);
  const floorMs =
    options.floorMs ?? (Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_FLOOR_MS);
  const held = async (startedAt: number): Promise<void> => {
    const left = floorMs - (Date.now() - startedAt);
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
  };

  app.post("/public/seam-scan", async (req, reply) => {
    const startedAt = Date.now();
    const parsed = Scan.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid scan" });

    // Unknown handles get the same answer. Revealing whether a guessed handle
    // exists would turn the public endpoint into an inventory oracle.
    const { rows } = await pool.query<{
      package_id: string; exam_id: string; centre_id: string;
    }>(
      `select p.id as package_id, p.exam_id, p.centre_id
         from ref.seal_label l join ref.package p on p.id = l.package_id
        where l.seam_id = $1`,
      [parsed.data.seamId],
    );
    const packet = rows[0];
    if (!packet) {
      await held(startedAt);
      return reply.code(202).send({ status: "received" });
    }

    const userAgent = req.headers["user-agent"]?.slice(0, 280);
    await withTransaction(pool, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [parsed.data.seamId]);
      const { rows: hits } = await tx.query<{ count: string }>(
        `select count(*)::text as count from led.event
          where kind = 'UNAUTHORIZED_SCAN' and body->'payload'->>'seamId' = $1`,
        [parsed.data.seamId],
      );
      const payload = {
        seamId: parsed.data.seamId,
        whichCodes: parsed.data.whichCodes,
        priorHitsOnThisSeam: Number(hits[0]?.count ?? 0),
        ...(userAgent ? { userAgent } : {}),
      };
      const outcome = await appendServiceEvent(tx, {
        examId: packet.exam_id,
        packageId: packet.package_id,
        centreId: packet.centre_id,
        kind: "UNAUTHORIZED_SCAN",
        payload,
      });
      if (!outcome.recorded) {
        throw new Error(`public scan could not be recorded: ${outcome.reason}`);
      }
      const { rows: events } = await tx.query<{ actor_device: string }>(
        "select actor_device from led.event where id = $1::uuid", [outcome.eventId],
      );
      if (!events[0]) throw new Error("recorded public scan has no chain event row");
      await tx.query(
        `insert into led.alert
           (kind, package_id, centre_id, device_id, evidence, requires_decision, consequence)
         values ('UNAUTHORIZED_SCAN', $1::uuid, $2::uuid, $3::uuid, $4::jsonb, true, $5)`,
        [packet.package_id, packet.centre_id, events[0].actor_device,
          JSON.stringify({ eventId: outcome.eventId, seamId: parsed.data.seamId,
            whichCodes: parsed.data.whichCodes, priorHitsOnThisSeam: payload.priorHitsOnThisSeam }),
          "Check custody and inspect this seam label; a public browser opened its QR link."],
      );
    });
    await held(startedAt);
    return reply.code(202).send({ status: "received" });
  });
}
