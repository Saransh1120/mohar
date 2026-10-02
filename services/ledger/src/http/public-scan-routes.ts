import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { generateKeypair, signBody } from "@mohar/crypto-core";
import { appendEvent } from "../append.js";
import { withTransaction } from "../db.js";

const Scan = z.object({
  seamId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{20,32}$/),
  whichCodes: z.enum(["A", "B", "both"]),
}).strict();

interface ScanIdentity { deviceId: string; privateKeyHex: string }

/** The service, rather than the unknown visitor, signs what the public page reported. */
function identityForPublicScans(pool: Pool): () => Promise<ScanIdentity> {
  let pending: Promise<ScanIdentity> | undefined;
  return () => {
    pending ??= (async () => {
      const key = generateKeypair();
      const { rows } = await pool.query<{ id: string }>(
        "insert into ref.device (kind, pubkey) values ('service', $1) returning id",
        [Buffer.from(key.publicKeyHex, "hex")],
      );
      return { deviceId: rows[0]!.id, privateKeyHex: key.privateKeyHex };
    })().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

export function registerPublicScanRoutes(app: FastifyInstance, pool: Pool): void {
  const serviceIdentity = identityForPublicScans(pool);
  app.post("/public/seam-scan", async (req, reply) => {
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
    if (!packet) return reply.code(202).send({ recorded: true });

    const identity = await serviceIdentity();
    const userAgent = req.headers["user-agent"]?.slice(0, 280);
    await withTransaction(pool, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [parsed.data.seamId]);
      const { rows: hits } = await tx.query<{ count: string }>(
        `select count(*)::text as count from led.event
          where kind = 'UNAUTHORIZED_SCAN' and body->'payload'->>'seamId' = $1`,
        [parsed.data.seamId],
      );
      const body = {
        v: 1 as const,
        id: randomUUID(),
        examId: packet.exam_id,
        packageId: packet.package_id,
        centreId: packet.centre_id,
        kind: "UNAUTHORIZED_SCAN" as const,
        occurredAt: new Date().toISOString(),
        actorDeviceId: identity.deviceId,
        payload: {
          seamId: parsed.data.seamId,
          whichCodes: parsed.data.whichCodes,
          priorHitsOnThisSeam: Number(hits[0]?.count ?? 0),
          ...(userAgent ? { userAgent } : {}),
        },
      };
      const outcome = await appendEvent(tx, {
        body, deviceSig: signBody(body, identity.privateKeyHex),
      });
      if (outcome.status !== "appended") {
        throw new Error(`public scan could not be recorded: ${outcome.status}`);
      }
      await tx.query(
        `insert into led.alert
           (kind, package_id, centre_id, device_id, evidence, requires_decision, consequence)
         values ('UNAUTHORIZED_SCAN', $1::uuid, $2::uuid, $3::uuid, $4::jsonb, true, $5)`,
        [packet.package_id, packet.centre_id, identity.deviceId,
          JSON.stringify({ eventId: body.id, seamId: parsed.data.seamId,
            whichCodes: parsed.data.whichCodes, priorHitsOnThisSeam: body.payload.priorHitsOnThisSeam }),
          "Check custody and inspect this seam label; a public browser opened its QR link."],
      );
    });
    return reply.code(202).send({ recorded: true });
  });
}
