import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { accountForToken } from "../domain/accounts.js";
import {
  CallRooms,
  DEVICE_PARTY,
  SDP_LIMIT,
  judgeCall,
  loadCallRows,
  recordCall,
} from "../domain/override-call.js";
import { iceConfig } from "../domain/turn.js";
import { bearerToken } from "./auth-routes.js";

/**
 * ── The override's video call, over HTTP ─────────────────────────────────────
 *
 * The operator's side takes a session; the phone's side takes the device's
 * signature (see the gateway's policy table) and names its device in the body.
 *
 *   POST /overrides/device-requests              the phone's own open requests
 *   POST /overrides/:id/call/device/join         the phone opens the call
 *   POST /overrides/:id/call/device/inbox        messages for the phone
 *   POST /overrides/:id/call/device/offer        the phone's offer to one operator
 *   POST /overrides/:id/call/device/state        connected / ended, as the phone saw it
 *
 *   POST /overrides/:id/call/join                an operator opens the call
 *   GET  /overrides/:id/call/inbox?after=        messages for that operator
 *   POST /overrides/:id/call/answer              the operator's answer
 *   POST /overrides/:id/call/state               connected / ended, with frames decoded
 *   GET  /overrides/:id/call                     what is on record, and where each
 *                                                operator's call stands
 *   GET  /calls/ice                              the servers a call would be given
 *
 * The offer and the answer each carry every network candidate in them, so the
 * whole set-up is one message each way. Both ends poll for theirs: the live
 * stream does not pass the deployed proxy, and a poll does.
 *
 * Joining hands each end the servers to find a path with: a public STUN server,
 * and where a relay is configured (domain/turn), a credential for it that is
 * that end's own and stops working within the hour.
 *
 * Only the phone that made the request may be the phone on its call. The
 * officer standing at the packet is the one the request names, and a call from
 * some other phone shows some other place.
 */

const Uuid = z.string().uuid();
const Sdp = z.string().min(20).max(SDP_LIMIT);

const DeviceBody = z.object({ deviceId: Uuid });
const InboxBody = DeviceBody.extend({ after: z.number().int().nonnegative().default(0) });
const OfferBody = DeviceBody.extend({ to: Uuid, sdp: Sdp });
const DeviceStateBody = DeviceBody.extend({
  operator: Uuid,
  state: z.enum(["connected", "ended"]),
  seconds: z.number().int().nonnegative().max(86_400).optional(),
});
const AnswerBody = z.object({ sdp: Sdp });
const OperatorStateBody = z.object({
  state: z.enum(["connected", "ended"]),
  // What the operator's browser counted. The ledger cannot see the picture;
  // this is the browser saying it decoded one.
  framesDecoded: z.number().int().nonnegative().max(10_000_000).optional(),
  width: z.number().int().nonnegative().max(10_000).optional(),
  height: z.number().int().nonnegative().max(10_000).optional(),
  seconds: z.number().int().nonnegative().max(86_400).optional(),
});

interface RequestRow {
  id: string;
  device_id: string | null;
}

