#!/usr/bin/env node
/**
 * Sealing a packet, end to end, against a real Postgres, leaving nothing behind.
 *
 *   E2E_OWNER_URL=postgres://<schema owner>@host/<db>  node tools/e2e/seal.mjs
 *
 * Safe to point at a database you care about: like sweeps.mjs, everything runs
 * inside one transaction that is rolled back at the end.
 *
 * The routes are the ledger's own, registered on a Fastify instance that is
 * never bound to a port, and the device side is tools/label-print's own
 * library. The label tool enrols a device, signs SEAL_APPLIED and posts it;
 * the seal route records it and registers the commitment; then the hand-off
 * engine is asked to dispatch the packet with the secret a scan of that label
 * would rebuild. If sealing registered the wrong thing, the dispatch refuses.
 *
 * Needs every migration applied. Build first (`pnpm build`).
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(root, "services", "ledger", "package.json"));
const pg = require("pg");
const Fastify = require("fastify");
const at = (p) => new URL(`../../${p}`, import.meta.url).href;
const { registerSealRoutes } = await import(at("services/ledger/dist/http/seal-routes.js"));
const { registerRegistryRoutes } = await import(at("services/ledger/dist/http/registry-routes.js"));
const { registerTransferRoutes } = await import(at("services/ledger/dist/http/transfer-routes.js"));
const { generateSeamLabel } = await import(at("packages/crypto-core/dist/index.js"));
const { loadPacket, enrolDevice, buildSealEvent, submitSeal } = await import(
  at("tools/label-print/dist/seal.js")
);

const ownerUrl = process.env.E2E_OWNER_URL;
if (!ownerUrl) {
  console.error("Set E2E_OWNER_URL to the schema owner's connection string.");
  process.exit(2);
}
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(ownerUrl);
const client = new pg.Client({
  connectionString: ownerUrl,
  ...(local ? {} : { ssl: { rejectUnauthorized: false } }),
});
await client.connect();

/** A pool of exactly one connection: the one holding the outer transaction. */
let depth = 0;
const scoped = {
  query: (text, params) => {
    const t = typeof text === "string" ? text.trim().toLowerCase() : "";
    if (t === "begin") return client.query(`savepoint s${++depth}`);
    if (t === "commit") return client.query(`release savepoint s${depth--}`);
    if (t === "rollback") return client.query(`rollback to savepoint s${depth--}`);
    return client.query(text, params);
  },
  release: () => {},
};
const pool = { connect: async () => scoped, query: (text, params) => client.query(text, params) };

const q = (t, p) => client.query(t, p).then((r) => r.rows);
const results = [];
const expect = (name, ok, detail = "") => results.push({ name, ok, detail });

const app = Fastify({ logger: false });
registerRegistryRoutes(app, pool);
registerSealRoutes(app, pool);
registerTransferRoutes(app, pool);
await app.ready();

const answer = (res) => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null });
const api = {
  get: async (path) => answer(await app.inject({ method: "GET", url: path })),
  post: async (path, body) => answer(await app.inject({ method: "POST", url: path, payload: body })),
};

