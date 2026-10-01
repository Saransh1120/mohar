import { createHash, randomBytes } from "node:crypto";
import type { Upstream } from "../upstream.js";

/**
 * ── Who a bearer token belongs to ────────────────────────────────────────────
 *
 * The credential store is the ledger's (`ref.account`, `ref.session`), so the
 * gateway asks it: `GET /auth/me` with the caller's token. The answer is kept
 * for a few seconds, keyed by the token's SHA-256, so a page that polls four
 * endpoints does not cost four lookups.
 *
 * A token that did not resolve is remembered as well, for a little longer. A
 * browser left open past its session keeps polling with the dead token, and
 * without this every one of those polls would be a database read.
 *
 * The cost of the cache is that a session revoked elsewhere stays usable here
 * until its entry expires. Signing out through the gateway drops the entry at
 * once; an account disabled in the database is refused within `ttlMs`.
 */

export interface Account {
  id: string;
  username: string;
  displayName: string;
  role: string;
}

export interface Resolved {
  account: Account | null;
  /** True when no lookup was made: the answer came from the cache. */
  cached: boolean;
}

const NEGATIVE_TTL_MS = 30_000;

export function bearerOf(header: string | string[] | undefined): string | null {
  if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 && token.length <= 512 ? token : null;
}

const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");

function asAccount(json: unknown): Account | null {
  const a = (json as { account?: Record<string, unknown> } | null)?.account;
  if (
    !a ||
    typeof a["id"] !== "string" ||
    typeof a["username"] !== "string" ||
    typeof a["role"] !== "string"
  ) {
    return null;
  }
  return {
    id: a["id"],
    username: a["username"],
    displayName: typeof a["displayName"] === "string" ? a["displayName"] : a["username"],
    role: a["role"],
  };
}

export class SessionResolver {
  private readonly cache = new Map<string, { account: Account | null; until: number }>();

  constructor(
    private readonly upstream: Upstream,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether resolving this token is free, and whether it has ever been good.
   *
   * "known" means it resolved to an account before, even if that answer has
   * since gone stale and must be asked for again. Somebody guessing tokens
   * cannot get one into that state, which is what lets a working operator keep
   * being re-checked while guesses from the same address are being refused.
   */
  standing(token: string): "fresh" | "known" | "unknown" {
    const hit = this.cache.get(fingerprint(token));
    if (!hit) return "unknown";
    if (hit.until > this.now()) return "fresh";
    return hit.account ? "known" : "unknown";
  }

  async resolve(token: string): Promise<Resolved> {
    const key = fingerprint(token);
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return { account: hit.account, cached: true };

    const res = await this.upstream.getJson("/auth/me", { authorization: `Bearer ${token}` });
    // Only a clear answer is cached. A 5xx is the ledger failing, not the
    // token being wrong, and must not sign anyone out for thirty seconds.
    if (res.status !== 200 && res.status !== 401 && res.status !== 403) {
      throw new Error(`the ledger answered ${res.status} to a session lookup`);
    }
    const account = res.status === 200 ? asAccount(res.json) : null;
    if (this.cache.size > 10_000) this.prune();
    this.cache.set(key, {
      account,
      until: this.now() + (account ? this.ttlMs : NEGATIVE_TTL_MS),
    });
    return { account, cached: false };
  }

  forget(token: string): void {
    this.cache.delete(fingerprint(token));
  }

  /** Drop every remembered session of one account: it has just been disabled. */
  forgetAccount(accountId: string): void {
    for (const [k, v] of this.cache) if (v.account?.id === accountId) this.cache.delete(k);
  }

  private prune(): void {
    // Entries a minute past their time. Stale ones younger than that are kept
    // on purpose: see `standing`.
    const cutoff = this.now() - 60_000;
    for (const [k, v] of this.cache) if (v.until <= cutoff) this.cache.delete(k);
    // Still full of live entries: drop the lot. The next request re-resolves.
    if (this.cache.size > 10_000) this.cache.clear();
  }
}

/**
 * ── Stream tickets ───────────────────────────────────────────────────────────
 *
 * `EventSource` cannot send an Authorization header, and a session token does
 * not belong in a URL: URLs are logged, cached and shown in history. So a
 * signed-in page asks for a ticket and opens the stream with that instead.
 *
 * A ticket is random, good for one stream, and dead thirty seconds after it
 * was issued whether or not it was used. What reaches a log is something that
 * has already been spent.
 */
export class StreamTickets {
  private readonly open = new Map<string, { account: Account; until: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  issue(account: Account): { ticket: string; expiresAt: string } {
    const now = this.now();
    for (const [k, v] of this.open) if (v.until <= now) this.open.delete(k);
    const ticket = randomBytes(24).toString("base64url");
    const until = now + this.ttlMs;
    this.open.set(fingerprint(ticket), { account, until });
    return { ticket, expiresAt: new Date(until).toISOString() };
  }

  /** The account the ticket was issued to, once. Null if unknown, spent or expired. */
  redeem(ticket: string): Account | null {
    const key = fingerprint(ticket);
    const entry = this.open.get(key);
    if (!entry) return null;
    this.open.delete(key);
    return entry.until > this.now() ? entry.account : null;
  }
}
