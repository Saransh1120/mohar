import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { accountForToken } from "../domain/accounts.js";
import { withTransaction } from "../db.js";
import { bearerToken } from "./auth-routes.js";
import {
  commitmentsFor,
  controlEnvelopeFor,
  decideConfirm,
  decideOfficial,
  decideRelease,
  decideStart,
  DUTY_ROLES,
  loadCeremony,
  lockRoster,
  recordStep,
  reissueRoster,
  wrappedShareFor,
  type CeremonyState,
} from "../domain/opening.js";

/**
 * ── Rosters, stations and the opening ceremony over HTTP ─────────────────────
 *
 *   GET  /rosters?centreId=                 duty rosters and what has been issued
 *   PUT  /rosters/:centreId/:session        assign the three officials (before locking)
 *   POST /rosters/:centreId/:session/lock   lock it, and issue each packet's opening key
 *   POST /rosters/:centreId/:session/reissue  replace an official after the lock: a new key
 *                                           for every unopened packet, with a stated reason
 *   POST /stations/:deviceId/wrap-key       a station registers the key it unwraps with
 *   GET  /stations/:deviceId/envelopes      the time-locked envelopes issued to a station
 *
 *   POST /ceremonies                        scan + authorize
 *   GET  /ceremonies?packageId=&centreId=   ceremonies and every step of each
 *   GET  /ceremonies/:id                    one ceremony, for the station and the control room
 *   POST /ceremonies/:id/official           one official identified → their wrapped share
 *   POST /ceremonies/:id/confirm            the packet serial, typed
 *   POST /ceremonies/:id/release            the assembled key, checked against its commitment
 *   POST /ceremonies/:id/opened             the packet was opened; the photograph's hash
 *
 * Every ceremony step is recorded before it is answered, and a refusal is a 200
 * with `outcome: "refused"`.
 */

const Uuid = z.string().uuid();

const AssignBody = z.object({
  assignments: z
    .array(z.object({ role: z.enum(["superintendent", "observer", "police_escort"]), personId: Uuid }))
    .min(1)
    .max(3),
});

const LockBody = z.object({
  stationDeviceId: Uuid,
  // Why it is being locked inside the last day. The engine asks for it then.
  lateReason: z.string().trim().max(500).optional(),
});

const ReissueBody = z.object({
  changes: z
    .array(z.object({ role: z.enum(["superintendent", "observer", "police_escort"]), personId: Uuid }))
    .min(1)
    .max(3),
  reason: z.string().trim().max(500),
});

const WrapKeyBody = z.object({
  x25519PubHex: z.string().regex(/^[0-9a-f]{64}$/, "expected a 32-byte hex X25519 public key"),
});

const StartBody = z.object({
  packageId: Uuid,
  deviceId: Uuid,
  seamIdRead: z.string().regex(/^[0-9A-Z]{20,32}$/).optional(),
  seamSecretHex: z.string().regex(/^[0-9a-f]{32}$/, "seam secret must be 32 lowercase hex").optional(),
});

const OfficialBody = z.object({
  personId: Uuid,
  biometricSlot: z.number().int().nonnegative().max(1000).optional(),
  biometricScore: z.number().int().nonnegative().max(1000).optional(),
  faceMatched: z.boolean().optional(),
  assertedAt: z.string().datetime().optional(),
});

const ConfirmBody = z.object({ packetSerialTyped: z.string().trim().min(1).max(64) });

const ReleaseBody = z.object({
  openingKeyHex: z.string().regex(/^[0-9a-f]{64}$/, "expected the 32-byte key as lowercase hex"),
});

const OpenedBody = z.object({
  photoSha256: z.string().regex(/^[0-9a-f]{64}$/, "expected the sha-256 of the photograph"),
  candidateWitnesses: z.number().int().nonnegative().max(20).optional(),
});

function view(c: CeremonyState) {
  return {
    id: c.id,
    packageId: c.packageId,
    centreId: c.centreId,
    scheduledOpenAt: c.scheduledOpenAt,
    startedAt: c.startedAt,
    reached: c.reached,
    officials: c.officials,
    steps: c.steps.map((s) => ({
      step: s.step,
      outcome: s.outcome,
      officials: s.officials,
      checks: s.evidence.checks ?? [],
      recordedAt: s.recorded_at,
    })),
  };
}

