import { randomBytes, type X509Certificate } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { DeviceKind, PackageState } from "@mohar/contracts";
import {
  listDevices,
  getDevice,
  enrolDevice,
  recordAttestation,
  listAttestations,
  revokeDevice,
  listPackages,
  getPackage,
  setPackageDeclaredState,
  fitSeamSeal,
  testSeamToken,
  listExams,
  listCentres,
  listPersons,
  listEnrolments,
  enrolFingerprint,
  revokeEnrolment,
} from "../store/registry.js";
import { listActivity, operationalSummary } from "../domain/activity.js";
import { ChallengeBook, loadRoots, verifyAttestation } from "../domain/attestation.js";
import { withTransaction } from "../db.js";

/**
 * Registry and operations endpoints.
 *
 * Everything here reads or writes *reference* data — the plan — and reads
 * projections over the ledger. Nothing in this file writes to `led.event`; the
 * only way into the chain is a signed event through `POST /events`, and keeping
 * that a single entrance is what makes the chain worth trusting.
 *
 * Nothing here checks who is asking. `services/gateway` does that for the whole
 * system (docs/02): enrolment, revocation and the registers are a control room
 * operator's there. Reached directly, these routes are open, which is why the
 * ledger is bound to loopback or given a GATEWAY_SECRET.
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

const ChallengeBody = z.object({
  pubkeyHex: z.string().regex(/^[0-9a-f]{64}$/, "expected a 32-byte hex Ed25519 public key"),
});

/**
 * How enrolment treats attestation. Read from the environment by default; the
 * end-to-end checks pass their own so they can use a root they made.
 */
export interface AttestationPolicy {
  roots: readonly X509Certificate[];
  /** Roots that certify TPM attestation keys, for a centre PC's quote. */
  tpmRoots?: readonly X509Certificate[];
  /** Device kinds that are refused when they present no attestation at all. */
  requiredKinds: ReadonlySet<string>;
  /** Certificate serial to its status in the vendor's list, when one is loaded. */
  revocation?: ((serialHex: string) => string | undefined) | undefined;
}

/** `infra/attestation`, from wherever the ledger was started. */
function defaultRootsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "..", "infra", "attestation");
}

