import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import type { GatewayConfig } from "./config.js";
import { RateLimiter, type Taken } from "./ratelimit/limiter.js";
import { canonicalPath, matchRule, type LimitName, type Match } from "./routes/policy.js";
import { Upstream } from "./upstream.js";
import { SessionResolver, StreamTickets, bearerOf, type Account } from "./auth/session.js";
import {
  DeviceDirectory,
  NonceWindow,
  hasSignatureHeaders,
  verifySignedEvent,
  verifySignedRequest,
  type DeviceRecord,
  type DeviceVerdict,
} from "./auth/device.js";

/**
 * ── The gateway ──────────────────────────────────────────────────────────────
 *
 * Everything from outside reaches the ledger through here. For each request it
 * settles three things, in this order, and forwards only if all three hold:
 *
 *  1. **Which route is this?** The path is reduced to one canonical form and
 *     matched against the policy table. The form that was judged is the form
 *     that is forwarded.
 *  2. **Who is asking?** An operator's session, a device's signature over the
 *     request, or a device's signature on the event in the body, whichever the
 *     route calls for.
 *  3. **How often?** Counted per caller against the route's limit.
 *
 * What it does not decide is whether the act itself is allowed. That is the
 * engine's ruling, made behind this, with the attempt recorded either way.
 *
 * A refusal here carries what was found, as the engines' refusals do: which
 * header was missing, the skew in seconds, the role held against the role
 * needed. The last two hundred are kept in memory for `GET /gateway/status`.
 * They are not in the database: the gateway has no connection to it.
 */

type AccountPrincipal = { kind: "account"; account: Account; via: "bearer" | "ticket" };
type DevicePrincipal = {
  kind: "device";
  device: DeviceRecord;
  via: "request_signature" | "event_signature";
};
export type Principal = { kind: "anonymous" } | AccountPrincipal | DevicePrincipal;

export interface Refusal {
  at: string;
  method: string;
  path: string;
  ip: string;
  status: number;
  reason: string;
  detail: Record<string, unknown>;
  caller: string;
}

export interface GatewayOptions {
  config: GatewayConfig;
  now?: () => number;
  /** Fastify logger options; false turns logging off (tests). */
  logger?: boolean | { level: string };
}

const EMPTY = Buffer.alloc(0);
const ANONYMOUS: Principal = Object.freeze({ kind: "anonymous" });
const RECENT_REFUSALS = 200;