export function registerOpeningRoutes(app: FastifyInstance, pool: Pool): void {
  // ── rosters ───────────────────────────────────────────────────────────────

  app.get<{ Querystring: { centreId?: string } }>("/rosters", async (req, reply) => {
    const { rows } = await pool.query(
      `select c.id as centre_id, c.code as centre_code, c.exam_id as exam_session,
              e.name as exam_name, e.starts_at,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                         'role', d.role, 'personId', d.person_id,
                         'personName', p.display_name, 'personRole', p.role,
                         'lockedAt', d.locked_at) order by d.role)
                  from ref.duty_roster d join ref.person p on p.id = d.person_id
                 where d.centre_id = c.id and d.exam_session = c.exam_id::text), '[]'::jsonb) as duty,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                         'packageId', k.package_id, 'packetSerial', pk.seal_serial,
                         'drandRound', k.drand_round, 'scheduledOpenAt', k.scheduled_open_at,
                         'stationDeviceId', k.station_device_id, 'issuedAt', k.issued_at,
                         'keyCommitment', k.key_commitment, 'issueNo', k.issue_no) order by k.issued_at)
                  from led.opening_key k join ref.package pk on pk.id = k.package_id
                 where pk.centre_id = c.id
                   -- Only the issue in force. Earlier ones are in the history below.
                   and k.issue_no = (select max(k2.issue_no) from led.opening_key k2
                                      where k2.package_id = k.package_id)), '[]'::jsonb) as issued,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                         'issueNo', i.issue_no, 'kind', i.kind, 'issuedAt', i.issued_at,
                         'late', i.late, 'leadSeconds', i.lead_seconds, 'reason', i.reason,
                         'packets', i.packets, 'changes', i.changes,
                         'by', a.display_name, 'byUsername', a.username) order by i.issue_no)
                  from led.roster_issue i left join ref.account a on a.id = i.account_id
                 where i.centre_id = c.id and i.exam_session = c.exam_id::text), '[]'::jsonb) as issues,
              (select count(*)::int from ref.package pk where pk.centre_id = c.id) as packets
         from ref.centre c
         join ref.exam e on e.id = c.exam_id
        where ($1::uuid is null or c.id = $1::uuid)
          and (exists (select 1 from ref.duty_roster d where d.centre_id = c.id)
               or $1::uuid is not null)
        order by e.starts_at desc
        limit 100`,
      [req.query.centreId ?? null],
    );
    return reply.send({ rosters: rows, dutyRoles: DUTY_ROLES });
  });

  app.put<{ Params: { centreId: string; session: string } }>(
    "/rosters/:centreId/:session",
    async (req, reply) => {
      if (!Uuid.safeParse(req.params.centreId).success) {
        return reply.code(400).send({ error: "centre id must be a uuid" });
      }
      const parsed = AssignBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid roster", detail: parsed.error.issues });
      }
      const out = await withTransaction(pool, async (tx) => {
        const { rows: locked } = await tx.query(
          `select 1 from ref.duty_roster
            where centre_id = $1::uuid and exam_session = $2 and locked_at is not null limit 1`,
          [req.params.centreId, req.params.session],
        );
        if (locked.length > 0) return false;
        for (const a of parsed.data.assignments) {
          await tx.query(
            `insert into ref.duty_roster (centre_id, exam_session, role, person_id)
             values ($1::uuid, $2, $3, $4::uuid)
             on conflict (centre_id, exam_session, role) do update set person_id = excluded.person_id`,
            [req.params.centreId, req.params.session, a.role, a.personId],
          );
        }
        return true;
      });
      if (!out) {
        return reply.code(409).send({
          error:
            "This roster is locked: shares have been wrapped to the officials on it. A change " +
            "after locking is a re-issue, which states its reason and makes new keys.",
        });
      }
      return reply.send({ status: "assigned" });
    },
  );

  app.post<{ Params: { centreId: string; session: string } }>(
    "/rosters/:centreId/:session/lock",
    async (req, reply) => {
      if (!Uuid.safeParse(req.params.centreId).success) {
        return reply.code(400).send({ error: "centre id must be a uuid" });
      }
      // Locking wraps key material to named officers. It names who did it.
      const account = await accountForToken(pool, bearerToken(req));
      if (!account) return reply.code(401).send({ error: "Sign in to lock a roster." });

      const parsed = LockBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid request", detail: parsed.error.issues });
      }
      const result = await withTransaction(pool, async (tx) => {
        await tx.query("select pg_advisory_xact_lock(hashtext($1))", [
          `roster:${req.params.centreId}`,
        ]);
        return lockRoster(tx, {
          centreId: req.params.centreId,
          examSession: req.params.session,
          stationDeviceId: parsed.data.stationDeviceId,
          accountId: account.id,
          ...(parsed.data.lateReason ? { lateReason: parsed.data.lateReason } : {}),
        });
      });
      req.log.info(
        {
          centreId: req.params.centreId,
          username: account.username,
          outcome: result.decision.outcome,
          packets: result.packets.length,
        },
        `roster lock ${result.decision.outcome}`,
      );
      return reply.send({
        outcome: result.decision.outcome === "passed" ? "locked" : "refused",
        denyReasons: result.decision.denyReasons,
        checks: result.decision.checks,
        lockedAt: result.lockedAt,
        lockedBy: result.lockedAt ? account.username : null,
        issueNo: result.issueNo,
        late: result.late,
        packets: result.packets,
      });
    },
  );

  app.post<{ Params: { centreId: string; session: string } }>(
    "/rosters/:centreId/:session/reissue",
    async (req, reply) => {
      if (!Uuid.safeParse(req.params.centreId).success) {
        return reply.code(400).send({ error: "centre id must be a uuid" });
      }
      const account = await accountForToken(pool, bearerToken(req));
      if (!account) return reply.code(401).send({ error: "Sign in to re-issue a roster." });

      const parsed = ReissueBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid request", detail: parsed.error.issues });
      }
      const result = await withTransaction(pool, async (tx) => {
        await tx.query("select pg_advisory_xact_lock(hashtext($1))", [
          `roster:${req.params.centreId}`,
        ]);
        return reissueRoster(tx, {
          centreId: req.params.centreId,
          examSession: req.params.session,
          changes: parsed.data.changes,
          reason: parsed.data.reason,
          accountId: account.id,
        });
      });
      req.log.info(
        {
          centreId: req.params.centreId,
          username: account.username,
          outcome: result.decision.outcome,
          issueNo: result.issueNo,
          packets: result.packets.length,
        },
        `roster re-issue ${result.decision.outcome}`,
      );
      return reply.send({
        outcome: result.decision.outcome === "passed" ? "reissued" : "refused",
        denyReasons: result.decision.denyReasons,
        checks: result.decision.checks,
        issueNo: result.issueNo,
        reissuedBy: result.issueNo ? account.username : null,
        changes: result.changes,
        packets: result.packets,
      });
    },
  );

  // ── stations ──────────────────────────────────────────────────────────────

  app.post<{ Params: { deviceId: string } }>("/stations/:deviceId/wrap-key", async (req, reply) => {
    if (!Uuid.safeParse(req.params.deviceId).success) {
      return reply.code(400).send({ error: "device id must be a uuid" });
    }
    const parsed = WrapKeyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid key" });
    }
    const out = await withTransaction(pool, async (tx) => {
      const { rows: dev } = await tx.query<{ revoked_at: Date | null }>(
        "select revoked_at from ref.device where id = $1::uuid",
        [req.params.deviceId],
      );
      if (!dev[0]) return { code: 404 as const, error: "no such device" };
      if (dev[0].revoked_at) return { code: 409 as const, error: "this device is revoked" };

      const { rows: existing } = await tx.query<{ x25519_pub: Buffer }>(
        "select x25519_pub from ref.device_wrap_key where device_id = $1::uuid",
        [req.params.deviceId],
      );
      if (existing[0]) {
        if (existing[0].x25519_pub.toString("hex") === parsed.data.x25519PubHex) {
          return { code: 200 as const };
        }
        // Shares already wrapped to the old key would be unreadable by the new
        // one, and silently swapping the key is how somebody else's station
        // becomes the one that can unwrap them.
        return {
          code: 409 as const,
          error:
            "this station already has an unwrap key on record; a different one is not " +
            "accepted in its place. Enrol a new device for a new key.",
        };
      }
      await tx.query(
        "insert into ref.device_wrap_key (device_id, x25519_pub) values ($1::uuid, decode($2, 'hex'))",
        [req.params.deviceId, parsed.data.x25519PubHex],
      );
      return { code: 201 as const };
    });
    if (out.error) return reply.code(out.code).send({ error: out.error });
    return reply.code(out.code).send({ status: "registered" });
  });

  app.get<{ Params: { deviceId: string } }>("/stations/:deviceId/envelopes", async (req, reply) => {
    if (!Uuid.safeParse(req.params.deviceId).success) {
      return reply.code(400).send({ error: "device id must be a uuid" });
    }
    // Only the time-locked envelopes. They are useless before their round, so
    // a station may hold them a day ahead. The officials' wrapped shares are
    // not here: each is handed over when that official is identified.
    const { rows } = await pool.query(
      `select k.package_id, pk.seal_serial, c.code as centre_code, k.drand_round,
              k.scheduled_open_at, e.starts_at,
              exists (select 1 from ref.device_wrap_key w where w.device_id = k.station_device_id) as paired
         from led.opening_key k
         join ref.package pk on pk.id = k.package_id
         join ref.centre c on c.id = pk.centre_id
         join ref.exam e on e.id = pk.exam_id
        where k.station_device_id = $1::uuid
          and k.issue_no = (select max(k2.issue_no) from led.opening_key k2
                             where k2.package_id = k.package_id)
        order by k.scheduled_open_at desc
        limit 100`,
      [req.params.deviceId],
    );
    const envelopes = [];
    for (const r of rows) {
      envelopes.push({ ...r, envelope: await controlEnvelopeFor(pool, r.package_id) });
    }
    return reply.send({ envelopes });
  });

  // ── the ceremony ──────────────────────────────────────────────────────────

  app.post("/ceremonies", async (req, reply) => {
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", detail: parsed.error.issues });
    }
    const input = parsed.data;
    const out = await withTransaction(pool, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`ceremony:${input.packageId}`]);
      const d = await decideStart(tx, input);
      // A ceremony row needs a packet and a centre to hang on. An attempt on a
      // packet that does not exist has neither, and is answered without one.
      if (!d.centreId || !d.scheduledOpenAt) return { d, id: null };

      const { rows } = await tx.query<{ id: string }>(
        `insert into led.ceremony (package_id, mode, centre_id, scheduled_open_at)
         values ($1::uuid, 'live-authorized', $2::uuid, $3) returning id`,
        [input.packageId, d.centreId, d.scheduledOpenAt],
      );
      const id = rows[0]!.id;
      const extra = {
        deviceId: input.deviceId,
        ...(input.seamIdRead ? { seamIdRead: input.seamIdRead } : {}),
        ...(d.issueNo === null ? {} : { issueNo: d.issueNo }),
      };
      await recordStep(tx, id, "scan", d.scan, extra);
      await recordStep(tx, id, "authorize", d.authorize, extra);

      if (d.sealMismatch) {
        await tx.query(
          `insert into led.alert (kind, package_id, centre_id, evidence, requires_decision, consequence)
           values ('SEAL_MISMATCH', $1::uuid, $2::uuid, $3::jsonb, true, $4)`,
          [
            input.packageId, d.centreId,
            JSON.stringify({ ceremonyId: id, seamIdRead: input.seamIdRead ?? null, checks: d.scan.checks }),
            "At the opening, the label scanned off this packet read cleanly and is not the one " +
              "recorded when it was sealed. Stop: the packet is not to be opened. It is treated " +
              "as compromised until the control room has examined it and recorded what it finds.",
          ],
        );
      }
      return { d, id };
    });

    if (!out.id) return reply.code(404).send({ error: "no such packet" });
    req.log.info(
      { ceremonyId: out.id, scan: out.d.scan.outcome, authorize: out.d.authorize.outcome },
      "ceremony started",
    );
    const proceed = out.d.scan.outcome === "passed" && out.d.authorize.outcome === "passed";
    return reply.code(201).send({
      ceremonyId: out.id,
      outcome: proceed ? "passed" : "refused",
      scan: out.d.scan,
      authorize: out.d.authorize,
      scheduledOpenAt: out.d.scheduledOpenAt,
      drandRound: out.d.drandRound,
    });
  });

  app.get<{ Querystring: { packageId?: string; centreId?: string } }>("/ceremonies", async (req, reply) => {
    const { rows } = await pool.query<{ id: string; seal_serial: string | null; centre_code: string; exam_name: string; starts_at: Date }>(
      `select c.id, p.seal_serial, ce.code as centre_code, e.name as exam_name, e.starts_at
         from led.ceremony c
         join ref.package p on p.id = c.package_id
         join ref.centre ce on ce.id = c.centre_id
         join ref.exam e on e.id = p.exam_id
        where ($1::uuid is null or c.package_id = $1::uuid)
          and ($2::uuid is null or c.centre_id = $2::uuid)
        order by c.started_at desc
        limit 50`,
      [req.query.packageId ?? null, req.query.centreId ?? null],
    );
    const ceremonies = [];
    for (const r of rows) {
      const state = await loadCeremony(pool, r.id);
      if (state) {
        ceremonies.push({
          ...view(state),
          packetSerial: r.seal_serial,
          centreCode: r.centre_code,
          examName: r.exam_name,
          examStartsAt: r.starts_at,
        });
      }
    }
    return reply.send({ ceremonies });
  });

  app.get<{ Params: { id: string } }>("/ceremonies/:id", async (req, reply) => {
    if (!Uuid.safeParse(req.params.id).success) {
      return reply.code(400).send({ error: "ceremony id must be a uuid" });
    }
    const state = await loadCeremony(pool, req.params.id);
    if (!state) return reply.code(404).send({ error: "no such ceremony" });
    return reply.send(view(state));
  });

  app.post<{ Params: { id: string } }>("/ceremonies/:id/official", async (req, reply) => {
    if (!Uuid.safeParse(req.params.id).success) {
      return reply.code(400).send({ error: "ceremony id must be a uuid" });
    }
    const parsed = OfficialBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", detail: parsed.error.issues });
    }
    const input = { ...parsed.data, assertedAt: parsed.data.assertedAt ?? new Date().toISOString() };

    const out = await withTransaction(pool, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`ceremony-run:${req.params.id}`]);
      const state = await loadCeremony(tx, req.params.id);
      if (!state) return null;
      const d = await decideOfficial(tx, state, input);
      await recordStep(
        tx,
        req.params.id,
        "identify",
        d.decision,
        { personId: input.personId },
        d.official
          ? [
              {
                ...d.official,
                biometricSlot: input.biometricSlot,
                biometricScore: input.biometricScore,
                ...(input.faceMatched === undefined ? {} : { faceMatched: input.faceMatched }),
                assertedAt: input.assertedAt,
              },
            ]
          : [],
      );
      // The share leaves the server only here, only after the step is written,
      // and only as ciphertext the station alone can read.
      const share = d.official ? await wrappedShareFor(tx, state.packageId, input.personId) : null;
      return { d, share, identified: state.officials.length + (d.official ? 1 : 0) };
    });

    if (!out) return reply.code(404).send({ error: "no such ceremony" });
    return reply.send({
      outcome: out.d.decision.outcome,
      denyReasons: out.d.decision.denyReasons,
      checks: out.d.decision.checks,
      identified: out.identified,
      ...(out.d.official ? { official: out.d.official } : {}),
      ...(out.share ? { share: out.share } : {}),
    });
  });

  app.post<{ Params: { id: string } }>("/ceremonies/:id/confirm", async (req, reply) => {
    if (!Uuid.safeParse(req.params.id).success) {
      return reply.code(400).send({ error: "ceremony id must be a uuid" });
    }
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "type the serial printed on the packet" });
    }
    const out = await withTransaction(pool, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`ceremony-run:${req.params.id}`]);
      const state = await loadCeremony(tx, req.params.id);
      if (!state) return null;
      const d = await decideConfirm(tx, state, parsed.data.packetSerialTyped);
      await recordStep(tx, req.params.id, "confirm", d.decision, {
        serialTyped: parsed.data.packetSerialTyped,
      });
      if (d.raisesAlert) {
        await tx.query(
          `insert into led.alert (kind, package_id, centre_id, evidence, requires_decision, consequence)
           values ('CEREMONY_SERIAL_ATTEMPTS_EXHAUSTED', $1::uuid, $2::uuid, $3::jsonb, true, $4)`,
          [
            state.packageId, state.centreId,
            JSON.stringify({ ceremonyId: state.id, officials: state.officials }),
            "Three wrong serials were typed at this packet's opening. Further entries in this " +
              "ceremony are refused. Either the officials are not standing at this packet or the " +
              "serial on it is not the one on record; the control room finds out which.",
          ],
        );
      }
      const passed = d.decision.outcome === "passed";
      const envelope = passed ? await controlEnvelopeFor(tx, state.packageId) : null;
      const commitments = passed ? await commitmentsFor(tx, state.packageId) : null;
      return { d, envelope, commitments };
    });
    if (!out) return reply.code(404).send({ error: "no such ceremony" });
    return reply.send({
      outcome: out.d.decision.outcome,
      denyReasons: out.d.decision.denyReasons,
      checks: out.d.decision.checks,
      alertRaised: out.d.raisesAlert,
      ...(out.envelope ? { envelope: out.envelope } : {}),
      ...(out.commitments ? { commitments: out.commitments } : {}),
    });
  });

  app.post<{ Params: { id: string } }>("/ceremonies/:id/release", async (req, reply) => {
    if (!Uuid.safeParse(req.params.id).success) {
      return reply.code(400).send({ error: "ceremony id must be a uuid" });
    }
    const parsed = ReleaseBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid key" });
    }
    const out = await withTransaction(pool, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`ceremony-run:${req.params.id}`]);
      const state = await loadCeremony(tx, req.params.id);
      if (!state) return null;
      const d = await decideRelease(tx, state, parsed.data.openingKeyHex);
      // The key is not written anywhere, on a pass or on a refusal.
      await recordStep(tx, req.params.id, "release", d, {}, state.officials);
      return d;
    });
    if (!out) return reply.code(404).send({ error: "no such ceremony" });
    req.log.info({ ceremonyId: req.params.id, outcome: out.outcome }, "ceremony release");
    return reply.send({
      outcome: out.outcome === "passed" ? "granted" : "refused",
      denyReasons: out.denyReasons,
      checks: out.checks,
    });
  });

  app.post<{ Params: { id: string } }>("/ceremonies/:id/opened", async (req, reply) => {
    if (!Uuid.safeParse(req.params.id).success) {
      return reply.code(400).send({ error: "ceremony id must be a uuid" });
    }
    const parsed = OpenedBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const out = await withTransaction(pool, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`ceremony-run:${req.params.id}`]);
      const state = await loadCeremony(tx, req.params.id);
      if (!state) return null;
      const released = state.reached === "release";
      const already = state.steps.some((s) => s.step === "opened" && s.outcome === "passed");
      const passed = released && !already;
      await recordStep(
        tx,
        req.params.id,
        "opened",
        {
          outcome: passed ? "passed" : "refused",
          checks: [
            {
              check: "key_released",
              passed: released || already,
              evidence: released || already
                ? "the key was released in this ceremony"
                : "the key has not been released in this ceremony; the packet is not to be opened",
              ...(released || already ? {} : { reason: "ceremony_step_out_of_order" as const }),
            },
            {
              check: "not_already_opened",
              passed: !already,
              evidence: already ? "this ceremony already recorded the opening" : "no opening recorded yet",
              ...(already ? { reason: "package_already_opened" as const } : {}),
            },
          ],
          denyReasons: already ? ["package_already_opened"] : released ? [] : ["ceremony_step_out_of_order"],
        },
        parsed.data.candidateWitnesses === undefined ? {} : { candidateWitnesses: parsed.data.candidateWitnesses },
        state.officials,
        parsed.data.photoSha256,
      );
      if (passed) {
        await tx.query("update ref.package set state = 'opened', updated_at = now() where id = $1::uuid", [
          state.packageId,
        ]);
      }
      return passed;
    });
    if (out === null) return reply.code(404).send({ error: "no such ceremony" });
    return reply.send({ outcome: out ? "opened" : "refused" });
  });
}
