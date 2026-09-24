import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { generateTransferKey, transferKeyFingerprint } from "@mohar/crypto-core";
import { withTransaction } from "../db.js";
import {
  decideTransfer,
  recordTransferAttempt,
  type TransferDecision,
  type TransferRequest,
  type TransferStep,
} from "../domain/transfer.js";

/**
 * ── Hand-off legs over HTTP ──────────────────────────────────────────────────
 *
 *   POST /legs                    plan a leg (reference data)
 *   GET  /legs?packageId=         the legs of a packet and where each stands
 *   POST /legs/:legId/dispatch    sender: scan, fingerprint → leg opened
 *   POST /legs/:legId/receive     receiver: scan, serial, fingerprint → key
 *   POST /legs/:legId/confirm     receiver's device submits the key → closed
 *
 * Every step records the attempt before it answers. A refusal is a 200 with
 * `outcome: "refused"`, not a 4xx: it is a successful evaluation that produced
 * "no", and a client that treats it as a transport error will retry it.
 *
 * ── When the key is created ──
 *
 * The key is generated at the moment the receiver passes every check, and
 * returned to that device in that response. It is never shown to the sender and
 * only its hash is ever stored. Creating it at dispatch instead would mean
 * holding the plaintext somewhere between the two steps, and a key that exists
 * in plaintext on the server for hours is a key a database read can steal. The
 * dispatch is what the key links to: a receive with no granted dispatch before
 * it is refused.
 */

const Geo = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative(),
});

const StepBody = z.object({
  deviceId: z.string().uuid(),
  personId: z.string().uuid().optional(),
  // Rebuilt on the device from both QR codes. Shape-checked here because it
  // came from a camera pointed at a surface anyone could have printed on.
  seamSecretHex: z.string().regex(/^[0-9a-f]{32}$/, "seam secret must be 32 lowercase hex").optional(),
  seamIdRead: z.string().regex(/^[0-9A-Z]{20,32}$/).optional(),
  packetSerialTyped: z.string().min(1).max(64).optional(),
  biometricSlot: z.number().int().nonnegative().max(1000).optional(),
  biometricScore: z.number().int().nonnegative().max(1000).optional(),
  transferKey: z.string().min(1).max(32).optional(),
  geo: Geo.optional(),
  occurredAt: z.string().optional(),
});

const LegBody = z.object({
  packageId: z.string().uuid(),
  legNo: z.number().int().positive(),
  fromRole: z.string().min(1),
  toRole: z.string().min(1),
  fromPlace: z.string().min(1).max(200),
  toPlace: z.string().min(1).max(200),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  expectedBy: z.string().datetime(),
  geo: z
    .object({ lat: z.number(), lon: z.number(), radiusM: z.number().int().positive() })
    .optional(),
});

/** Where the packet is once a leg closes, judged by who received it. */
const STATE_AFTER: Record<string, string> = {
  courier: "in_transit",
  police_escort: "in_transit",
  custodian: "at_custodian",
  superintendent: "at_centre",
};

async function raiseAlert(
  tx: PoolClient,
  legId: string,
  decision: TransferDecision,
  step: TransferStep,
): Promise<void> {
  await tx.query(
    `insert into led.alert (kind, package_id, leg_id, evidence, requires_decision, consequence)
     values ('TRANSFER_ATTEMPTS_EXHAUSTED', $1::uuid, $2::uuid, $3::jsonb, true, $4)`,
    [
      decision.context.packageId,
      decision.context.packageId ? legId : null,
      JSON.stringify({
        step,
        attemptNo: decision.attemptNo,
        denyReasons: decision.denyReasons,
        legNo: decision.context.legNo,
      }),
      "Further attempts on this leg are refused. The packet stays with the last person " +
        "who verifiably held it until the control room decides how the hand-off proceeds.",
    ],
  );
}

