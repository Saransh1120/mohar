import { createHmac } from "node:crypto";

/**
 * ── A relay for the override's video call ────────────────────────────────────
 *
 * The call goes phone to browser directly when the two networks allow it. Many
 * do not: a campus or office network that only lets traffic out, on both ends,
 * leaves the two with no path to each other. A TURN relay is a server both can
 * reach, which passes the encrypted media between them. It carries the call
 * and cannot read it: the media is encrypted end to end between the two
 * browsers, and the relay holds none of the keys.
 *
 * The relay is one we run (coturn; see infra/docker/compose.turn.yml), not a
 * rented service. It takes short-lived credentials made from a secret it
 * shares with this ledger, in the form coturn calls `use-auth-secret`:
 *
 *   username   = <unix time the credential expires>:<who it was issued to>
 *   credential = base64(HMAC-SHA1(secret, username))
 *
 * So nothing long-lived reaches a phone or a browser: each end of each call is
 * handed a credential that stops working within the hour, tied to the account
 * or device it was issued to.
 *
 * Configured with TURN_URLS and TURN_SECRET. With either missing, no relay is
 * offered and the call is direct or not at all, as before.
 */

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const DEFAULT_STUN: readonly IceServer[] = Object.freeze([
  { urls: "stun:stun.l.google.com:19302" },
]);

const DEFAULT_TTL_S = 3600;

export interface TurnCredential {
  username: string;
  credential: string;
  expiresAt: Date;
}

/** A credential the relay will accept until it expires. */
export function turnCredential(
  secret: string,
  issuedTo: string,
  now: Date = new Date(),
  ttlSeconds: number = DEFAULT_TTL_S,
): TurnCredential {
  const expires = Math.floor(now.getTime() / 1000) + ttlSeconds;
  // The relay splits the username at the first colon; what follows must not
  // contain one.
  const username = `${expires}:${issuedTo.replace(/:/g, "-")}`;
  return {
    username,
    credential: createHmac("sha1", secret).update(username).digest("base64"),
    expiresAt: new Date(expires * 1000),
  };
}

export interface IceConfig {
  /** True when a relay is among the servers handed out. */
  relay: boolean;
  problems: string[];
  serversFor: (issuedTo: string, now?: Date) => IceServer[];
}

/**
 * What to hand each end of a call, from the environment.
 *
 * CALL_ICE_SERVERS replaces the default STUN server (a JSON array). TURN_URLS
 * is a comma-separated list of `turn:` or `turns:` addresses. A setting that
 * cannot be used is reported in `problems` and left out, rather than handed to
 * a browser that would fail on it in the middle of a call.
 */
export function iceConfig(env: Readonly<Record<string, string | undefined>>): IceConfig {
  const problems: string[] = [];

  let stun: IceServer[] = [...DEFAULT_STUN];
  const raw = env["CALL_ICE_SERVERS"];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) stun = parsed as IceServer[];
      else problems.push("CALL_ICE_SERVERS is not a JSON array; the default STUN server is used");
    } catch {
      problems.push("CALL_ICE_SERVERS is not valid JSON; the default STUN server is used");
    }
  }

  const urls = (env["TURN_URLS"] ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const bad = urls.filter((u) => !/^turns?:[^\s]+$/.test(u));
  if (bad.length > 0) problems.push(`TURN_URLS has entries that are not turn: or turns: addresses: ${bad.join(", ")}`);
  const good = urls.filter((u) => !bad.includes(u));

  const secret = env["TURN_SECRET"] ?? "";
  if (good.length > 0 && !secret) problems.push("TURN_URLS is set without TURN_SECRET; no relay is offered");
  if (secret && good.length === 0) problems.push("TURN_SECRET is set without a usable TURN_URLS; no relay is offered");
  if (secret && secret.length < 16) problems.push("TURN_SECRET is shorter than 16 characters");

  const ttl = Number(env["TURN_TTL_S"] ?? DEFAULT_TTL_S);
  const ttlSeconds = Number.isInteger(ttl) && ttl >= 60 && ttl <= 86_400 ? ttl : DEFAULT_TTL_S;
  if (env["TURN_TTL_S"] && ttlSeconds !== ttl) problems.push("TURN_TTL_S must be 60 to 86400 seconds; one hour is used");

  const relay = good.length > 0 && secret.length > 0;
  return {
    relay,
    problems,
    serversFor: (issuedTo, now = new Date()) => {
      if (!relay) return stun;
      const c = turnCredential(secret, issuedTo, now, ttlSeconds);
      return [...stun, { urls: good, username: c.username, credential: c.credential }];
    },
  };
}
