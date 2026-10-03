/**
 * Sign-up, sign-in, sign-out, "who am I", and the accounts an operator keeps.
 *
 * The credential store is here because `ref.account` and `ref.session` are the
 * ledger's tables. `services/gateway` sits in front and asks this process who a
 * token belongs to (`GET /auth/me`); it holds no database credential of its
 * own. Nothing below reaches into the ledger chain.
 *
 * What this does NOT do: it does not decide who may enrol a device, issue a key
 * or append an event. That is the gateway's table (services/gateway/src/routes/
 * policy.ts). The three account routes at the bottom do check the caller's role
 * themselves, because creating an operator is not something to leave to
 * whoever can reach this port.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { withTransaction } from "../db.js";
import {
  AuthError,
  ACCOUNT_ROLES,
  SESSION_TTL_HOURS,
  accountCount,
  accountForToken,
  createAccount,
  disableAccount,
  listAccounts,
  signIn,
  signOut,
  type Account,
} from "../domain/accounts.js";

/**
 * Whether anybody may register.
 *
 * Closed unless ALLOW_SIGNUP=true. The one exception is a system with no
 * accounts at all: the first sign-up claims it, as a control room operator.
 * After that, accounts are created by an operator (`POST /auth/accounts`).
 *
 * Open registration with a role chooser means anyone who can reach the page is
 * a control room operator a minute later, and every check the gateway makes
 * on a role is then a check on what the visitor typed.
 */
const SIGNUP_ALWAYS_OPEN = process.env["ALLOW_SIGNUP"] === "true";

/**
 * Throttle sign-in by username and by source address.
 *
 * scrypt already makes guessing expensive for the attacker, but it makes it
 * expensive for this process too — an unthrottled sign-in endpoint is a
 * self-inflicted denial of service. Ten attempts per five minutes per key,
 * counted in memory because a single-process dev service is what this is.
 * The gateway limits the same thing before a request gets here; this stays as
 * the limit for a ledger reached without one.
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
  reason?: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerAuthRoutes(app: FastifyInstance, pool: Pool): void {
  /**
   * What the sign-in screen needs before anyone types anything: whether
   * registration is open, and whether this is a fresh system with no accounts.
   */
  app.get("/auth/config", async () => {
    const accounts = await accountCount(pool);
    return {
      signUpOpen: SIGNUP_ALWAYS_OPEN || accounts === 0,
      accounts,
      roles: ACCOUNT_ROLES,
      sessionHours: SESSION_TTL_HOURS,
    };
  });

  app.post("/auth/signup", async (req, reply) => {
    const body = (req.body ?? {}) as Body;

    try {
      const account = await withTransaction(pool, async (tx) => {
        // One sign-up at a time, so two requests cannot both find "no accounts
        // yet" and both claim the system.
        await tx.query("select pg_advisory_xact_lock(hashtext('auth:signup'))");
        const first = (await accountCount(tx)) === 0;
        if (!first && !SIGNUP_ALWAYS_OPEN) {
          throw new AuthError(
            403,
            "Registration is closed. A control room operator creates accounts.",
          );
        }
        return createAccount(tx, {
          username: String(body.username ?? ""),
          password: String(body.password ?? ""),
          displayName: String(body.displayName ?? ""),
          // The first account is the operator, whatever was asked for: nobody
          // else can create the accounts that follow.
          ...(first
            ? { role: "control_room" }
            : typeof body.role === "string"
              ? { role: body.role }
              : {}),
        });
      });

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

  // ── accounts, kept by a control room operator ─────────────────────────────

  /** The caller, if they are a signed-in control room operator. Otherwise answers and returns null. */
  async function operator(req: FastifyRequest, reply: FastifyReply): Promise<Account | null> {
    const account = await accountForToken(pool, bearerToken(req));
    if (!account) {
      void reply.code(401).send({ error: "Not signed in." });
      return null;
    }
    if (account.role !== "control_room") {
      void reply.code(403).send({ error: "Accounts are kept by a control room operator." });
      return null;
    }
    return account;
  }

  app.get("/auth/accounts", async (req, reply) => {
    if (!(await operator(req, reply))) return reply;
    return reply.send({ accounts: await listAccounts(pool) });
  });

  /** Create an account for someone else. It does not sign them in. */
  app.post("/auth/accounts", async (req, reply) => {
    const by = await operator(req, reply);
    if (!by) return reply;
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
      req.log.info(
        { username: account.username, role: account.role, createdBy: by.username },
        "account created by an operator",
      );
      return reply.code(201).send({ account });
    } catch (err) {
      if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/auth/accounts/:id/disable", async (req, reply) => {
    const by = await operator(req, reply);
    if (!by) return reply;
    if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "No such account." });
    const reason = String(((req.body ?? {}) as Body).reason ?? "").trim();
    if (reason.length < 3 || reason.length > 300) {
      return reply.code(400).send({ error: "Say why the account is being disabled." });
    }
    try {
      await withTransaction(pool, (tx) => disableAccount(tx, req.params.id, reason));
      req.log.warn({ accountId: req.params.id, disabledBy: by.username, reason }, "account disabled");
      return reply.send({ status: "disabled", id: req.params.id });
    } catch (err) {
      if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });
}
