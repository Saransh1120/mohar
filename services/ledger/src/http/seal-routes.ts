import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { SignedEvent } from "@mohar/contracts";
import { appendEvent } from "../append.js";
import { withTransaction } from "../db.js";

/**
 * ── Sealing a packet ─────────────────────────────────────────────────────────
 *
 *   POST /packages/:id/seal    body: a signed SEAL_APPLIED event that carries
 *                              the label's seam id and commitment
 *
 * The press operator's device makes the label: it generates the seam secret,
 * splits it across the two QR codes, prints them, and signs a SEAL_APPLIED
 * event holding only the commitment. That event arrives here. The secret does
 * not - this route never sees it and there is no field it could arrive in. The
 * server learns a secret only later, when a scanning device at a hand-off sends
 * the rebuilt value to be checked against this commitment.
 *
 * Two things happen, in one transaction: the event goes into the chain through
 * the same `appendEvent` as `POST /events`, and the commitment is registered in
 * ref.seal_label, which is what the hand-off engine checks a scan against.
 *
 * The event is recorded before the label is judged. A device signing "I sealed
 * this packet" for a packet that already has a label, or with a serial that is
 * not the planned one, has still done something that happened, and the chain
 * keeps it. What is refused is the registration: a second sealing must not
 * replace the commitment the first one made, because that is exactly what
 * swapping a label looks like.
 *
 * `services/sealkeys` does not exist yet, so this lives in the ledger beside
 * the other engines. Splitting the Opening Key at sealing is not done here.
 */

const Uuid = z.string().uuid();

export function registerSealRoutes(app: FastifyInstance, pool: Pool): void {
  app.post<{ Params: { id: string } }>("/packages/:id/seal", async (req, reply) => {
    if (!Uuid.safeParse(req.params.id).success) {
      return reply.code(400).send({ error: "package id must be a uuid" });
    }
    const parsed = SignedEvent.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "body must be a signed event", detail: parsed.error.message });
    }
    const body = (parsed.data as SignedEvent).body;
    if (body.kind !== "SEAL_APPLIED") {
      return reply.code(400).send({ error: `expected a SEAL_APPLIED event, got ${body.kind}` });
    }
    if (body.packageId !== req.params.id) {
      return reply.code(400).send({ error: "the event names a different package than the URL" });
    }
    const { seamId, labelCommitment, sealSerial } = body.payload;
    if (!seamId || !labelCommitment) {
      return reply.code(400).send({
        error: "this SEAL_APPLIED carries no seam label; post it to /events instead",
      });
    }
    const labelsPerPacket = body.payload.labelsPerPacket ?? 1;

    const out = await withTransaction(pool, async (tx) => {
      const { rows: pkg } = await tx.query<{ seal_serial: string | null }>(
        "select seal_serial from ref.package where id = $1::uuid for update",
        [req.params.id],
      );
      if (pkg.length === 0) return { code: 404 as const, body: { error: "unknown package" } };

      const outcome = await appendEvent(tx, req.body);
      if (outcome.status === "rejected") {
        return { code: 422 as const, body: { status: "rejected", ...outcome.rejection } };
      }
      const event = { seq: outcome.record.seq, hash: outcome.record.hash };

      const { rows: existing } = await tx.query<{ seam_id: string; commitment_hex: string }>(
        "select seam_id, commitment_hex from ref.seal_label where package_id = $1::uuid",
        [req.params.id],
      );
      if (existing[0]) {
        // The same device retrying after a dropped connection is not a second
        // sealing: same event, same label, and it gets the same answer.
        const same =
          existing[0].seam_id === seamId && existing[0].commitment_hex === labelCommitment;
        if (outcome.status === "duplicate" && same) {
          return { code: 200 as const, body: { status: "sealed", packageId: req.params.id, seamId, labelsPerPacket, event } };
        }
        return {
          code: 409 as const,
          body: {
            error: "this packet already has a seam label; the commitment on record was not replaced",
            seamIdOnRecord: existing[0].seam_id,
            seamIdPresented: seamId,
            event,
          },
        };
      }

      const planned = pkg[0]!.seal_serial;
      if (planned !== null && planned !== sealSerial) {
        return {
          code: 409 as const,
          body: {
            error: "the serial in the sealing event is not the serial planned for this packet",
            serialPlanned: planned,
            serialPresented: sealSerial,
            event,
          },
        };
      }

      // seam_id is unique across packets, so a second packet presenting an id
      // already in use inserts nothing and is told so.
      const { rowCount } = await tx.query(
        `insert into ref.seal_label (package_id, seam_id, commitment_hex, labels_per_packet)
         values ($1::uuid, $2, $3, $4)
         on conflict do nothing`,
        [req.params.id, seamId, labelCommitment, labelsPerPacket],
      );
      if (rowCount === 0) {
        return {
          code: 409 as const,
          body: { error: "this seam id is already registered to another packet", seamIdPresented: seamId, event },
        };
      }
      if (planned === null) {
        await tx.query("update ref.package set seal_serial = $2, updated_at = now() where id = $1::uuid", [
          req.params.id,
          sealSerial,
        ]);
      }
      return { code: 201 as const, body: { status: "sealed", packageId: req.params.id, seamId, labelsPerPacket, event } };
    });

    if (out.code >= 400) req.log.warn({ packageId: req.params.id, ...out.body }, "sealing not registered");
    else req.log.info({ packageId: req.params.id, seamId }, "packet sealed");
    return reply.code(out.code).send(out.body);
  });
}
