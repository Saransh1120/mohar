import type { LimitSpec } from "./ratelimit/limiter.js";
import type { LimitName } from "./routes/policy.js";

/**
 * The limits, and what each one is protecting.
 *
 * Chosen against what the system actually sends. The control room polls four
 * endpoints every ten seconds and a page or two on top, about forty reads a
 * minute; a room monitor sends a heartbeat every thirty seconds. Everything
 * below leaves several times that, and stops well short of what a script
 * would send.
 */
export const DEFAULT_LIMITS: Readonly<Record<LimitName, LimitSpec>> = Object.freeze({
  /** Every request from one address, before anything is checked. */
  ip: { burst: 600, perMinute: 1200 },
  /** Credentials from one address that did not verify. Bounds what guessing costs this process. */
  auth_fail: { burst: 20, perMinute: 10 },
  anon: { burst: 60, perMinute: 60 },
  /** Per address and per username. scrypt makes each try expensive for the server too. */
  signin: { burst: 10, perMinute: 2 },
  signup: { burst: 5, perMinute: 0.2 },
  read: { burst: 300, perMinute: 600 },
  write: { burst: 60, perMinute: 60 },
  /** A door, a hand-off step, a ceremony step. People do these at human speed. */
  field: { burst: 30, perMinute: 30 },
  /**
   * Per caller, per packet, per stage. A custody key is valid for a six-hour
   * epoch; at one try a minute after the first five that is 365 guesses in an
   * epoch, each one a row in led.access_attempt.
   */
  access: { burst: 5, perMinute: 1 },
  key_issue: { burst: 20, perMinute: 20 },
  enrol: { burst: 20, perMinute: 2 },
  account_admin: { burst: 10, perMinute: 2 },
  /** Per device. A phone draining an offline queue sends batches, not thousands of posts. */
  events: { burst: 120, perMinute: 240 },
  /** Tickets and streams. A page opens two or three, and again each time one drops. */
  stream: { burst: 60, perMinute: 60 },
});

export interface GatewayConfig {
  port: number;
  host: string;
  /** Where the ledger listens. Loopback unless it is on another machine. */
  upstreamUrl: string;
  /** Sent to the ledger on every forwarded request, when the ledger demands one. */
  gatewaySecret: string | null;
  corsOrigins: string[];
  /** Whose X-Forwarded-For to believe. False: nobody's; the peer address is the caller. */
  trustProxy: boolean | string;
  /** How far a device's clock may differ from this one on a signed request. */
  clockSkewMs: number;
  sessionCacheMs: number;
  deviceCacheMs: number;
  streamTicketMs: number;
  /** A stream is closed after this long, so its session is checked again on reconnect. */
  streamMaxMs: number;
  limits: Record<LimitName, LimitSpec>;
  logLevel: string;
}

/** `true`, or the addresses or CIDR ranges of the proxies in front, comma separated. */
function trustProxyFrom(v: string | undefined): boolean | string {
  if (v === undefined || v === "" || v === "false") return false;
  return v === "true" ? true : v;
}

function limitsFrom(v: string | undefined): Record<LimitName, LimitSpec> {
  const limits: Record<LimitName, LimitSpec> = { ...DEFAULT_LIMITS };
  if (!v) return limits;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    throw new Error("GATEWAY_LIMITS is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("GATEWAY_LIMITS must be an object");
  for (const [name, spec] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(name in DEFAULT_LIMITS)) throw new Error(`GATEWAY_LIMITS names an unknown limit "${name}"`);
    const s = spec as { burst?: unknown; perMinute?: unknown };
    if (
      typeof s?.burst !== "number" ||
      typeof s?.perMinute !== "number" ||
      !(s.burst >= 1) ||
      !(s.perMinute >= 0)
    ) {
      throw new Error(`GATEWAY_LIMITS.${name} needs burst >= 1 and perMinute >= 0`);
    }
    limits[name as LimitName] = { burst: s.burst, perMinute: s.perMinute };
  }
  return limits;
}

export function configFromEnv(env: NodeJS.ProcessEnv): GatewayConfig {
  return {
    port: Number(env["GATEWAY_PORT"] ?? env["PORT"] ?? 8080),
    host: env["GATEWAY_HOST"] ?? "0.0.0.0",
    // 127.0.0.1, not localhost: Node may resolve localhost to ::1 first, and a
    // ledger bound to 127.0.0.1 does not answer there.
    upstreamUrl: env["LEDGER_URL"] ?? "http://127.0.0.1:8081",
    gatewaySecret: env["GATEWAY_SECRET"] || null,
    corsOrigins: (env["CORS_ORIGINS"] ?? "http://localhost:5173")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    trustProxy: trustProxyFrom(env["TRUST_PROXY"]),
    clockSkewMs: Number(env["ACCESS_CLOCK_SKEW_SECONDS"] ?? 120) * 1000,
    sessionCacheMs: 15_000,
    deviceCacheMs: 10_000,
    streamTicketMs: 30_000,
    streamMaxMs: 10 * 60_000,
    limits: limitsFrom(env["GATEWAY_LIMITS"]),
    logLevel: env["LOG_LEVEL"] ?? "info",
  };
}
