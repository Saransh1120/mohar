import Fastify from "fastify";
import cors from "@fastify/cors";
import { createPool, assertAppendOnly, LedgerPrivilegeError } from "./db.js";
import { registerRoutes } from "./http/routes.js";
import { registerRegistryRoutes } from "./http/registry-routes.js";
import { registerAccessRoutes } from "./http/access-routes.js";
import { registerAuthRoutes } from "./http/auth-routes.js";

const PORT = Number(process.env["PORT"] ?? 8081);
const DATABASE_URL = process.env["DATABASE_URL"];

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
});

const pool = createPool(DATABASE_URL);

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

  // Dev-only. The control room normally reaches this through Vite's /api proxy
  // and is therefore same-origin; this grant is the escape hatch for calling the
  // API straight from a browser tab while debugging. It must not survive into a
  // deployment, where `gateway` terminates all browser traffic.
  await app.register(cors, { origin: ["http://localhost:5173"] });

  registerAuthRoutes(app, pool);
  registerRoutes(app, pool);
  registerRegistryRoutes(app, pool);
  registerAccessRoutes(app, pool);
  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info({ port: PORT }, "ledger listening");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => pool.end()).then(() => process.exit(0));
  });
}

main().catch((err) => {
  app.log.fatal({ err }, "failed to start");
  process.exit(1);
});