export function registerCallRoutes(app: FastifyInstance, pool: Pool, rooms: CallRooms): void {
  const ice = iceConfig(process.env);
  app.log.info(
    { relay: ice.relay, problems: ice.problems },
    ice.relay
      ? "override calls are offered a relay"
      : "override calls have no relay: two networks that both block direct connections will not connect",
  );
  const request = async (id: string): Promise<RequestRow | undefined> => {
    if (!Uuid.safeParse(id).success) return undefined;
    const { rows } = await pool.query<RequestRow>(
      "select id, device_id from led.seam_override_request where id = $1::uuid",
      [id],
    );
    return rows[0];
  };
  const operator = (req: FastifyRequest) => accountForToken(pool, bearerToken(req));

  /**
   * The servers an operator's browser would be handed for a call, without
   * opening one: what the Overrides page uses to check that the relay is there
   * before a call depends on it.
   */
  app.get("/calls/ice", async (req, reply) => {
    const account = await operator(req);
    if (!account) return reply.code(401).send({ error: "Sign in to check the relay." });
    return reply.send({
      iceServers: ice.serversFor(`account-${account.id}`),
      relay: ice.relay,
      problems: ice.problems,
    });
  });

  // ── the phone ─────────────────────────────────────────────────────────────

  app.post("/overrides/device-requests", async (req, reply) => {
    const parsed = DeviceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "deviceId is required" });
    const { rows } = await pool.query(
      `select q.id, q.leg_id, q.seam_id_typed, q.requested_at, r.leg_no, r.from_place, r.to_place,
              p.seal_serial,
              (select count(*)::int from led.seam_override_decision d
                where d.request_id = q.id and d.decision = 'approved') as approvals,
              exists (select 1 from led.seam_override_decision d
                       where d.request_id = q.id and d.decision = 'refused') as refused
         from led.seam_override_request q
         join ref.route_leg r on r.id = q.leg_id
         join ref.package p on p.id = q.package_id
        where q.device_id = $1::uuid and q.requested_at > now() - interval '24 hours'
        order by q.requested_at desc
        limit 20`,
      [parsed.data.deviceId],
    );
    return reply.send({ requests: rows });
  });

  /** The request, if this device is the one that made it. */
  const forDevice = async (id: string, deviceId: string) => {
    const r = await request(id);
    if (!r) return { code: 404 as const, error: "no such override request" };
    if (r.device_id !== deviceId) {
      return {
        code: 403 as const,
        error: "the call on a request is with the phone that made the request, and this is not it",
      };
    }
    return { code: 200 as const, request: r };
  };

  app.post<{ Params: { id: string } }>("/overrides/:id/call/device/join", async (req, reply) => {
    const parsed = DeviceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "deviceId is required" });
    const found = await forDevice(req.params.id, parsed.data.deviceId);
    if (found.code !== 200) return reply.code(found.code).send({ error: found.error });

    await recordCall(pool, {
      requestId: found.request.id, party: "field", accountId: null,
      deviceId: parsed.data.deviceId, event: "joined",
    });
    const { operators } = rooms.deviceJoins(found.request.id);
    return reply.send({ operators, iceServers: ice.serversFor(`device-${parsed.data.deviceId}`), relay: ice.relay });
  });

  app.post<{ Params: { id: string } }>("/overrides/:id/call/device/inbox", async (req, reply) => {
    const parsed = InboxBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "deviceId is required" });
    const found = await forDevice(req.params.id, parsed.data.deviceId);
    if (found.code !== 200) return reply.code(found.code).send({ error: found.error });
    return reply.send({ signals: rooms.inbox(found.request.id, DEVICE_PARTY, parsed.data.after) });
  });

  app.post<{ Params: { id: string } }>("/overrides/:id/call/device/offer", async (req, reply) => {
    const parsed = OfferBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid offer", detail: parsed.error.issues });
    const found = await forDevice(req.params.id, parsed.data.deviceId);
    if (found.code !== 200) return reply.code(found.code).send({ error: found.error });

    if (!rooms.offer(found.request.id, parsed.data.to, parsed.data.sdp)) {
      return reply.code(409).send({ error: "that operator has not opened the call" });
    }
    // Recorded because the ledger carried it, not because the phone says so.
    await recordCall(pool, {
      requestId: found.request.id, party: "field", accountId: parsed.data.to,
      deviceId: parsed.data.deviceId, event: "offered",
    });
    return reply.code(202).send({ carried: true });
  });

  app.post<{ Params: { id: string } }>("/overrides/:id/call/device/state", async (req, reply) => {
    const parsed = DeviceStateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid state", detail: parsed.error.issues });
    const found = await forDevice(req.params.id, parsed.data.deviceId);
    if (found.code !== 200) return reply.code(found.code).send({ error: found.error });
    const b = parsed.data;

    const { rows: known } = await pool.query("select 1 from ref.account where id = $1::uuid", [b.operator]);
    if (known.length === 0) return reply.code(404).send({ error: "no such operator" });

    await recordCall(pool, {
      requestId: found.request.id, party: "field", accountId: b.operator, deviceId: b.deviceId,
      event: b.state, detail: b.seconds === undefined ? {} : { seconds: b.seconds },
    });
    return reply.code(201).send({ recorded: true });
  });

  // ── an operator ───────────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>("/overrides/:id/call/join", async (req, reply) => {
    const account = await operator(req);
    if (!account) return reply.code(401).send({ error: "Sign in to open the call." });
    const r = await request(req.params.id);
    if (!r) return reply.code(404).send({ error: "no such override request" });

    await recordCall(pool, {
      requestId: r.id, party: "operator", accountId: account.id, deviceId: null, event: "joined",
    });
    const { devicePresent } = rooms.operatorJoins(r.id, account.id, account.displayName);
    return reply.send({ you: account.id, devicePresent, iceServers: ice.serversFor(`account-${account.id}`), relay: ice.relay });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/overrides/:id/call/inbox",
    async (req, reply) => {
      const account = await operator(req);
      if (!account) return reply.code(401).send({ error: "Sign in to open the call." });
      const r = await request(req.params.id);
      if (!r) return reply.code(404).send({ error: "no such override request" });
      const after = Number(req.query.after ?? 0);
      return reply.send({
        signals: rooms.inbox(r.id, account.id, Number.isFinite(after) && after >= 0 ? after : 0),
      });
    },
  );

  app.post<{ Params: { id: string } }>("/overrides/:id/call/answer", async (req, reply) => {
    const account = await operator(req);
    if (!account) return reply.code(401).send({ error: "Sign in to open the call." });
    const parsed = AnswerBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid answer" });
    const r = await request(req.params.id);
    if (!r) return reply.code(404).send({ error: "no such override request" });

    if (!rooms.answer(r.id, account.id, parsed.data.sdp)) {
      return reply.code(409).send({ error: "the phone is not on the call, so there is nothing to answer" });
    }
    await recordCall(pool, {
      requestId: r.id, party: "operator", accountId: account.id, deviceId: null, event: "answered",
    });
    return reply.code(202).send({ carried: true });
  });

  app.post<{ Params: { id: string } }>("/overrides/:id/call/state", async (req, reply) => {
    const account = await operator(req);
    if (!account) return reply.code(401).send({ error: "Sign in to open the call." });
    const parsed = OperatorStateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid state", detail: parsed.error.issues });
    const r = await request(req.params.id);
    if (!r) return reply.code(404).send({ error: "no such override request" });
    const { state, ...detail } = parsed.data;

    await recordCall(pool, {
      requestId: r.id, party: "operator", accountId: account.id, deviceId: null, event: state, detail,
    });
    if (state === "ended") rooms.leave(r.id, account.id);
    return reply.code(201).send({ recorded: true });
  });

  app.get<{ Params: { id: string } }>("/overrides/:id/call", async (req, reply) => {
    const r = await request(req.params.id);
    if (!r) return reply.code(404).send({ error: "no such override request" });
    const rows = await loadCallRows(pool, r.id);
    const { rows: names } = await pool.query<{ id: string; display_name: string }>(
      "select id, display_name from ref.account where id = any($1::uuid[])",
      [[...new Set(rows.map((x) => x.accountId).filter((x): x is string => x !== null))]],
    );
    const nameOf = new Map(names.map((n) => [n.id, n.display_name]));
    const now = new Date();
    return reply.send({
      events: rows.map((x) => ({
        party: x.party,
        accountId: x.accountId,
        accountName: x.accountId ? (nameOf.get(x.accountId) ?? null) : null,
        event: x.event,
        detail: x.detail,
        recordedAt: x.recordedAt,
      })),
      operators: [...nameOf].map(([accountId, accountName]) => ({
        accountId,
        accountName,
        ...judgeCall(rows, accountId, now),
      })),
    });
  });
}