function policyFromEnvironment(app: FastifyInstance): AttestationPolicy {
  const dir = process.env["ATTESTATION_ROOTS_DIR"] ?? defaultRootsDir();
  const { roots, problems } = loadRoots(dir);
  // Kept apart from the phone makers' roots: being trusted to vouch for a
  // phone's Keystore is not being trusted to vouch for a PC's TPM.
  const tpmDir = process.env["ATTESTATION_TPM_ROOTS_DIR"] ?? join(dir, "tpm");
  const tpm = loadRoots(tpmDir);
  const requiredKinds = new Set(
    (process.env["ATTESTATION_REQUIRED_KINDS"] ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
  app.log.info(
    {
      dir, roots: roots.length, problems,
      tpmDir, tpmRoots: tpm.roots.length, tpmProblems: tpm.problems,
      requiredKinds: [...requiredKinds],
    },
    roots.length === 0
      ? "no attestation roots loaded: an enrolment presenting an attestation will be refused"
      : "attestation roots loaded",
  );

  // The vendor's revocation list, if a URL for it is configured. Fetched in
  // the background and refreshed hourly; until the first fetch lands, the
  // check reports itself as not evaluated rather than as passed.
  const statusUrl = process.env["ATTESTATION_STATUS_URL"];
  let entries: Map<string, string> | null = null;
  if (statusUrl) {
    const refresh = async (): Promise<void> => {
      try {
        const res = await fetch(statusUrl, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`answered ${res.status}`);
        const body = (await res.json()) as { entries?: Record<string, { status?: string }> };
        entries = new Map(
          Object.entries(body.entries ?? {}).map(([serial, v]) => [serial.toLowerCase(), v.status ?? "LISTED"]),
        );
        app.log.info({ entries: entries.size }, "attestation revocation list loaded");
      } catch (err) {
        app.log.warn({ err }, "attestation revocation list could not be fetched");
      }
    };
    void refresh();
    setInterval(() => void refresh(), 3600_000).unref();
  }

  return {
    roots,
    tpmRoots: tpm.roots,
    requiredKinds,
    get revocation() {
      const loaded = entries;
      return loaded ? (serial: string) => loaded.get(serial.replace(/^0+/, "")) ?? loaded.get(serial) : undefined;
    },
  };
}

export function registerRegistryRoutes(
  app: FastifyInstance,
  pool: Pool,
  options: { attestation?: AttestationPolicy } = {},
): void {
  const attestationPolicy = options.attestation ?? policyFromEnvironment(app);
  const challenges = new ChallengeBook();

  // ── devices ───────────────────────────────────────────────────────────────

  app.get("/devices", async (_req, reply) => {
    return reply.send({ devices: await listDevices(pool) });
  });

  /** One device, revoked or not: the key the gateway checks a signature against. */
  app.get<{ Params: { id: string } }>("/devices/:id", async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) {
      return reply.code(404).send({ error: "unknown device" });
    }
    const device = await getDevice(pool, req.params.id);
    if (!device) return reply.code(404).send({ error: "unknown device" });
    return reply.send(device);
  });

  /** The ruling each device was enrolled under, for the Devices page. */
  app.get("/devices/attestations", async (_req, reply) => {
    try {
      return reply.send({ attestations: await listAttestations(pool) });
    } catch (err) {
      if ((err as { code?: string }).code === "42P01") {
        return reply.code(503).send({ error: "migration 014 has not been applied to this database" });
      }
      throw err;
    }
  });

  /**
   * A challenge for a key about to be enrolled.
   *
   * The phone asks its Keystore to attest the key over this value, which is
   * what stops an attestation made last year, or on another phone, from being
   * presented now. One per key, used once, gone after ten minutes.
   */
  app.post("/devices/challenge", async (req, reply) => {
    const parsed = ChallengeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid key" });
    }
    const challenge = randomBytes(32);
    const expiresAt = challenges.issue(parsed.data.pubkeyHex, challenge);
    return reply.code(201).send({
      challengeB64: challenge.toString("base64"),
      expiresAt: expiresAt.toISOString(),
    });
  });

  /**
   * Enrol a device.
   *
   * An attestation, where one is presented, is put to every check in
   * domain/attestation and the ruling is written down with the device, or
   * instead of it: one that fails any check enrols nothing. A phone presents
   * an Android Keystore chain; a centre PC presents a TPM quote over the key
   * and the challenge, which shows a TPM vouched for the key and not that the
   * key is inside it. A device that
   * presents none is enrolled as before and recorded as `absent`, unless its
   * kind is listed in ATTESTATION_REQUIRED_KINDS.
   *
   * Nothing in this repository produces an Android attestation yet (the field
   * app is a web page), so today every real enrolment is `absent` and still
   * rests on the operator who made it. That is why this stays behind the
   * gateway. See adr/0003.
   */
  app.post("/devices", async (req, reply) => {
    const parsed = EnrolBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid enrolment", detail: parsed.error.issues });
    }
    const input = parsed.data;
    const attestation = input.attestationB64
      ? new Uint8Array(Buffer.from(input.attestationB64, "base64"))
      : undefined;
    const ruling = verifyAttestation({
      attestation,
      pubkeyHex: input.pubkeyHex,
      // Taken whether or not it then matches: a challenge is answered once.
      expectedChallenge: attestation ? challenges.take(input.pubkeyHex) : null,
      roots: attestationPolicy.roots,
      tpmRoots: attestationPolicy.tpmRoots,
      revocation: attestationPolicy.revocation,
    });
    const required = attestationPolicy.requiredKinds.has(input.kind);
    const refused = ruling.outcome === "refused" || (ruling.outcome === "absent" && required);

    try {
      const device = await withTransaction(pool, async (tx) => {
        const made = refused ? null : await enrolDevice(tx, input);
        await recordAttestation(tx, {
          deviceId: made?.id ?? null,
          pubkeyHex: input.pubkeyHex,
          kind: input.kind,
          ruling,
          attestation,
        });
        return made;
      });

      if (!device) {
        req.log.warn(
          { kind: input.kind, outcome: ruling.outcome, facts: ruling.facts },
          "device enrolment refused on attestation",
        );
        return reply.code(422).send({
          error:
            ruling.outcome === "absent"
              ? `a ${input.kind} device is enrolled only with an attestation, and none was presented`
              : "the attestation presented did not pass, so the device was not enrolled",
          outcome: "refused",
          denyReasons: ["device_attestation_invalid"],
          attestation: ruling,
        });
      }
      req.log.info(
        { deviceId: device.id, kind: device.kind, attestation: ruling.outcome },
        "device enrolled",
      );
      return reply.code(201).send({ ...device, attestation: ruling });
    } catch (err) {
      // A duplicate public key means this key is already enrolled. Re-enrolling
      // it under a second identity would let one key sign as two devices, which
      // would defeat the two-person rule on handoffs.
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "this public key is already enrolled" });
      }
      if ((err as { code?: string }).code === "42P01") {
        return reply.code(503).send({ error: "migration 014 has not been applied to this database" });
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

  // ── the seam seal ─────────────────────────────────────────────────────────
  //
  // Both bodies are validated by exact shape: 64 lowercase hex characters and
  // nothing else. Scanned content is hostile input, and a string that passes
  // this regex has no room left in it to carry anything but a digest.

  const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex characters");

  app.post<{ Params: { id: string }; Body: { commitment?: string } }>(
    "/packages/:id/seam-seal",
    async (req, reply) => {
      const parsed = Hex64.safeParse(req.body?.commitment);
      if (!parsed.success) return reply.code(400).send({ error: "invalid commitment" });
      const result = await fitSeamSeal(pool, req.params.id, parsed.data);
      if (!result.ok) return reply.code(result.status).send({ error: result.reason });
      return reply.send({ status: "fitted" });
    },
  );

  app.post<{ Params: { id: string }; Body: { token?: string } }>(
    "/packages/:id/seam-test",
    async (req, reply) => {
      const parsed = Hex64.safeParse(req.body?.token);
      if (!parsed.success) return reply.code(400).send({ error: "invalid token" });
      return reply.send({ result: await testSeamToken(pool, req.params.id, parsed.data) });
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

  /**
   * Four totals, for the public landing page.
   *
   * `/summary` also counts refusals, key denials and acts awaiting a decision,
   * which is the control room's business and stays behind a session. This is
   * the part with nothing in it to act on: how much the system holds.
   */
  app.get("/counters", async (_req, reply) => {
    const { rows } = await pool.query<{
      events: number;
      packages: number;
      devices: number;
      centres: number;
    }>(
      `select (select count(*) from led.event)::int as events,
              (select count(*) from ref.package)::int as packages,
              (select count(*) from ref.device where revoked_at is null)::int as devices,
              (select count(*) from ref.centre)::int as centres`,
    );
    return reply.send(rows[0]);
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
