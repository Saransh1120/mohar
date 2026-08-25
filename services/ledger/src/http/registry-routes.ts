import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { DeviceKind, PackageState } from "@mohar/contracts";
import {
  listDevices,
  enrolDevice,
  revokeDevice,
  listPackages,
  getPackage,
  setPackageDeclaredState,
  listExams,
  listCentres,
  listPersons,
  listEnrolments,
  enrolFingerprint,
  revokeEnrolment,
} from "../store/registry.js";
import { listActivity, operationalSummary } from "../domain/activity.js";

/**
 * Registry and operations endpoints.
 *
 * Everything here reads or writes *reference* data — the plan — and reads
 * projections over the ledger. Nothing in this file writes to `led.event`; the
 * only way into the chain is a signed event through `POST /events`, and keeping
 * that a single entrance is what makes the chain worth trusting.
 *
 * There is no authentication yet. The `gateway` service owns authn/authz for the
 * whole system (docs/02) and is not built; until it is, this must not be exposed
 * beyond localhost.
 */

const EnrolBody = z.object({
  kind: DeviceKind,
  pubkeyHex: z.string().regex(/^[0-9a-f]{64}$/, "expected a 32-byte hex Ed25519 public key"),
  centreId: z.string().uuid().optional(),
  attestationB64: z.string().optional(),
});

const EnrolFingerprintBody = z.object({
  deviceId: z.string().uuid(),
  templateSlot: z.number().int().min(1).max(127),
  personId: z.string().uuid(),
  role: z.enum(["superintendent", "observer"]),
  fingerLabel: z.string().min(1).max(80).optional(),
  note: z.string().min(1).max(500).optional(),
});

