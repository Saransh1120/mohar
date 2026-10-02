#!/usr/bin/env node
/** An anonymous QR visit creates a service-signed event and an alert. Rolled back. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(root, "services", "ledger", "package.json"));
const { Client } = require("pg");
const Fastify = require("fastify");
const at = (path) => new URL(`../../${path}`, import.meta.url).href;
const { registerPublicScanRoutes } = await import(at("services/ledger/dist/http/public-scan-routes.js"));
const { servicePublicKeyHex } = await import(at("services/ledger/dist/domain/service-events.js"));
const { generateSeamLabel } = await import(at("packages/crypto-core/dist/index.js"));

const url = process.env.E2E_OWNER_URL;
if (!url) { console.error("Set E2E_OWNER_URL to a schema-owner database URL."); process.exit(2); }
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const client = new Client({ connectionString: url, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
await client.connect();
let depth = 0;
const scoped = {
  query: (sql, args) => {
    const text = typeof sql === "string" ? sql.trim().toLowerCase() : "";
    if (text === "begin") return client.query(`savepoint scan${++depth}`);
    if (text === "commit") return client.query(`release savepoint scan${depth--}`);
    if (text === "rollback") return client.query(`rollback to savepoint scan${depth--}`);
    return client.query(sql, args);
  },
  release: () => {},
};
const pool = { connect: async () => scoped, query: (sql, args) => client.query(sql, args) };
const app = Fastify({ logger: false });
registerPublicScanRoutes(app, pool);
await app.ready();
let passed = 0;
const check = (label, condition) => { assert.ok(condition, label); console.log(`ok ${++passed} - ${label}`); };

await client.query("begin");
try {
  await client.query("alter table led.event add column if not exists device_seq bigint");
  const tag = randomBytes(3).toString("hex");
  const [auth] = (await client.query(
    "insert into ref.authority (name) values ($1) returning id", [`scan e2e ${tag}`],
  )).rows;
  const [exam] = (await client.query(
    `insert into ref.exam (authority_id,name,mode,starts_at,drand_round,sides_per_copy)
     values ($1,$2,'escorted',now() + interval '1 day',21000000,4) returning id`,
    [auth.id, `Scan ${tag}`],
  )).rows;
  const [centre] = (await client.query(
    "insert into ref.centre (exam_id,code,lat,lon,capacity) values ($1,$2,26.9,75.8,100) returning id",
    [exam.id, `SCAN-${tag}`],
  )).rows;
  const [packet] = (await client.query(
    "insert into ref.package (exam_id,centre_id,copies) values ($1,$2,10) returning id",
    [exam.id, centre.id],
  )).rows;
  const label = generateSeamLabel();
  await client.query(
    "insert into ref.seal_label (package_id,seam_id,commitment_hex) values ($1,$2,$3)",
    [packet.id, label.seamId, label.commitment],
  );
  const scan = (seamId, whichCodes) => app.inject({
    method: "POST", url: "/public/seam-scan", payload: { seamId, whichCodes },
    headers: { "user-agent": "e2e-ordinary-camera" },
  });
  const first = await scan(label.seamId, "A");
  check("public scan receives a generic response", first.statusCode === 202 &&
    first.json().status === "received" && !first.body.includes(packet.id));
  const [event] = (await client.query(
    "select id,body,actor_device from led.event where kind = 'UNAUTHORIZED_SCAN' and package_id = $1", [packet.id],
  )).rows;
  check("service signs an UNAUTHORIZED_SCAN event on the real chain",
    event?.body?.payload?.seamId === label.seamId &&
    event?.body?.payload?.whichCodes === "A" &&
    event?.body?.payload?.priorHitsOnThisSeam === 0);
  check("no QR share is stored in the signed body",
    !JSON.stringify(event.body).includes(Buffer.from(label.shareA).toString("base64url")));
  const [alert] = (await client.query(
    "select kind,evidence,device_id from led.alert where package_id = $1 and kind = 'UNAUTHORIZED_SCAN'", [packet.id],
  )).rows;
  check("a linked alert reaches the control room", alert?.evidence?.eventId === event.id);
  const [service] = (await client.query(
    "select kind,encode(pubkey,'hex') as pubkey from ref.device where id = $1", [event.actor_device],
  )).rows;
  check("public scan and alert share the ledger's enrolled service identity",
    event.actor_device === alert.device_id && service?.kind === "service" &&
    service.pubkey === servicePublicKeyHex());
  const second = await scan(label.seamId, "B");
  check("a second code visit is accepted", second.statusCode === 202);
  const [later] = (await client.query(
    `select body from led.event where kind = 'UNAUTHORIZED_SCAN' and package_id = $1
      order by seq desc limit 1`, [packet.id],
  )).rows;
  check("repeat visit counts its predecessor", later.body.payload.priorHitsOnThisSeam === 1);
  const unknown = await scan(generateSeamLabel().seamId, "A");
  check("unknown seam receives the same public response", unknown.statusCode === 202 && unknown.body === first.body);
  const [{ count }] = (await client.query(
    "select count(*)::int as count from led.event where kind = 'UNAUTHORIZED_SCAN' and package_id = $1", [packet.id],
  )).rows;
  check("unknown seam adds no event to this packet", count === 2);
} finally {
  await client.query("rollback");
  await app.close();
  await client.end();
}
console.log(`${passed}/${passed} public scan checks passed; transaction rolled back`);
