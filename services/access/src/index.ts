import Fastify from "fastify";
import { createPool } from "./db.js";
import { registerAccessRoutes } from "./routes.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = createPool(databaseUrl);
const app = Fastify({ logger: true });
registerAccessRoutes(app, pool);
app.get("/health", async () => ({ ok: true }));

const port = Number(process.env["ACCESS_PORT"] ?? 8082);
await app.listen({ port, host: process.env["ACCESS_HOST"] ?? "127.0.0.1" });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void app.close().then(() => pool.end()); });
}