export function registerRegistryRoutes(app: FastifyInstance, pool: Pool): void {
  // ── devices ───────────────────────────────────────────────────────────────

  app.get("/devices", async (_req, reply) => {
    return reply.send({ devices: await listDevices(pool) });
  });

  /**
   * Enrol a device.
   *
   * Attestation is accepted but not yet verified — there is no Android Keystore
   * root-of-trust check in this build. That is a real gap, not a simplification:
   * until it exists, enrolment trusts whoever can reach this endpoint, which is
   * why it must stay behind the gateway. See adr/0003.
   */
  app.post("/devices", async (req, reply) => {
    const parsed = EnrolBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid enrolment", detail: parsed.error.issues });
    }
    try {
      const device = await enrolDevice(pool, parsed.data);
      req.log.info({ deviceId: device.id, kind: device.kind }, "device enrolled");
      return reply.code(201).send(device);
    } catch (err) {
      // A duplicate public key means this key is already enrolled. Re-enrolling
      // it under a second identity would let one key sign as two devices, which
      // would defeat the two-person rule on handoffs.
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "this public key is already enrolled" });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/devices/:id/revoke", async (req, reply) => {
    const ok = await revokeDevice(pool, req.params.id);
    if (!ok) return reply.code(404).send({ error: "unknown device, or already revoked" });
    req.log.warn({ deviceId: req.params.id }, "device revoked");
    return reply.send({ status: "revoked", deviceId: req.params.id });
  });

  // ── packages and custody ──────────────────────────────────────────────────

  app.get<{ Querystring: { examId?: string; centreId?: string } }>(
    "/packages",
    async (req, reply) => {
      const packages = await listPackages(pool, {
        ...(req.query.examId ? { examId: req.query.examId } : {}),
        ...(req.query.centreId ? { centreId: req.query.centreId } : {}),
      });
      return reply.send({ packages });
    },
  );

  app.get<{ Params: { id: string } }>("/packages/:id", async (req, reply) => {
    const pkg = await getPackage(pool, req.params.id);
    if (!pkg) return reply.code(404).send({ error: "unknown package" });
    return reply.send(pkg);
  });

  /**
   * Update the planned state. Deliberately separate from the ledger: this says
   * "the plan now expects X", and if the events say otherwise the package shows
   * as divergent rather than being quietly reconciled.
   */
  app.post<{ Params: { id: string }; Body: { state?: string } }>(
    "/packages/:id/declared-state",
    async (req, reply) => {
      const parsed = PackageState.safeParse(req.body?.state);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid target state" });
      }
      const result = await setPackageDeclaredState(pool, req.params.id, parsed.data);
      if (!result.ok) return reply.code(409).send({ error: result.reason });
      return reply.send({ status: "updated", state: parsed.data });
    },
  );

  // ── operations ────────────────────────────────────────────────────────────

  /**
   * The activity ledger: signed events and access attempts interleaved, newest
   * first. Deliberately not filtered by a severity label — see domain/activity.
   */
  app.get<{
    Querystring: {
      limit?: string;
      examId?: string;
      packageId?: string;
      onlyDecisions?: string;
      onlyDenied?: string;
      requiresDecision?: string;
    };
  }>("/activity", async (req, reply) => {
    const entries = await listActivity(pool, {
      limit: Number(req.query.limit ?? 200),
      ...(req.query.examId ? { examId: req.query.examId } : {}),
      ...(req.query.packageId ? { packageId: req.query.packageId } : {}),
      onlyDecisions: req.query.onlyDecisions === "true",
      onlyDenied: req.query.onlyDenied === "true",
    });
    const filtered =
      req.query.requiresDecision === "true"
        ? entries.filter((e) => e.requiresDecision)
        : entries;
    return reply.send({ activity: filtered });
  });

  app.get<{ Querystring: { examId?: string } }>("/summary", async (req, reply) => {
    return reply.send(await operationalSummary(pool, req.query.examId));
  });

  // ── fingerprint enrolments ────────────────────────────────────────────────

  /**
   * Who each template slot belongs to.
   *
   * Reference data, not chain data. The ledger records "slot 3 matched"; this
   * says who slot 3 is, and unlike a signed fact it can be corrected when it
   * turns out to be wrong.
   */
  app.get<{ Querystring: { deviceId?: string; liveOnly?: string } }>(
    "/fingerprints",
    async (req, reply) => {
      return reply.send({
        enrolments: await listEnrolments(pool, {
          ...(req.query.deviceId ? { deviceId: req.query.deviceId } : {}),
          liveOnly: req.query.liveOnly === "true",
        }),
      });
    },
  );

  app.post("/fingerprints", async (req, reply) => {
    const parsed = EnrolFingerprintBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid enrolment", detail: parsed.error.issues });
    }
    const result = await enrolFingerprint(pool, parsed.data);
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    req.log.info(
      { deviceId: parsed.data.deviceId, slot: parsed.data.templateSlot },
      "fingerprint slot mapped to a person",
    );
    return reply.code(201).send({ id: result.id });
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/fingerprints/:id/revoke",
    async (req, reply) => {
      const reason = req.body?.reason?.trim();
      if (!reason) {
        return reply.code(400).send({ error: "a reason is required to retire an enrolment" });
      }
      const ok = await revokeEnrolment(pool, req.params.id, reason);
      if (!ok) return reply.code(404).send({ error: "unknown enrolment, or already retired" });
      return reply.send({ status: "revoked", id: req.params.id });
    },
  );

  // ── reference data ────────────────────────────────────────────────────────

  app.get("/exams", async (_req, reply) => {
    return reply.send({ exams: await listExams(pool) });
  });

  app.get<{ Querystring: { examId?: string } }>("/centres", async (req, reply) => {
    return reply.send({ centres: await listCentres(pool, req.query.examId) });
  });

  app.get("/persons", async (_req, reply) => {
    return reply.send({ persons: await listPersons(pool) });
  });

  /**
   * Who is on duty at one centre, right now.
   *
   * `/persons` lists everyone the registry knows, which is the wrong question
   * for any caller that needs to name an actor: the engine refuses for
   * `person_not_on_roster`, so offering a chooser over all persons invites a
   * refusal that looks like the system failing when it was the operator naming
   * somebody who was never posted there.
   *
   * Bounded by the roster window rather than by the roster row existing, because
   * a posting that ended last month is not a posting.
   */
  app.get<{ Querystring: { centreId?: string } }>("/roster", async (req, reply) => {
    if (!req.query.centreId) {
      return reply.code(400).send({ error: "centreId is required" });
    }
    const { rows } = await pool.query(
      `select p.id, p.display_name, p.role, r.exam_id, r.valid_from, r.valid_to
         from ref.roster r
         join ref.person p on p.id = r.person_id
        where r.centre_id = $1::uuid
          and now() between r.valid_from and r.valid_to
        order by p.role, p.display_name`,
      [req.query.centreId],
    );
    return reply.send({
      roster: rows.map((r) => ({
        personId: r.id as string,
        displayName: r.display_name as string,
        role: r.role as string,
        examId: r.exam_id as string,
        validFrom: (r.valid_from as Date).toISOString(),
        validTo: (r.valid_to as Date).toISOString(),
      })),
    });
  });
}