export function registerTransferRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/legs", async (req, reply) => {
    const parsed = LegBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid leg", detail: parsed.error.issues });
    }
    const b = parsed.data;
    const { rows } = await pool.query<{ id: string }>(
      `insert into ref.route_leg
         (package_id, leg_no, from_role, to_role, from_place, to_place,
          window_start, window_end, expected_by, geo_lat, geo_lon, geo_radius_m)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       returning id`,
      [
        b.packageId, b.legNo, b.fromRole, b.toRole, b.fromPlace, b.toPlace,
        b.windowStart, b.windowEnd, b.expectedBy,
        b.geo?.lat ?? null, b.geo?.lon ?? null, b.geo?.radiusM ?? null,
      ],
    );
    return reply.code(201).send({ legId: rows[0]?.id });
  });

  app.get<{ Querystring: { packageId?: string } }>("/legs", async (req, reply) => {
    const { rows } = await pool.query(
      `select r.id, r.package_id, r.leg_no, r.from_role, r.to_role, r.from_place, r.to_place,
              r.window_start, r.window_end, r.expected_by,
              exists (select 1 from led.transfer_attempt a
                       where a.leg_id = r.id and a.outcome = 'granted'
                         and a.checks ->> 'step' = 'dispatch') as dispatched,
              k.issued_at as key_issued_at,
              exists (select 1 from led.transfer_attempt a
                       where a.leg_id = r.id and a.outcome = 'granted'
                         and a.checks ->> 'step' = 'confirm') as completed,
              (select count(*) from led.transfer_attempt a
                where a.leg_id = r.id and a.outcome = 'refused')::int as refused_attempts
         from ref.route_leg r
         left join led.transfer_key k on k.leg_id = r.id
        where ($1::uuid is null or r.package_id = $1::uuid)
        order by r.package_id, r.leg_no`,
      [req.query.packageId ?? null],
    );
    const now = Date.now();
    return reply.send({
      legs: rows.map((r) => ({
        ...r,
        overdue: !r.completed && new Date(r.expected_by).getTime() < now,
      })),
    });
  });

  for (const step of ["dispatch", "receive", "confirm"] as const) {
    app.post<{ Params: { legId: string } }>(`/legs/:legId/${step}`, async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.legId).success) {
        return reply.code(400).send({ error: "leg id must be a uuid" });
      }
      const parsed = StepBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid request", detail: parsed.error.issues });
      }

      const input: TransferRequest = {
        ...parsed.data,
        legId: req.params.legId,
        step,
        occurredAt: parsed.data.occurredAt ?? new Date().toISOString(),
      };

      const result = await withTransaction(pool, async (tx) => {
        // One hand-off at a time per leg. Two receivers racing each other to the
        // same key is exactly the situation the key exists to prevent.
        await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`leg:${input.legId}`]);

        const decision = await decideTransfer(tx, input);

        // Decide, record, then act — in that order, inside one transaction.
        await recordTransferAttempt(tx, input, decision);
        if (decision.raisesAlert) await raiseAlert(tx, input.legId, decision, step);

        let issuedKey: string | null = null;
        let keyFingerprint: string | null = null;

        if (decision.outcome === "granted" && step === "receive") {
          const { rows: already } = await tx.query(
            "select 1 from led.transfer_key where leg_id = $1::uuid",
            [input.legId],
          );
          if (already.length > 0) {
            // led.* takes no UPDATE, and re-issuing would let a second device
            // obtain a key after the first. The control room resolves this.
            return { decision, issuedKey, keyFingerprint, conflict: true };
          }
          const { rows } = await tx.query<{ seam_id: string | null; window_end: Date }>(
            `select l.seam_id, r.window_end
               from ref.route_leg r
               left join ref.seal_label l on l.package_id = r.package_id
              where r.id = $1::uuid`,
            [input.legId],
          );
          const leg = rows[0];
          const key = generateTransferKey(leg?.seam_id ?? "", input.legId, leg!.window_end);
          await tx.query(
            `insert into led.transfer_key (leg_id, key_hash_hex, expires_at, issued_event_id)
             values ($1::uuid, $2, $3, gen_random_uuid())`,
            [input.legId, key.keyHashHex, key.expiresAt],
          );
          issuedKey = key.key;
          keyFingerprint = transferKeyFingerprint(key.keyHashHex);
        }

        if (decision.outcome === "granted" && step === "confirm" && decision.context.packageId) {
          const { rows } = await tx.query<{ to_role: string }>(
            "select to_role from ref.route_leg where id = $1::uuid",
            [input.legId],
          );
          const next = STATE_AFTER[rows[0]?.to_role ?? ""];
          if (next) {
            await tx.query(
              "update ref.package set state = $2, updated_at = now() where id = $1::uuid",
              [decision.context.packageId, next],
            );
          }
        }

        return { decision, issuedKey, keyFingerprint, conflict: false };
      });

      req.log.info(
        {
          legId: input.legId,
          step,
          outcome: result.decision.outcome,
          denyReasons: result.decision.denyReasons,
          attemptNo: result.decision.attemptNo,
          keyFingerprint: result.keyFingerprint,
        },
        `transfer ${step} ${result.decision.outcome}`,
      );

      if (result.conflict) {
        return reply.code(409).send({
          error: "a key has already been released for this leg",
          detail:
            "It is not issued twice. If the receiving device lost it, the control room " +
            "decides how this hand-off proceeds.",
        });
      }

      return reply.send({
        outcome: result.decision.outcome,
        step,
        denyReasons: result.decision.denyReasons,
        checks: result.decision.checks,
        context: result.decision.context,
        attemptNo: result.decision.attemptNo,
        alertRaised: result.decision.raisesAlert,
        // Present only on a granted receive, and only in this one response.
        ...(result.issuedKey ? { transferKey: result.issuedKey } : {}),
        ...(result.keyFingerprint ? { keyFingerprint: result.keyFingerprint } : {}),
      });
    });
  }
}
