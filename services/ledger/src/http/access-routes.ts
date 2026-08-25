import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db.js";
import { decideAccess, type AccessRequest } from "../domain/policy.js";
import {
  issueKey,
  revokeKey,
  listKeys,
  listStages,
  listAttempts,
  recordAttempt,
  rotateAll,
  epochStatus,
} from "../domain/keys.js";

/**
 * The access engine's HTTP surface.
 *
 * `POST /access/request` is the only way to obtain a decision. It always
 * records the attempt — granted or refused — before returning, so there is no
 * ordering in which a caller learns the outcome without the attempt being on
 * record. A client that crashes on receipt of a denial has still left evidence.
 */

const RequestBody = z.object({
  packageId: z.string().uuid(),
  stage: z.string().min(1),
  presentedKey: z.string().optional(),
  deviceId: z.string().uuid(),
  personId: z.string().uuid().optional(),
  sealSerialRead: z.string().optional(),
  geo: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      accuracyM: z.number().nonnegative(),
    })
    .optional(),
  occurredAt: z.string().optional(),
  sessionId: z.string().uuid().optional(),
});

export function registerAccessRoutes(app: FastifyInstance, pool: Pool): void {
  app.get("/access/stages", async (_req, reply) => {
    return reply.send({ stages: await listStages(pool) });
  });

  app.get("/access/epoch", async (_req, reply) => {
    return reply.send(epochStatus());
  });

  /**
   * Evaluate one access request.
   *
   * Returns 200 for a refusal, not 4xx: a denial is a successful evaluation
   * that produced "no", and a client treating it as a transport error would
   * retry it as though the request had failed to arrive.
   */
  app.post("/access/request", async (req, reply) => {
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", detail: parsed.error.issues });
    }

    const input: AccessRequest = {
      ...parsed.data,
      occurredAt: parsed.data.occurredAt ?? new Date().toISOString(),
      sessionId: parsed.data.sessionId ?? crypto.randomUUID(),
    };

    const result = await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query(
        "select exam_id, centre_id from ref.package where id = $1",
        [input.packageId],
      );
      const meta = {
        examId: rows[0]?.exam_id ?? null,
        centreId: rows[0]?.centre_id ?? null,
      };

      const decision = await decideAccess(tx, input);
      const attempt = await recordAttempt(tx, input, decision, meta);
      return { decision, attempt };
    });

    req.log.info(
      {
        packageId: input.packageId,
        stage: input.stage,
        outcome: result.decision.outcome,
        denyReasons: result.decision.denyReasons,
        fingerprint: result.decision.context.presentedFingerprint,
        attemptSeq: result.attempt.seq,
      },
      `access ${result.decision.outcome}`,
    );

    return reply.send({
      outcome: result.decision.outcome,
      sessionId: input.sessionId,
      attemptSeq: result.attempt.seq,
      attemptId: result.attempt.id,
      denyReasons: result.decision.denyReasons,
      checksPassed: result.decision.checksPassed,
      checks: result.decision.checks,
      context: result.decision.context,
    });
  });

  app.get<{ Querystring: { packageId?: string; outcome?: string; limit?: string; examId?: string } }>(
    "/access/attempts",
    async (req, reply) => {
      const outcome = req.query.outcome;
      return reply.send({
        attempts: await listAttempts(pool, {
          ...(req.query.packageId ? { packageId: req.query.packageId } : {}),
          ...(outcome === "granted" || outcome === "denied" ? { outcome } : {}),
          ...(req.query.examId ? { examId: req.query.examId } : {}),
          limit: Number(req.query.limit ?? 200),
        }),
      });
    },
  );

  // ── keys ──────────────────────────────────────────────────────────────────

  app.get<{ Querystring: { packageId?: string; epoch?: string; activeOnly?: string } }>(
    "/keys",
    async (req, reply) => {
      return reply.send({
        epoch: epochStatus(),
        keys: await listKeys(pool, {
          ...(req.query.packageId ? { packageId: req.query.packageId } : {}),
          ...(req.query.epoch ? { epoch: Number(req.query.epoch) } : {}),
          activeOnly: req.query.activeOnly === "true",
        }),
      });
    },
  );

  /**
   * Issue (or fetch) the key for one stage of one package.
   *
   * The plaintext key appears in this response and nowhere else, ever. It is not
   * logged, not stored, and not retrievable afterwards — only its SHA-256 is
   * kept. Losing it means rotating to the next epoch, which is the intended
   * cost of a credential that cannot be recovered from a database.
   */
  app.post<{ Body: { packageId?: string; stage?: string; personId?: string } }>(
    "/keys/issue",
    async (req, reply) => {
      const { packageId, stage, personId } = req.body ?? {};
      if (!packageId || !stage) {
        return reply.code(400).send({ error: "packageId and stage are required" });
      }
      try {
        const result = await withTransaction(pool, (tx) =>
          issueKey(tx, { packageId, stage, issuedToPerson: personId ?? null }),
        );
        req.log.info(
          { packageId, stage, fingerprint: result.key.fingerprint, created: result.created },
          result.created ? "custody key issued" : "custody key already issued this epoch",
        );
        return reply.code(result.created ? 201 : 200).send(result);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post("/keys/rotate", async (req, reply) => {
    const result = await rotateAll(pool);
    req.log.warn(
      { epoch: result.epoch, issued: result.issued.length, skipped: result.skipped },
      "custody keys rotated",
    );
    return reply.send({
      epoch: result.epoch,
      issuedCount: result.issued.length,
      alreadyCurrent: result.skipped,
      keys: result.issued,
    });
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/keys/:id/revoke",
    async (req, reply) => {
      const reason = req.body?.reason?.trim();
      if (!reason) {
        return reply.code(400).send({ error: "a reason is required to revoke a key" });
      }
      const ok = await revokeKey(pool, req.params.id, reason);
      if (!ok) return reply.code(404).send({ error: "unknown key, or already revoked" });
      req.log.warn({ keyId: req.params.id, reason }, "custody key revoked");
      return reply.send({ status: "revoked", keyId: req.params.id, reason });
    },
  );
}
