import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { accountForToken } from "../domain/accounts.js";
import { bearerToken } from "./auth-routes.js";
import { VERIFIED_DEVICE_HEADER } from "./gateway-guard.js";

/**
 * ── An account limited to named centres ──────────────────────────────────────
 *
 * An account with rows in `ref.account_centre` sees only those centres. That
 * is easy to say and easy to get half right: filter the three pages someone
 * thought of and leave the fourth showing everything. So the rule here is the
 * other way round. A limited account can reach only the routes listed below,
 * each of which filters by centre, and every other route refuses it. A route
 * added later is closed to limited accounts until somebody lists it and makes
 * it filter.
 *
 * A limited account changes nothing: no route that writes is on the list.
 *
 * The gateway applies the same list before the request gets here
 * (`openToScoped` in its policy), which also covers what the ledger cannot
 * see: a live stream arrives without the account's token. This guard is the
 * ledger holding the line for itself.
 *
 * A device's signed request carries no account and is not this guard's
 * business; neither is a request with no token at all.
 */

/** Method and route pattern, as Fastify names the route. */
export const OPEN_TO_SCOPED: ReadonlySet<string> = new Set([
  "GET /packages",
  "GET /packages/:id",
  "GET /legs",
  "GET /alerts",
  "GET /alerts/summary",
  "GET /exams",
  // Knowing who you are and leaving are not centre data.
  "GET /auth/me",
  "GET /auth/config",
  "POST /auth/signout",
  "GET /health",
  "GET /ping",
  // What anybody may read with no account at all.
  "GET /anchors",
  "GET /counters",
  "GET /verify/inclusion/:eventId",
  "POST /public/seam-scan",
]);

declare module "fastify" {
  interface FastifyRequest {
    /** The centres this request's account is limited to, or null for no limit. */
    centreScope: string[] | null;
  }
}

/** The centres a request is limited to, for a route that filters. Null is no limit. */
export function centreScope(req: FastifyRequest): string[] | null {
  return req.centreScope ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The centre a signed request's device is enrolled at, as a scope.
 *
 * A device enrolled at a centre reads that centre's rows; one enrolled with no
 * centre (a courier's phone that travels between them, the ledger's own
 * service key) is not limited. Which device signed is what the gateway says it
 * verified. Without GATEWAY_SECRET that header is only a claim, but acting on
 * it here can only narrow what is returned, never widen it, so it is used
 * either way. A request with no such header is not a device's and gets null.
 */
export async function deviceCentreScope(req: FastifyRequest, pool: Pool): Promise<string[] | null> {
  const claimed = req.headers[VERIFIED_DEVICE_HEADER];
  if (typeof claimed !== "string" || !UUID.test(claimed)) return null;
  const { rows } = await pool.query<{ centre_id: string | null }>(
    "select centre_id from ref.device where id = $1::uuid",
    [claimed],
  );
  const centre = rows[0]?.centre_id;
  return centre ? [centre] : null;
}

export function registerScopeGuard(app: FastifyInstance, pool: Pool): void {
  app.decorateRequest("centreScope", null);
  app.addHook("preHandler", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return;
    const account = await accountForToken(pool, token);
    if (!account || account.centreIds.length === 0) return;

    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
    if (!OPEN_TO_SCOPED.has(route)) {
      req.log.warn({ username: account.username, route }, "refused: account is limited to its centres");
      return reply.code(403).send({
        error:
          "This account is limited to its own centres. It can read their packets, hand-offs and " +
          "alerts, and nothing else.",
        reason: "account_scoped",
      });
    }
    req.centreScope = account.centreIds;
  });
}
