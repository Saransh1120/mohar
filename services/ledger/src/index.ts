import Fastify from "fastify";
import cors from "@fastify/cors";
import { createPool, assertAppendOnly, LedgerPrivilegeError } from "./db.js";
import { registerRoutes } from "./http/routes.js";
import { registerRegistryRoutes } from "./http/registry-routes.js";
import { registerAccessRoutes } from "@mohar/access";
import { registerAccessProxy } from "./http/access-proxy.js";
import { registerAuthRoutes } from "./http/auth-routes.js";
import {
  exposureWarning,
  listenHost,
  registerGatewayGuard,
  trustedProxies,
} from "./http/gateway-guard.js";
import { registerScopeGuard } from "./http/scope-guard.js";
import { registerTransferRoutes } from "./http/transfer-routes.js";
import { registerWebAuthnRoutes } from "./http/webauthn-routes.js";
import { registerDemoRoutes } from "./http/demo-routes.js";
import { registerAlertRoutes } from "./http/alert-routes.js";
import { registerSealRoutes } from "./http/seal-routes.js";
import { registerPublicScanRoutes } from "./http/public-scan-routes.js";
import { registerStrongroomRoutes } from "./http/strongroom-routes.js";
import { registerOverrideRoutes } from "./http/override-routes.js";
import { registerOpeningRoutes } from "./http/opening-routes.js";
import { startWatchdog } from "./domain/watchdog.js";
import { channelsFromEnv, startNotifier } from "@mohar/notify";
import { sweepAnchors } from "./anchor.js";

const PORT = Number(process.env["PORT"] ?? 8081);
const DATABASE_URL = process.env["DATABASE_URL"];
/**
 * How often to look for late legs and unopened packets. 0 turns the sweep off
 * in this process.
 */
const LEG_WATCHDOG_MS = Number(process.env["LEG_WATCHDOG_MS"] ?? 30_000);
/** How often to send out alerts nobody has been told about yet. 0 turns it off. */
const NOTIFY_MS = Number(process.env["NOTIFY_MS"] ?? 5_000);

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required. Copy .env.example and set it.");
  process.exit(1);
}

const app = Fastify({
  logger: { level: process.env["LOG_LEVEL"] ?? "info" },
  // Bodies are signed. A proxy or body-parser that reorders or re-encodes JSON
  // would invalidate every signature, so we keep Fastify's default parser and
  // never mutate req.body before verification.
  bodyLimit: 2 * 1024 * 1024,
  trustProxy: trustedProxies(process.env),
});

const pool = createPool(DATABASE_URL);
let stopWatchdog: (() => void) | null = null;
let stopNotifier: (() => void) | null = null;
let anchorTimer: ReturnType<typeof setInterval> | null = null;

async function main(): Promise<void> {
  // Refuse to start if this connection could rewrite history. The append-only
  // guarantee is a database grant, not a promise made by this code, and running
  // as the wrong role would discard it silently.
  try {
    await assertAppendOnly(pool);
  } catch (err) {
    if (err instanceof LedgerPrivilegeError) {
      app.log.fatal(err.message);
      process.exit(1);
    }
    throw err;
  }

  // The control room normally reaches this through Vite's /api proxy and is
  // therefore same-origin; this grant is for calling the API straight from a
  // browser tab, which is what a Netlify (or any other) frontend does. CORS
  // is not an access-control boundary — it stops another site's JavaScript
  // from riding a visitor's browser to this API, nothing more. A direct HTTP
  // client (curl, Postman, another server) ignores it entirely. Who may call
  // what is decided in `services/gateway`, not here: this process checks no
  // credential of its own beyond the signature on an event.
  const origins = (process.env["CORS_ORIGINS"] ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(cors, { origin: origins });

  // After CORS, before every route: with GATEWAY_SECRET set, nothing below
  // answers a request that did not come through services/gateway.
  registerGatewayGuard(app, process.env);
  // An account limited to named centres reaches only the routes that filter
  // by centre. Before every route, so one added later is closed to it too.
  registerScopeGuard(app, pool);

  registerAuthRoutes(app, pool);
  registerRoutes(app, pool);
  registerRegistryRoutes(app, pool);
  if (process.env["ACCESS_URL"]) registerAccessProxy(app, process.env["ACCESS_URL"]);
  else registerAccessRoutes(app, pool);
  registerSealRoutes(app, pool);
  registerPublicScanRoutes(app, pool);
  registerTransferRoutes(app, pool);
  registerWebAuthnRoutes(app, pool);
  registerOverrideRoutes(app, pool);
  registerStrongroomRoutes(app, pool);
  registerOpeningRoutes(app, pool);
  registerDemoRoutes(app, pool);
  registerAlertRoutes(app, pool);
  await app.listen({ port: PORT, host: listenHost(process.env) });
  app.log.info({ port: PORT, host: listenHost(process.env) }, "ledger listening");
  const exposed = exposureWarning(process.env);
  if (exposed) app.log.warn(exposed);

  const anchorSweep = () => {
    void sweepAnchors(pool, app.log).catch((err) => app.log.warn({ err }, "anchor sweep failed"));
  };
  anchorSweep();
  anchorTimer = setInterval(anchorSweep, 60 * 60_000);
  anchorTimer.unref();

  if (LEG_WATCHDOG_MS > 0) {
    stopWatchdog = startWatchdog(pool, app.log, LEG_WATCHDOG_MS);
    app.log.info(
      { intervalMs: LEG_WATCHDOG_MS },
      "watchdog sweeping for LEG_OVERDUE, PACKET_UNOPENED_OVERDUE, DWELL_EXCEEDED and CEREMONY_INCOMPLETE",
    );
  }

  // With no channel configured the alerts still reach the Alerts page; the log
  // says so once, so "nobody was messaged" is never a surprise found later.
  // NOTIFIER=external hands sending to services/notify running as its own
  // process, which then holds the bot token and the mail password instead of
  // this one. Nothing is sent from here in that case, whatever is configured.
  const external = process.env["NOTIFIER"] === "external";
  const { channels, skipped } = external ? { channels: [], skipped: [] } : channelsFromEnv(process.env);
  for (const reason of skipped) app.log.warn({ reason }, "notification channel not started");
  if (external) {
    app.log.info("alerts are sent by services/notify, not by this process (NOTIFIER=external)");
  } else if (NOTIFY_MS > 0 && channels.length > 0) {
    stopNotifier = startNotifier(pool, app.log, channels, NOTIFY_MS);
    app.log.info(
      { intervalMs: NOTIFY_MS, channels: channels.map((c) => c.name) },
      "notifier sending alerts",
    );
  } else {
    app.log.info("no notification channel configured: alerts appear on the Alerts page only");
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, "shutting down");
    stopWatchdog?.();
    stopNotifier?.();
    if (anchorTimer) clearInterval(anchorTimer);
    void app.close().then(() => pool.end()).then(() => process.exit(0));
  });
}

main().catch((err) => {
  app.log.fatal({ err }, "failed to start");
  process.exit(1);
});