/** Headers that describe one hop and must not be copied to the next. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** What a caller may pass through to the ledger. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "authorization",
  "accept",
  "last-event-id",
  "user-agent",
] as const;

type OutHeaders = Record<string, string | string[] | number>;

const callerKey = (p: Principal, ip: string) =>
  p.kind === "account" ? `a:${p.account.id}` : p.kind === "device" ? `d:${p.device.id}` : `ip:${ip}`;

const callerLabel = (p: Principal) =>
  p.kind === "account"
    ? `account:${p.account.username}`
    : p.kind === "device"
      ? `device:${p.device.id}`
      : "anonymous";

function jsonObject(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return null;
  try {
    const v: unknown = JSON.parse(body.toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function buildGateway(opts: GatewayOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const now = opts.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();

  const app = Fastify({
    logger: opts.logger ?? { level: config.logLevel },
    // Logged here instead, one line per request, without the query string: a
    // stream ticket travels in it.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: config.trustProxy,
    // Streams are held open for minutes. Shutting down closes them rather
    // than waiting for each to reach the end of its life.
    forceCloseConnections: true,
  });

  // Bodies are signed, by the device that sent them, over their exact bytes or
  // their canonical form. The gateway never re-serialises one: it keeps the
  // bytes as they arrived and sends on the same bytes.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  await app.register(cors, {
    origin: config.corsOrigins,
    exposedHeaders: ["retry-after"],
  });

  const upstream = new Upstream(config.upstreamUrl, config.gatewaySecret);
  const limiter = new RateLimiter(now);
  const sessions = new SessionResolver(upstream, config.sessionCacheMs, now);
  const devices = new DeviceDirectory(upstream, config.deviceCacheMs, now);
  const nonces = new NonceWindow(now);
  const tickets = new StreamTickets(config.streamTicketMs, now);
  app.addHook("onClose", async () => upstream.close());

  const refusals: Refusal[] = [];
  const counts = { forwarded: 0, refused: {} as Record<string, number> };

  // ── answering without forwarding ──

  function refuse(
    req: FastifyRequest,
    reply: FastifyReply,
    path: string,
    status: number,
    reason: string,
    error: string,
    detail: Record<string, unknown> = {},
    principal: Principal = ANONYMOUS,
  ): FastifyReply {
    const entry: Refusal = {
      at: new Date(now()).toISOString(),
      method: req.method,
      path,
      ip: req.ip,
      status,
      reason,
      detail,
      caller: callerLabel(principal),
    };
    refusals.push(entry);
    if (refusals.length > RECENT_REFUSALS) refusals.shift();
    counts.refused[reason] = (counts.refused[reason] ?? 0) + 1;
    req.log.warn(entry, `refused: ${reason}`);
    return reply.code(status).send({ error, reason, ...detail });
  }

  function tooMany(
    req: FastifyRequest,
    reply: FastifyReply,
    path: string,
    limit: LimitName,
    taken: Taken,
    principal: Principal,
  ): FastifyReply {
    void reply.header("retry-after", String(taken.retryAfterSeconds));
    const spec = config.limits[limit];
    return refuse(
      req,
      reply,
      path,
      429,
      "rate_limited",
      `Too many requests. Try again in ${taken.retryAfterSeconds} s.`,
      {
        limit,
        burst: spec.burst,
        perMinute: spec.perMinute,
        retryAfterSeconds: taken.retryAfterSeconds,
      },
      principal,
    );
  }

  // ── who is asking ──

  type Refused = { refused: FastifyReply };
  type Authenticated = { principal: Principal } | Refused;

  /**
   * A credential that did not verify is counted against the address it came
   * from. Once that allowance is gone, a credential that would need checking
   * is not looked at: the point is to bound what guessing costs, and a
   * signature check or a session lookup is the cost.
   */
  const failedCredential = (req: FastifyRequest) =>
    void limiter.take("auth_fail", req.ip, config.limits.auth_fail);

  function guessingStopped(req: FastifyRequest, reply: FastifyReply, path: string): Refused | null {
    const left = limiter.peek("auth_fail", req.ip, config.limits.auth_fail);
    return left.allowed ? null : { refused: tooMany(req, reply, path, "auth_fail", left, ANONYMOUS) };
  }

  async function byBearer(
    req: FastifyRequest,
    reply: FastifyReply,
    path: string,
  ): Promise<{ principal: AccountPrincipal } | Refused> {
    const token = bearerOf(req.headers.authorization);
    if (!token) {
      return {
        refused: refuse(req, reply, path, 401, "not_signed_in", "Sign in to do this.", {
          expected: "Authorization: Bearer <session token>",
        }),
      };
    }
    // A token never seen to be good is a guess as far as this process knows,
    // and guesses stop when the address has used up its failures. A token that
    // has been good is re-checked regardless, so one person guessing does not
    // sign out everyone else behind the same address.
    if (sessions.standing(token) === "unknown") {
      const stopped = guessingStopped(req, reply, path);
      if (stopped) return stopped;
    }
    const { account, cached } = await sessions.resolve(token);
    if (!account) {
      // A browser left open past its session sends the same dead token on
      // every poll. Only the first sighting is counted.
      if (!cached) failedCredential(req);
      return {
        refused: refuse(req, reply, path, 401, "session_invalid", "This session has ended. Sign in again."),
      };
    }
    return { principal: { kind: "account", account, via: "bearer" } };
  }

  function deviceRefused(
    req: FastifyRequest,
    reply: FastifyReply,
    path: string,
    verdict: Extract<DeviceVerdict, { ok: false }>,
    what: string,
  ): Refused {
    failedCredential(req);
    return {
      refused: refuse(
        req,
        reply,
        path,
        401,
        verdict.reasons[0] ?? "signature_invalid",
        `${what} did not verify.`,
        { ...verdict.detail, findings: verdict.reasons },
      ),
    };
  }

  async function authenticate(
    req: FastifyRequest,
    reply: FastifyReply,
    match: Match,
    path: string,
    rawUrl: string,
    ticket: string | null,
    body: Buffer,
  ): Promise<Authenticated> {
    const access = match.rule.access;
    if (access === "public") return { principal: ANONYMOUS };

    if (access === "event") {
      const stopped = guessingStopped(req, reply, path);
      if (stopped) return stopped;
      const verdict = await verifySignedEvent(body, devices);
      if (!verdict.ok) return deviceRefused(req, reply, path, verdict, "The event's signature");
      return { principal: { kind: "device", device: verdict.device, via: "event_signature" } };
    }

    if (access === "stream" && ticket) {
      const account = tickets.redeem(ticket);
      if (!account) {
        failedCredential(req);
        return {
          refused: refuse(req, reply, path, 401, "ticket_invalid", "This stream ticket is spent or expired.", {
            validForSeconds: Math.round(config.streamTicketMs / 1000),
          }),
        };
      }
      return { principal: { kind: "account", account, via: "ticket" } };
    }

    if (access === "device" && !hasSignatureHeaders(req.headers)) {
      // A session is not what this route takes, however good it is: the engine
      // behind it is told which device is asking, and only that device's key
      // can say so.
      return {
        refused: refuse(
          req,
          reply,
          path,
          401,
          "device_signature_required",
          "This is done by a device: the request must be signed with the device's enrolled key.",
          { expected: "x-mohar-device, x-mohar-timestamp, x-mohar-nonce, x-mohar-signature" },
        ),
      };
    }

    if ((access === "field" || access === "device") && hasSignatureHeaders(req.headers)) {
      const stopped = guessingStopped(req, reply, path);
      if (stopped) return stopped;
      const verdict = await verifySignedRequest(
        { method: req.method, rawUrl, headers: req.headers, body },
        devices,
        nonces,
        config.clockSkewMs,
        now(),
      );
      if (!verdict.ok) return deviceRefused(req, reply, path, verdict, "The request signature");
      const device = verdict.device;
      const principal: Principal = { kind: "device", device, via: "request_signature" };

      // The signature proves which device sent this. If the request then names
      // a different device, in the body or in the path, it is one device
      // speaking as another, which is the thing the signature exists to stop.
      const named: [string, unknown][] = [
        ["body", jsonObject(body)?.["deviceId"]],
        ["path", match.params["deviceId"]],
      ];
      for (const [where, value] of named) {
        if (typeof value === "string" && value.toLowerCase() !== device.id.toLowerCase()) {
          return {
            refused: refuse(
              req,
              reply,
              path,
              403,
              "device_mismatch",
              `The request is signed by one device and names another in its ${where}.`,
              { signedBy: device.id, named: value, where },
              principal,
            ),
          };
        }
      }
      return { principal };
    }

    const signedIn = await byBearer(req, reply, path);
    if ("refused" in signedIn) return signedIn;
    const { principal } = signedIn;
    if (access === "control_room" && principal.account.role !== "control_room") {
      return {
        refused: refuse(
          req,
          reply,
          path,
          403,
          "role_not_permitted",
          "This is done by a control room operator.",
          { roleHeld: principal.account.role, roleNeeded: "control_room" },
          principal,
        ),
      };
    }
    return { principal };
  }

  // ── forwarding ──

  function forward(
    req: FastifyRequest,
    reply: FastifyReply,
    target: string,
    path: string,
    body: Buffer,
    principal: Principal,
    started: number,
    maxMs: number | null,
    /** Run once the ledger has answered, with its status. */
    onAnswered: ((status: number) => void) | null,
  ): void {
    const headers: Record<string, string> = { "x-forwarded-for": req.ip };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const v = req.headers[name];
      if (typeof v === "string") headers[name] = v;
    }

    // From here the response is written by hand, so that it can be piped as it
    // arrives. CORS headers the plugin has already set on the reply are copied
    // across; the ledger's own are dropped, because which origin may read a
    // response is this process's decision now.
    reply.hijack();
    const ours: OutHeaders = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) ours[k] = v;

    let timer: NodeJS.Timeout | null = null;
    let answered = false;
    let callerGone = false;

    const up = upstream.request(
      req.method,
      target,
      headers,
      body.length > 0 ? body : null,
      (res) => {
        answered = true;
        onAnswered?.(res.statusCode ?? 502);
        const out: OutHeaders = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k) || k.startsWith("access-control-")) continue;
          out[k] = v;
        }
        reply.raw.writeHead(res.statusCode ?? 502, { ...out, ...ours });
        res.pipe(reply.raw);
        // The ledger went away mid-response. The caller's connection is closed
        // rather than left open on a body that will never finish.
        res.on("error", () => reply.raw.destroy());
      },
      (err) => {
        if (callerGone || answered) {
          if (!reply.raw.writableEnded) reply.raw.destroy();
          return;
        }
        req.log.error({ err: err.message, path }, "the ledger is not answering");
        const payload = JSON.stringify({
          error: "The ledger is not answering.",
          reason: "upstream_unreachable",
        });
        reply.raw.writeHead(502, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(payload),
          ...ours,
        });
        reply.raw.end(payload);
      },
    );

    reply.raw.on("close", () => {
      if (timer) clearTimeout(timer);
      // The caller went away before the response finished: stop reading from
      // the ledger, or a stream would run on behind a closed connection.
      if (!reply.raw.writableFinished) {
        callerGone = true;
        up.destroy();
      }
      if (answered) counts.forwarded += 1;
      req.log.info(
        {
          method: req.method,
          path,
          status: reply.raw.statusCode,
          caller: callerLabel(principal),
          ms: now() - started,
        },
        answered ? "forwarded" : "not forwarded",
      );
    });

    if (maxMs !== null) {
      timer = setTimeout(() => {
        up.destroy();
        reply.raw.end();
      }, maxMs);
      timer.unref();
    }
  }

  // ── the gateway's own routes ──

  /** A ticket to open one stream with. See StreamTickets. */
  app.post("/gateway/stream-ticket", async (req, reply) => {
    const path = "/gateway/stream-ticket";
    const signedIn = await byBearer(req, reply, path);
    if ("refused" in signedIn) return signedIn.refused;
    const { principal } = signedIn;
    const taken = limiter.take("stream", callerKey(principal, req.ip), config.limits.stream);
    if (!taken.allowed) return tooMany(req, reply, path, "stream", taken, principal);
    return reply.code(201).send(tickets.issue(principal.account));
  });

  /** What this process has refused since it started. Memory only. */
  app.get("/gateway/status", async (req, reply) => {
    const path = "/gateway/status";
    const signedIn = await byBearer(req, reply, path);
    if ("refused" in signedIn) return signedIn.refused;
    const { principal } = signedIn;
    if (principal.account.role !== "control_room") {
      return refuse(
        req,
        reply,
        path,
        403,
        "role_not_permitted",
        "This is read by a control room operator.",
        { roleHeld: principal.account.role, roleNeeded: "control_room" },
        principal,
      );
    }
    return reply.send({
      startedAt,
      upstream: upstream.origin,
      forwarded: counts.forwarded,
      refusedByReason: counts.refused,
      limits: config.limits,
      // Newest first. Kept in memory: a restart empties it.
      recentRefusals: [...refusals].reverse(),
    });
  });

  // ── everything else is the ledger's ──

  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/*",
    handler: async (req, reply) => {
      const started = now();
      const rawUrl = req.raw.url ?? "/";
      const mark = rawUrl.indexOf("?");
      const rawPath = mark === -1 ? rawUrl : rawUrl.slice(0, mark);
      const rawQuery = mark === -1 ? "" : rawUrl.slice(mark + 1);
      const body = Buffer.isBuffer(req.body) ? req.body : EMPTY;

      const canon = canonicalPath(rawPath);
      if (!canon) {
        return refuse(
          req,
          reply,
          rawPath.slice(0, 200),
          400,
          "path_not_canonical",
          "This path has an empty, dotted or escaped segment the gateway will not interpret.",
        );
      }
      const path = canon.path;

      const perAddress = limiter.take("ip", req.ip, config.limits.ip);
      if (!perAddress.allowed) return tooMany(req, reply, path, "ip", perAddress, ANONYMOUS);

      const match = matchRule(req.method, canon.segments);

      // A stream ticket is the gateway's own credential. It is taken out of
      // the query here and the ledger never sees it; any other query string is
      // forwarded exactly as it arrived.
      let query = rawQuery;
      let ticket: string | null = null;
      if (match.rule.access === "stream" && rawQuery.includes("ticket=")) {
        const params = new URLSearchParams(rawQuery);
        ticket = params.get("ticket");
        params.delete("ticket");
        query = params.toString();
      }

      let auth: Authenticated;
      try {
        auth = await authenticate(req, reply, match, path, rawUrl, ticket, body);
      } catch (err) {
        // The lookup itself failed. That is not the caller's credential being
        // wrong, and answering 401 would sign a working operator out.
        req.log.error({ err: (err as Error).message, path }, "credential lookup failed");
        return reply.code(502).send({
          error: "The ledger is not answering.",
          reason: "upstream_unreachable",
        });
      }
      if ("refused" in auth) return auth.refused;
      const { principal } = auth;

      // ── how often ──
      const limit = match.rule.limit;
      const who = callerKey(principal, req.ip);
      const keys: string[] = [];
      if (limit === "signin") {
        // Per address and per username: one address trying many names, and
        // many addresses trying one name, are both guessing.
        const username = jsonObject(body)?.["username"];
        keys.push(`ip:${req.ip}`);
        if (typeof username === "string") keys.push(`u:${username.trim().toLowerCase().slice(0, 64)}`);
      } else if (limit === "access") {
        const b = jsonObject(body);
        const packageId = String(b?.["packageId"] ?? "-").slice(0, 64);
        const stage = String(b?.["stage"] ?? "-").slice(0, 32);
        keys.push(`${who}|${packageId}|${stage}`);
      } else {
        keys.push(who);
      }
      for (const key of keys) {
        const taken = limiter.take(limit, key, config.limits[limit]);
        if (!taken.allowed) return tooMany(req, reply, path, limit, taken, principal);
      }

      // ── things the gateway remembered that this request changes ──
      //
      // A session and a device's key are each kept for a few seconds. Signing
      // out, revoking a device and disabling an account must not wait those
      // seconds out, so what was remembered is dropped: before forwarding for a
      // sign-out, and once the ledger has said yes for the other two.
      const seg = canon.segments;
      let onAnswered: ((status: number) => void) | null = null;
      if (req.method === "POST" && path === "/auth/signout") {
        const token = bearerOf(req.headers.authorization);
        if (token) sessions.forget(token);
      } else if (req.method === "POST" && seg.length === 3 && seg[0] === "devices" && seg[2] === "revoke") {
        onAnswered = (status) => void (status < 300 && devices.forget(seg[1] ?? ""));
      } else if (
        req.method === "POST" &&
        seg.length === 4 &&
        seg[0] === "auth" &&
        seg[1] === "accounts" &&
        seg[3] === "disable"
      ) {
        onAnswered = (status) => void (status < 300 && sessions.forgetAccount(seg[2] ?? ""));
      }

      forward(
        req,
        reply,
        query ? `${path}?${query}` : path,
        path,
        body,
        principal,
        started,
        match.rule.access === "stream" ? config.streamMaxMs : null,
        onAnswered,
      );
      return reply;
    },
  });

  return app;
}
