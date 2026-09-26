#!/usr/bin/env node
/**
 * End-to-end check of the hand-off routes: a real Postgres, the real ledger
 * process, real HTTP.
 *
 *   E2E_OWNER_URL=postgres://<schema owner>@host/<scratch db>  *   E2E_APP_URL=postgres://mohar_app:<pw>@host/<scratch db>  *   node tools/e2e/transfer.mjs
 *
 * Point it at a THROWAWAY database that has had every migration applied. It
 * seeds a packet with a two-code label and two legs, then drives dispatch,
 * receive and confirm over HTTP — the clean path to closure, and the refusals:
 * receive before dispatch, wrong serial, swapped label, a key issued twice,
 * three wrong keys, and the app role trying to rewrite what it recorded. Leg 2
 * is planned already late, so the ledger's watchdog must raise LEG_OVERDUE for
 * it on its own, exactly once, and an operator acknowledges that alert.
 *
 * Build first (`pnpm build`); it runs services/ledger/dist.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pg = createRequire(join(root, "services", "ledger", "package.json"))("pg");
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
const { generateSeamLabel } = await import(
  new URL("../../packages/crypto-core/dist/index.js", import.meta.url).href
);

const ownerUrl = process.env.E2E_OWNER_URL;
const appUrl = process.env.E2E_APP_URL;
if (!ownerUrl || !appUrl) {
  console.error("Set E2E_OWNER_URL and E2E_APP_URL to a throwaway, fully migrated database.");
  process.exit(2);
}
const PORT = 8097;
const BASE = `http://localhost:${PORT}`;
const LAT = 26.9124, LON = 75.7873;

const owner = new pg.Pool({ connectionString: ownerUrl, ssl: { rejectUnauthorized: false } });
const q = (t, p) => owner.query(t, p).then((r) => r.rows);

// ── seed ──
const [auth] = await q(`insert into ref.authority (name) values ('RBSE e2e') returning id`);
const [exam] = await q(
  `insert into ref.exam (authority_id, name, mode, starts_at, drand_round, sides_per_copy)
   values ($1,'Class 12 Physics','escorted', now() + interval '1 day', 21000000, 4) returning id`, [auth.id]);
const [centre] = await q(
  `insert into ref.centre (exam_id, code, name, lat, lon, capacity)
   values ($1,'JPR-E2E','KV Jaipur',$2,$3,300) returning id`, [exam.id, LAT, LON]).catch(async () =>
  q(`insert into ref.centre (exam_id, code, lat, lon, capacity) values ($1,'JPR-E2E',$2,$3,300) returning id`, [exam.id, LAT, LON]));
const [pkg] = await q(
  `insert into ref.package (exam_id, centre_id, seal_serial, copies) values ($1,$2,'PKT-JPR-0091',300) returning id`,
  [exam.id, centre.id]);
const person = async (name, role) =>
  (await q(`insert into ref.person (display_name, role, govt_id_hash) values ($1,$2,$3) returning id`,
    [name, role, randomBytes(32)]))[0].id;
const press = await person("A. Sharma", "press_operator");
const courier = await person("B. Meena", "courier");
const custodian = await person("C. Rathore", "custodian");
const phone = (await q(`insert into ref.device (kind, pubkey) values ('field',$1) returning id`, [randomBytes(32)]))[0].id;

const label = generateSeamLabel();
await q(`insert into ref.seal_label (package_id, seam_id, commitment_hex) values ($1,$2,$3)`,
  [pkg.id, label.seamId, label.commitment]);

// ── ledger ──
const ledger = spawn("node", ["dist/index.js"], {
  cwd: join(root, "services", "ledger"),
  // A fast sweep so the test does not wait the production 30 seconds.
  env: { ...process.env, PORT: String(PORT), DATABASE_URL: appUrl, LEG_WATCHDOG_MS: "500" },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
ledger.stderr.on("data", (d) => (stderr += d));
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`${BASE}/ping`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const post = (path, body, token) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const expect = (name, ok, detail = "") => results.push({ name, ok, detail });

try {
  const now = Date.now();
  const leg1 = (await post("/legs", {
    packageId: pkg.id, legNo: 1, fromRole: "press_operator", toRole: "courier",
    fromPlace: "Government Press, Jaipur", toPlace: "District strong room, Jaipur",
    windowStart: new Date(now - 3600e3).toISOString(), windowEnd: new Date(now + 3600e3).toISOString(),
    expectedBy: new Date(now + 1800e3).toISOString(), geo: { lat: LAT, lon: LON, radiusM: 150 },
  })).body.legId;
  const leg2 = (await post("/legs", {
    packageId: pkg.id, legNo: 2, fromRole: "courier", toRole: "custodian",
    fromPlace: "Route vehicle", toPlace: "District strong room, Jaipur",
    windowStart: new Date(now - 3600e3).toISOString(), windowEnd: new Date(now + 3600e3).toISOString(),
    expectedBy: new Date(now - 60e3).toISOString(),
  })).body.legId;
  expect("two legs planned", Boolean(leg1 && leg2));

  const common = {
    deviceId: phone, seamIdRead: label.seamId,
    seamSecretHex: Buffer.from(label.seamSecret).toString("hex"),
    biometricSlot: 3, biometricScore: 190, geo: { lat: LAT, lon: LON, accuracyM: 7 },
  };

  // receive before dispatch
  const early = await post(`/legs/${leg1}/receive`, { ...common, personId: courier, packetSerialTyped: "PKT-JPR-0091" });
  expect("receive before dispatch is refused", early.body.outcome === "refused" && !early.body.transferKey,
    early.body.denyReasons?.join(","));

  const dispatch = await post(`/legs/${leg1}/dispatch`, { ...common, personId: press });
  expect("sender dispatches", dispatch.body.outcome === "granted", dispatch.body.denyReasons?.join(","));
  expect("sender is never shown a key", !("transferKey" in dispatch.body));

  const wrongSerial = await post(`/legs/${leg1}/receive`, { ...common, personId: courier, packetSerialTyped: "PKT-JPR-0092" });
  expect("wrong serial refused, no key", wrongSerial.body.outcome === "refused" && !wrongSerial.body.transferKey,
    wrongSerial.body.denyReasons?.join(","));

  const swapped = generateSeamLabel();
  const swap = await post(`/legs/${leg1}/receive`, {
    ...common, personId: courier, packetSerialTyped: "PKT-JPR-0091",
    seamIdRead: swapped.seamId, seamSecretHex: Buffer.from(swapped.seamSecret).toString("hex"),
  });
  expect("swapped label refused", swap.body.denyReasons?.includes("seam_token_mismatch"), swap.body.denyReasons?.join(","));

  const receive = await post(`/legs/${leg1}/receive`, { ...common, personId: courier, packetSerialTyped: "pkt-jpr-0091" });
  expect("receiver passes and gets the key", receive.body.outcome === "granted" && /^[0-9A-Z]{8}$/.test(receive.body.transferKey ?? ""),
    receive.body.denyReasons?.join(",") + " attempt " + receive.body.attemptNo);

  const again = await post(`/legs/${leg1}/receive`, { ...common, personId: courier, packetSerialTyped: "PKT-JPR-0091" });
  expect("key is not issued twice", again.status === 409);

  expect("the refusals before it were not guesses, so the real receiver was not locked out",
    receive.body.outcome === "granted");

  const [stateMid] = await q(`select state from ref.package where id=$1`, [pkg.id]);
  const confirm = await post(`/legs/${leg1}/confirm`, { ...common, personId: courier, packetSerialTyped: "PKT-JPR-0091", transferKey: receive.body.transferKey });
  expect("the right key closes the leg", confirm.body.outcome === "granted", confirm.body.denyReasons?.join(","));
  const [stateAfter] = await q(`select state from ref.package where id=$1`, [pkg.id]);
  expect("package moves to in_transit only when the leg closes",
    stateMid.state === "sealed" && stateAfter.state === "in_transit", `${stateMid.state} -> ${stateAfter.state}`);

  // ── leg 2: the courier hands to the custodian; a guesser is locked out ──
  const d2 = await post(`/legs/${leg2}/dispatch`, { ...common, geo: undefined, personId: courier });
  expect("leg 2 dispatches now that leg 1 closed", d2.body.outcome === "granted", d2.body.denyReasons?.join(","));
  const r2 = await post(`/legs/${leg2}/receive`, { ...common, geo: undefined, personId: custodian, packetSerialTyped: "PKT-JPR-0091" });
  expect("custodian receives leg 2", r2.body.outcome === "granted" && Boolean(r2.body.transferKey));
  const g1 = await post(`/legs/${leg2}/confirm`, { ...common, geo: undefined, personId: custodian, transferKey: "2H4K6M8P" });
  const g2 = await post(`/legs/${leg2}/confirm`, { ...common, geo: undefined, personId: custodian, transferKey: "3J5K7M9P" });
  const g3 = await post(`/legs/${leg2}/confirm`, { ...common, geo: undefined, personId: custodian, transferKey: "4K6M8P0Q" });
  expect("wrong keys are refused as mismatched", [g1, g2, g3].every((g) => g.body.denyReasons?.includes("transfer_key_mismatch")));
  expect("no alert on the first two wrong keys", !g1.body.alertRaised && !g2.body.alertRaised);
  expect("the third wrong key raises an alert", g3.body.alertRaised === true);
  const late = await post(`/legs/${leg2}/confirm`, { ...common, geo: undefined, personId: custodian, transferKey: r2.body.transferKey });
  expect("after three wrong keys even the right one is refused", late.body.outcome === "refused",
    late.body.denyReasons?.join(","));

  const legs = await fetch(`${BASE}/legs?packageId=${pkg.id}`).then((r) => r.json());
  const l2 = legs.legs.find((l) => l.leg_no === 2);
  expect("leg 2, still open past expected_by, shows as overdue", l2?.overdue === true);
  const l1 = legs.legs.find((l) => l.leg_no === 1);
  expect("leg 1 shows as completed", l1?.completed === true);

  const [attempts] = await q(`select count(*)::int as n from led.transfer_attempt`);
  expect("every attempt was recorded, refusals and the 409 included", attempts.n === 13, `${attempts.n} rows`);
  const [alerts] = await q(
    `select count(*)::int as n, min(consequence) as c from led.alert where kind = 'TRANSFER_ATTEMPTS_EXHAUSTED'`);
  expect("one attempts alert, with a consequence and no severity", alerts.n === 1 && alerts.c.length > 20, `${alerts.n} alert(s)`);

  // ── the watchdog: leg 2 was planned already late and is still open ──
  await sleep(1500);
  const overdue = await q(`select leg_id, evidence, consequence from led.alert where kind = 'LEG_OVERDUE'`);
  expect("the watchdog raised LEG_OVERDUE for the late leg on its own",
    overdue.length === 1 && overdue[0].leg_id === leg2, `${overdue.length} alert(s)`);
  expect("LEG_OVERDUE carries how late and a consequence",
    overdue[0]?.evidence?.overdueBySeconds > 0 && overdue[0]?.consequence.length > 20);
  expect("the leg that is not late raised nothing",
    (await q(`select 1 from led.alert where kind = 'LEG_OVERDUE' and leg_id = $1`, [leg1])).length === 0);
  await sleep(1500);
  const [again2] = await q(`select count(*)::int as n from led.alert where kind = 'LEG_OVERDUE'`);
  expect("a leg that stays late is raised once, not on every sweep", again2.n === 1, `${again2.n} alert(s)`);

  // ── acknowledging it ──
  const [overdueRow] = await q(`select id from led.alert where kind = 'LEG_OVERDUE'`);
  const anon = await post(`/alerts/${overdueRow.id}/ack`, { note: "seen" });
  expect("an anonymous caller cannot acknowledge an alert", anon.status === 401);
  const signup = await post("/auth/signup", {
    username: "e2e-operator", password: randomBytes(18).toString("base64url"),
    displayName: "E2E Operator", role: "control_room",
  });
  const token = signup.body.token;
  const blank = await post(`/alerts/${overdueRow.id}/ack`, { note: "" }, token);
  expect("an acknowledgement without a note is refused", blank.status === 400);
  const ack = await post(`/alerts/${overdueRow.id}/ack`, { note: "Called the courier; vehicle delayed at the toll." }, token);
  expect("a signed-in operator acknowledges it", ack.status === 201, JSON.stringify(ack.body));
  const openList = await fetch(`${BASE}/alerts?open=true`).then((r) => r.json());
  expect("an acknowledged alert leaves the open list",
    !openList.alerts.some((a) => a.id === overdueRow.id));
  const allList = await fetch(`${BASE}/alerts`).then((r) => r.json());
  const listed = allList.alerts.find((a) => a.id === overdueRow.id);
  expect("the acknowledgement names the operator and keeps the note",
    listed?.acks?.[0]?.accountUsername === "e2e-operator" && /toll/.test(listed?.acks?.[0]?.note ?? ""));
  const keys = await q(`select key_hash_hex from led.transfer_key`);
  expect("only hashes are stored", keys.length === 2 && keys.every((k) =>
    !k.key_hash_hex.toUpperCase().includes(receive.body.transferKey) && !k.key_hash_hex.toUpperCase().includes(r2.body.transferKey)));
  let blocked = false;
  const appPool = new pg.Pool({ connectionString: appUrl, ssl: { rejectUnauthorized: false } });
  try { await appPool.query("update led.transfer_attempt set outcome = 'granted'"); }
  catch (e) { blocked = /permission denied/.test(e.message); }
  try { await appPool.query("delete from led.alert"); blocked = false; }
  catch (e) { blocked = blocked && /permission denied/.test(e.message); }
  try { await appPool.query("update led.alert_ack set note = 'nothing happened'"); blocked = false; }
  catch (e) { blocked = blocked && /permission denied/.test(e.message); }
  await appPool.end();
  expect("the app role cannot rewrite attempts, delete alerts or edit acknowledgements", blocked);
} finally {
  ledger.kill();
  await owner.end();
}

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  if (!r.ok) failed++;
}
if (stderr.trim()) console.log("--- ledger stderr ---\n" + stderr.slice(0, 1500));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
