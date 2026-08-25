/**
 * Sign-up, sign-in, sign-out, and "who am I".
 *
 * These endpoints belong in `gateway` (docs/02-architecture.md), which does not
 * exist yet. They live here so the control room has a real credential check
 * instead of an open door, and they are written so that moving them later is a
 * copy rather than a rewrite: nothing below reaches into the ledger chain.
 *
 * What this does NOT do: it does not authenticate device enrolment or event
 * append. Those remain open (see registry-routes.ts), so the ledger API still
 * must not be exposed beyond localhost until the gateway lands.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { withTransaction } from "../db.js";
import {
  AuthError,
  ACCOUNT_ROLES,
  SESSION_TTL_HOURS,
  accountCount,
  accountForToken,
  createAccount,
  signIn,
  signOut,
} from "../domain/accounts.js";

/** Whether new accounts may be created. Set ALLOW_SIGNUP=false to close it. */
const SIGNUP_OPEN = process.env["ALLOW_SIGNUP"] !== "false";

/**
 * Throttle sign-in by username and by source address.
 *
 * scrypt already makes guessing expensive for the attacker, but it makes it
 * expensive for this process too — an unthrottled sign-in endpoint is a
 * self-inflicted denial of service. Ten attempts per five minutes per key,
 * counted in memory because a single-process dev service is what this is.
 */
const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

function clearAttempts(key: string): void {
  attempts.delete(key);
}

/** Bearer token from the Authorization header, if there is one. */
export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

interface Body {
  username?: unknown;
  password?: unknown;
  displayName?: unknown;
  role?: unknown;
}

export function registerAuthRoutes(app: FastifyInstance, pool: Pool): void {
  /**
   * What the sign-in screen needs before anyone types anything: whether
   * registration is open, and whether this is a fresh system with no accounts.
   */
  app.get("/auth/config", async () => ({
    signUpOpen: SIGNUP_OPEN,
    accounts: await accountCount(pool),
    roles: ACCOUNT_ROLES,
    sessionHours: SESSION_TTL_HOURS,
  }));

  app.post("/auth/signup", async (req, reply) => {
    if (!SIGNUP_OPEN) {
      return reply.code(403).send({ error: "Registration is closed on this deployment." });
    }
    const body = (req.body ?? {}) as Body;

    try {
      const account = await withTransaction(pool, (tx) =>
        createAccount(tx, {
          username: String(body.username ?? ""),
          password: String(body.password ?? ""),
          displayName: String(body.displayName ?? ""),
          ...(typeof body.role === "string" ? { role: body.role } : {}),
        }),
      );

      // Signing up signs you in. Making someone type the same credentials twice
      // teaches nothing and is where people mistype the password they just set.
      const session = await withTransaction(pool, (tx) =>
        signIn(
          tx,
          account.username,
          String(body.password ?? ""),
          req.headers["user-agent"] ?? null,
        ),
      );
      req.log.info({ username: account.username, role: account.role }, "account created");
      return reply.code(201).send(session);
    } catch (err) {
      if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.post("/auth/signin", async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const username = String(body.username ?? "").trim();
    const ip = req.ip;

    if (tooManyAttempts(`u:${username.toLowerCase()}`) || tooManyAttempts(`ip:${ip}`)) {
      return reply
        .code(429)
        .send({ error: "Too many sign-in attempts. Wait five minutes and try again." });
    }

    try {
      const session = await withTransaction(pool, (tx) =>
        signIn(tx, username, String(body.password ?? ""), req.headers["user-agent"] ?? null),
      );
      clearAttempts(`u:${username.toLowerCase()}`);
      clearAttempts(`ip:${ip}`);
      req.log.info({ username: session.account.username }, "signed in");
      return reply.code(200).send(session);
    } catch (err) {
      if (err instanceof AuthError) {
        req.log.warn({ username, status: err.status }, "sign-in refused");
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/auth/signout", async (req, reply) => {
    await signOut(pool, bearerToken(req));
    return reply.code(200).send({ ok: true });
  });

  /** Resolve the caller's token. 401 means "not signed in", not "server error". */
  app.get("/auth/me", async (req, reply) => {
    const account = await accountForToken(pool, bearerToken(req));
    if (!account) return reply.code(401).send({ error: "Not signed in." });
    return reply.code(200).send({ account });
  });
}
