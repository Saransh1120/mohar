import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

/**
 * ── The ledger behind its gateway ────────────────────────────────────────────
 *
 * `services/gateway` decides who may call which route. That decision only
 * holds if the gateway is the one way in, and there are two ways to make it so:
 *
 *  - **Bind to loopback** (`HOST=127.0.0.1`). Nothing off this machine can
 *    reach the ledger at all. This is the arrangement when both processes run
 *    on one host, and it needs no secret.
 *  - **Share a secret** (`GATEWAY_SECRET`, the same value in both processes).
 *    The ledger then answers only requests that carry it. This is for when the
 *    ledger has to listen on a network interface: another machine, or a host
 *    that will not route to a loopback port.
 *
 * With neither, every route here is open to whoever can reach the port, exactly
 * as it was before the gateway existed, and the ledger says so when it starts.
 * The secret is a shared one over plain HTTP. It keeps a neighbour on the same
 * network from walking around the gateway; it is not mTLS and does not claim to
 * be.
 */

export const GATEWAY_SECRET_HEADER = "x-mohar-gateway";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function listenHost(env: NodeJS.ProcessEnv): string {
  return env["HOST"] || "0.0.0.0";
}

/**
 * Whose `X-Forwarded-For` to believe. By default only a peer on loopback, which
 * is where the gateway is: without this every caller would look like 127.0.0.1
 * and share one sign-in allowance.
 */
export function trustedProxies(env: NodeJS.ProcessEnv): boolean | string {
  const v = env["TRUST_PROXY"];
  if (v === undefined || v === "") return "127.0.0.1,::1";
  if (v === "false") return false;
  return v === "true" ? true : v;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Refuse anything that does not carry the gateway's secret, when one is set. */
export function registerGatewayGuard(app: FastifyInstance, env: NodeJS.ProcessEnv): void {
  const secret = env["GATEWAY_SECRET"];
  if (!secret) return;
  const expected = digest(secret);
  app.addHook("onRequest", async (req, reply) => {
    const offered = req.headers[GATEWAY_SECRET_HEADER];
    // Hashed first so the comparison is over equal lengths whatever was sent.
    if (typeof offered === "string" && timingSafeEqual(digest(offered), expected)) return;
    req.log.warn({ ip: req.ip, path: req.url.split("?")[0] }, "refused: not from the gateway");
    return reply.code(401).send({
      error: "This ledger answers only to its gateway.",
      reason: "not_from_gateway",
    });
  });
}

/** What to say at boot about who can reach this process. Null when it is closed off. */
export function exposureWarning(env: NodeJS.ProcessEnv): string | null {
  if (env["GATEWAY_SECRET"] || LOOPBACK.has(listenHost(env))) return null;
  return (
    `listening on ${listenHost(env)} with no GATEWAY_SECRET: every route is open, without ` +
    "sign-in, to anything that can reach this port. Set HOST=127.0.0.1 and put " +
    "services/gateway in front, or set GATEWAY_SECRET in both."
  );
}

// ── what the gateway established about the device ───────────────────────────

/** Written by the gateway on a request whose device signature it verified. */
export const VERIFIED_DEVICE_HEADER = "x-mohar-verified-device";

export interface DeviceProof {
  /** Undefined where nothing can be said either way. Not said is not passed. */
  passed: boolean | undefined;
  evidence: string;
}

/**
 * Whether the request an engine is ruling on was signed by the device it names.
 *
 * The gateway checks that signature and refuses the request if it fails, so an
 * engine behind it only ever sees requests that passed. But the engine's record
 * is read later by someone who was not there, and "the device is enrolled" is
 * all it said. This puts the other half on the record: that the request was
 * signed with that device's key, and who established it.
 *
 * It is believed only where the ledger can tell the gateway from anybody else,
 * which is when the two share GATEWAY_SECRET. On loopback with no secret the
 * header could have been written by any process on the machine, and the check
 * says so instead of passing. A ledger reached directly sees no header at all.
 */
export function deviceProof(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  env: Readonly<Record<string, string | undefined>>,
  deviceId: string,
): DeviceProof {
  const claimed = headers[VERIFIED_DEVICE_HEADER];
  if (typeof claimed !== "string" || claimed === "") {
    return {
      passed: undefined,
      evidence:
        "not evaluated: this request did not come through the gateway's device signature check " +
        "(the ledger was reached directly, or the route took a session)",
    };
  }
  if (!env["GATEWAY_SECRET"]) {
    return {
      passed: undefined,
      evidence:
        `not evaluated: a caller says the gateway verified device ${claimed}'s signature, but this ` +
        "ledger shares no secret with its gateway and cannot tell it from another process on this machine",
    };
  }
  if (claimed.toLowerCase() !== deviceId.toLowerCase()) {
    return {
      passed: false,
      evidence: `the gateway verified a request signed by device ${claimed}; this request names device ${deviceId}`,
    };
  }
  return {
    passed: true,
    evidence: `the gateway verified this request's signature against device ${deviceId}'s enrolled key`,
  };
}