await client.query("begin");
try {
  const tag = randomBytes(3).toString("hex");
  const LAT = 26.9124, LON = 75.7873;
  const [auth] = await q(`insert into ref.authority (name) values ($1) returning id`, [`seal e2e ${tag}`]);
  const [exam] = await q(
    `insert into ref.exam (authority_id, name, mode, starts_at, drand_round, sides_per_copy)
     values ($1,$2,'escorted', now() + interval '1 day', 21000000, 4) returning id`,
    [auth.id, `Physics ${tag}`]);
  const packetRow = async (code, serial) => {
    const [centre] = await q(
      `insert into ref.centre (exam_id, code, lat, lon, capacity) values ($1,$2,$3,$4,300) returning id`,
      [exam.id, code, LAT, LON]);
    const [pkg] = await q(
      `insert into ref.package (exam_id, centre_id, seal_serial, copies) values ($1,$2,$3,300) returning id`,
      [exam.id, centre.id, serial]);
    return pkg.id;
  };
  const serial = `PKT-SL-${tag}`;
  const pkgId = await packetRow(`SL-A-${tag}`, serial);
  const otherId = await packetRow(`SL-B-${tag}`, `PKT-SL-${tag}-B`);
  const [press] = await q(
    `insert into ref.person (display_name, role, govt_id_hash) values ('A. Sharma','press_operator',$1) returning id`,
    [randomBytes(32)]);

  // What `print` keeps, built here from the label so the test also holds the
  // secret a later scan would rebuild. The tool itself never keeps it.
  const pendingFor = (packageId, packetSerial, label) => ({
    packageId, packetSerial, seamId: label.seamId, labelCommitment: label.commitment,
    labelsPerPacket: 1, printedAt: new Date().toISOString(),
  });
  const photoSha256 = "ab".repeat(32);

  // ── the clean path ──
  const packet = await loadPacket(api, pkgId);
  expect("the tool reads the packet from the ledger", packet.sealSerial === serial && packet.examId === exam.id);

  const device = await enrolDevice(api);
  expect("the tool enrols a press device", /^[0-9a-f-]{36}$/.test(device.deviceId));

  const label = generateSeamLabel();
  const secretHex = Buffer.from(label.seamSecret).toString("hex");
  const signed = buildSealEvent(packet, pendingFor(pkgId, serial, label), device,
    { photoSha256, personId: press.id, geo: { lat: LAT, lon: LON, accuracyM: 8 } });
  const sealed = await submitSeal(api, signed);
  expect("a signed sealing is registered", sealed.sealed && sealed.status === 201, JSON.stringify(sealed.body));

  const [row] = await q(`select seam_id, commitment_hex from ref.seal_label where package_id = $1`, [pkgId]);
  expect("the commitment on record is the label's",
    row?.seam_id === label.seamId && row.commitment_hex === label.commitment);

  const events = await q(
    `select body, encode(hash,'hex') as hash from led.event where package_id = $1 and kind = 'SEAL_APPLIED'`, [pkgId]);
  expect("SEAL_APPLIED is in the chain carrying the commitment",
    events.length === 1 && events[0].body.payload.labelCommitment === label.commitment &&
    events[0].hash === sealed.body.event.hash);
  expect("the seam secret is in neither the event nor the label row",
    !JSON.stringify(events).includes(secretHex) && !JSON.stringify(row).includes(secretHex));

  const again = await submitSeal(api, signed);
  expect("the same event sent again gets the same answer and no second record",
    again.status === 200 && again.body.event.hash === sealed.body.event.hash &&
    (await q(`select 1 from led.event where package_id = $1 and kind = 'SEAL_APPLIED'`, [pkgId])).length === 1);

  // ── the hand-off engine accepts a scan of that label ──
  const now = Date.now();
  const leg = (await api.post("/legs", {
    packageId: pkgId, legNo: 1, fromRole: "press_operator", toRole: "courier",
    fromPlace: "Government Press, Jaipur", toPlace: "Route vehicle",
    windowStart: new Date(now - 3600e3).toISOString(), windowEnd: new Date(now + 3600e3).toISOString(),
    expectedBy: new Date(now + 1800e3).toISOString(), geo: { lat: LAT, lon: LON, radiusM: 150 },
  })).body.legId;
  const scan = {
    deviceId: device.deviceId, personId: press.id, seamIdRead: label.seamId,
    biometricSlot: 3, biometricScore: 190, geo: { lat: LAT, lon: LON, accuracyM: 7 },
  };
  const dispatch = await api.post(`/legs/${leg}/dispatch`, { ...scan, seamSecretHex: secretHex });
  expect("a hand-off dispatch with the scanned label is granted",
    dispatch.body.outcome === "granted", JSON.stringify(dispatch.body.denyReasons ?? dispatch.body));

  // ── a second label on the same packet ──
  const second = generateSeamLabel();
  const resealed = await submitSeal(api,
    buildSealEvent(packet, pendingFor(pkgId, serial, second), device, { photoSha256 }));
  expect("a second sealing of the same packet is refused", resealed.status === 409, JSON.stringify(resealed.body));
  const [kept] = await q(`select commitment_hex from ref.seal_label where package_id = $1`, [pkgId]);
  expect("the first commitment was not replaced", kept.commitment_hex === label.commitment);
  expect("the second attempt is still in the chain",
    (await q(`select 1 from led.event where package_id = $1 and kind = 'SEAL_APPLIED'`, [pkgId])).length === 2);

  // ── refusals on a fresh packet ──
  const other = await loadPacket(api, otherId);
  const wrongSerial = await submitSeal(api,
    buildSealEvent(other, pendingFor(otherId, "PKT-WRONG", generateSeamLabel()), device, { photoSha256 }));
  expect("a serial that is not the planned one is refused, with both serials",
    wrongSerial.status === 409 && wrongSerial.body.serialPlanned === `PKT-SL-${tag}-B` &&
    wrongSerial.body.serialPresented === "PKT-WRONG");

  const reused = await submitSeal(api,
    buildSealEvent(other, pendingFor(otherId, other.sealSerial, label), device, { photoSha256 }));
  expect("a seam id already on another packet is refused", reused.status === 409, JSON.stringify(reused.body));
  expect("neither refusal registered a label",
    (await q(`select 1 from ref.seal_label where package_id = $1`, [otherId])).length === 0);

  const forged = buildSealEvent(other, pendingFor(otherId, other.sealSerial, generateSeamLabel()), device, { photoSha256 });
  forged.deviceSig = "00".repeat(64);
  const before = (await q(`select count(*)::int as n from led.event where package_id = $1`, [otherId]))[0].n;
  const bad = await submitSeal(api, forged);
  const after = (await q(`select count(*)::int as n from led.event where package_id = $1`, [otherId]))[0].n;
  expect("a sealing with a bad signature is rejected and records nothing",
    bad.status === 422 && bad.body.code === "signature_invalid" && before === after &&
    (await q(`select 1 from ref.seal_label where package_id = $1`, [otherId])).length === 0);

  const plain = buildSealEvent(other, pendingFor(otherId, other.sealSerial, generateSeamLabel()), device, { photoSha256 });
  delete plain.body.payload.seamId;
  delete plain.body.payload.labelCommitment;
  expect("a SEAL_APPLIED with no label is sent back to /events",
    (await submitSeal(api, plain)).status === 400);

  const ghost = buildSealEvent({ ...other, id: "99999999-0000-4000-8000-000000000009" },
    pendingFor("99999999-0000-4000-8000-000000000009", "PKT-X", generateSeamLabel()), device, { photoSha256 });
  expect("an unknown package is a 404", (await submitSeal(api, ghost)).status === 404);
} catch (err) {
  expect("the run completed", false, err.stack ?? String(err));
} finally {
  await client.query("rollback").catch(() => {});
  const left = await client
    .query(`select count(*)::int as n from ref.authority where name like 'seal e2e %'`)
    .then((r) => r.rows[0].n)
    .catch(() => -1);
  expect("nothing was left in the database", left === 0, `${left} row(s)`);
  await app.close();
  await client.end();
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${!r.ok && r.detail ? `\n        ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
