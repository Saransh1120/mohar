#!/usr/bin/env node
/**
 * End-to-end check of the hand-off routes against real Postgres, with every
 * write held inside one outer transaction and rolled back.
 *
 *   E2E_OWNER_URL=postgres://<schema owner>@host/<db> node tools/e2e/transfer.mjs
 *   E2E_APP_URL=postgres://mohar_app:<pw>@host/<db> # optional privilege check
 *
 * The routes run on a Fastify instance that is never bound to a port. It
 * seeds a packet with a two-code label and two legs, then drives dispatch,
 * receive and confirm over HTTP — the clean path to closure, and the refusals:
 * receive before dispatch, wrong serial, swapped label, a key issued twice,
 * three wrong keys, and (when E2E_APP_URL is set) the app role trying to
 * rewrite what it recorded. Leg 2 is planned already late, so the watchdog
 * must raise LEG_OVERDUE exactly once; an operator acknowledges that alert.
 *
 * Build first (`pnpm build`); it runs services/ledger/dist.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(root, "services", "ledger", "package.json"));
const pg = require("pg");
const Fastify = require("fastify");
const at = (p) => new URL(`../../${p}`, import.meta.url).href;
const { registerTransferRoutes } = await import(at("services/ledger/dist/http/transfer-routes.js"));
const { registerAlertRoutes } = await import(at("services/ledger/dist/http/alert-routes.js"));
const { sweepOverdueLegs } = await import(at("services/ledger/dist/domain/watchdog.js"));
const { generateSeamLabel } = await import(
  new URL("../../packages/crypto-core/dist/index.js", import.meta.url).href
);

const ownerUrl = process.env.E2E_OWNER_URL;
const appUrl = process.env.E2E_APP_URL;
if (!ownerUrl) {
  console.error("Set E2E_OWNER_URL to the schema owner's connection string.");
  process.exit(2);
}
const LAT = 26.9124, LON = 75.7873;
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(ownerUrl);
const client = new pg.Client({ connectionString: ownerUrl, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
await client.connect();
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
registerTransferRoutes(app, pool);
registerAlertRoutes(app, pool);
await app.ready();
const call = async (method, url, payload, token) => {
  const res = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const post = (url, payload, token) => call("POST", url, payload, token);
const get = (url) => call("GET", url);
let packetId;
let leg1Id;
let leg2Id;
const tag = randomBytes(3).toString("hex");
const refusalOnChain = async (name, response) => {
  const eventId = response.body.chainEvent?.eventId;
  const [row] = eventId ? await q(`select kind, package_id from led.event where id = $1::uuid`, [eventId]) : [];
  expect(name, response.body.outcome === "refused" && response.body.chainEvent?.recorded === true &&
    response.body.chainEvent.kind === "HANDOVER_REFUSED" &&
    row?.kind === "HANDOVER_REFUSED" && row.package_id === packetId,
  JSON.stringify(response.body.chainEvent));
};
await client.query("begin");
try {
// ── seed ──
const [auth] = await q(`insert into ref.authority (name) values ($1) returning id`, [`RBSE e2e ${tag}`]);
const [exam] = await q(
  `insert into ref.exam (authority_id, name, mode, starts_at, drand_round, sides_per_copy)
   values ($1,$2,'escorted', now() + interval '1 day', 21000000, 4) returning id`, [auth.id, `Physics ${tag}`]);
const [centre] = await q(
  `insert into ref.centre (exam_id, code, lat, lon, capacity)
   values ($1,$2,$3,$4,300) returning id`, [exam.id, `JPR-${tag}`, LAT, LON]);
const serial = `PKT-JPR-${tag}`;
const [pkg] = await q(
  `insert into ref.package (exam_id, centre_id, seal_serial, copies) values ($1,$2,$3,300) returning id`,
  [exam.id, centre.id, serial]);
packetId = pkg.id;
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
  leg1Id = leg1;
  leg2Id = leg2;
  expect("two legs planned", Boolean(leg1 && leg2));

  const common = {
    deviceId: phone, seamIdRead: label.seamId,
    seamSecretHex: Buffer.from(label.seamSecret).toString("hex"),
    biometricSlot: 3, biometricScore: 190, geo: { lat: LAT, lon: LON, accuracyM: 7 },
  };

  // receive before dispatch
  const early = await post(`/legs/${leg1}/receive`, { ...common, personId: courier, packetSerialTyped: serial });
  expect("receive before dispatch is refused", early.body.outcome === "refused" && !early.body.transferKey,
    early.body.denyReasons?.join(","));
  await refusalOnChain("receive before dispatch is on the chain", early);
  const wrongPerson = await post(`/legs/${leg1}/dispatch`, { ...common, personId: courier });
  expect("wrong person cannot dispatch", wrongPerson.body.denyReasons?.includes("person_role_not_permitted"));
  await refusalOnChain("wrong person is on the chain", wrongPerson);
  const wrongPlace = await post(`/legs/${leg1}/dispatch`, {
    ...common, personId: press, geo: { lat: LAT + 1, lon: LON + 1, accuracyM: 7 },
  });
  expect("wrong place cannot dispatch", wrongPlace.body.denyReasons?.includes("outside_geofence"));
  await refusalOnChain("wrong place is on the chain", wrongPlace);

  const dispatch = await post(`/legs/${leg1}/dispatch`, { ...common, personId: press });
  expect("sender dispatches", dispatch.body.outcome === "granted", dispatch.body.denyReasons?.join(","));
  expect("sender is never shown a key", !("transferKey" in dispatch.body));

  const wrongSerial = await post(`/legs/${leg1}/receive`, { ...common, personId: courier, packetSerialTyped: `${serial}-wrong` });
  expect("wrong serial refused, no key", wrongSerial.body.outcome === "refused" && !wrongSerial.body.transferKey,
    wrongSerial.body.denyReasons?.join(","));
  await refusalOnChain("wrong serial is on the chain", wrongSerial);

  const swapped = generateSeamLabel();
  const swap = await post(`/legs/${leg1}/receive`, {
    ...common, personId: courier, packetSerialTyped: serial,
    seamIdRead: swapped.seamId, seamSecretHex: Buffer.from(swapped.seamSecret).toString("hex"),
  });
  expect("swapped label refused", swap.body.denyReasons?.includes("seam_token_mismatch"), swap.body.denyReasons?.join(","));
  await refusalOnChain("swapped label is on the chain", swap);

  const receive = await post(`/legs/${leg1}/receive`, { ...common, personId: courier, packetSerialTyped: serial.toLowerCase() });
  expect("receiver passes and gets the key", receive.body.outcome === "granted" && /^[0-9A-Z]{8}$/.test(receive.body.transferKey ?? ""),
    receive.body.denyReasons?.join(",") + " attempt " + receive.body.attemptNo);

  const again = await post(`/legs/${leg1}/receive`, { ...common, personId: courier, packetSerialTyped: serial });
  expect("key is not issued twice", again.status === 409);
  // A 409 is a key re-issue conflict, not a refused engine ruling; the attempt
  // is recorded, but the route deliberately does not append a refusal event.

  expect("the refusals before it were not guesses, so the real receiver was not locked out",
    receive.body.outcome === "granted");

  const [stateMid] = await q(`select state from ref.package where id=$1`, [pkg.id]);
  const confirm = await post(`/legs/${leg1}/confirm`, { ...common, personId: courier, packetSerialTyped: serial, transferKey: receive.body.transferKey });
  expect("the right key closes the leg", confirm.body.outcome === "granted", confirm.body.denyReasons?.join(","));
  const [stateAfter] = await q(`select state from ref.package where id=$1`, [pkg.id]);
  expect("package moves to in_transit only when the leg closes",
    stateMid.state === "sealed" && stateAfter.state === "in_transit", `${stateMid.state} -> ${stateAfter.state}`);

  // ── leg 2: the courier hands to the custodian; a guesser is locked out ──
  const d2 = await post(`/legs/${leg2}/dispatch`, { ...common, geo: undefined, personId: courier });
  expect("leg 2 dispatches now that leg 1 closed", d2.body.outcome === "granted", d2.body.denyReasons?.join(","));
  const r2 = await post(`/legs/${leg2}/receive`, { ...common, geo: undefined, personId: custodian, packetSerialTyped: serial });
  expect("custodian receives leg 2", r2.body.outcome === "granted" && Boolean(r2.body.transferKey));
  const g1 = await post(`/legs/${leg2}/confirm`, { ...common, geo: undefined, personId: custodian, transferKey: "2H4K6M8P" });
  const g2 = await post(`/legs/${leg2}/confirm`, { ...common, geo: undefined, personId: custodian, transferKey: "3J5K7M9P" });
  const g3 = await post(`/legs/${leg2}/confirm`, { ...common, geo: undefined, personId: custodian, transferKey: "4K6M8P0Q" });
  expect("wrong keys are refused as mismatched", [g1, g2, g3].every((g) => g.body.denyReasons?.includes("transfer_key_mismatch")));
  await refusalOnChain("wrong key 1 is on the chain", g1);
  await refusalOnChain("wrong key 2 is on the chain", g2);
  await refusalOnChain("wrong key 3 is on the chain", g3);
  expect("no alert on the first two wrong keys", !g1.body.alertRaised && !g2.body.alertRaised);
  expect("the third wrong key raises an alert", g3.body.alertRaised === true);
  const late = await post(`/legs/${leg2}/confirm`, { ...common, geo: undefined, personId: custodian, transferKey: r2.body.transferKey });
  expect("after three wrong keys even the right one is refused", late.body.outcome === "refused",
    late.body.denyReasons?.join(","));
  await refusalOnChain("locked-out receiver is on the chain", late);

  const legs = (await get(`/legs?packageId=${pkg.id}`)).body;
  const l2 = legs.legs.find((l) => l.leg_no === 2);
  expect("leg 2, still open past expected_by, shows as overdue", l2?.overdue === true);
  const l1 = legs.legs.find((l) => l.leg_no === 1);
  expect("leg 1 shows as completed", l1?.completed === true);

  const [attempts] = await q(`select count(*)::int as n from led.transfer_attempt where leg_id in ($1::uuid,$2::uuid)`, [leg1, leg2]);
  expect("every attempt was recorded, refusals and the 409 included", attempts.n === 15, `${attempts.n} rows`);
  const [alerts] = await q(
    `select count(*)::int as n, min(consequence) as c from led.alert where kind = 'TRANSFER_ATTEMPTS_EXHAUSTED' and package_id=$1`, [pkg.id]);
  expect("one attempts alert, with a consequence and no severity", alerts.n === 1 && alerts.c.length > 20, `${alerts.n} alert(s)`);

  // ── the watchdog: leg 2 was planned already late and is still open ──
  const raised = await sweepOverdueLegs(pool);
  const overdue = await q(`select leg_id, evidence, consequence from led.alert where kind = 'LEG_OVERDUE' and package_id=$1`, [pkg.id]);
  expect("the watchdog raised LEG_OVERDUE for the late leg on its own",
    overdue.length === 1 && overdue[0].leg_id === leg2 && raised.some((r) => r.legId === leg2), `${overdue.length} alert(s)`);
  expect("LEG_OVERDUE carries how late and a consequence",
    overdue[0]?.evidence?.overdueBySeconds > 0 && overdue[0]?.consequence.length > 20);
  expect("the leg that is not late raised nothing",
    (await q(`select 1 from led.alert where kind = 'LEG_OVERDUE' and leg_id = $1`, [leg1])).length === 0);
  await sweepOverdueLegs(pool);
  const [again2] = await q(`select count(*)::int as n from led.alert where kind = 'LEG_OVERDUE' and package_id=$1`, [pkg.id]);
  expect("a leg that stays late is raised once, not on every sweep", again2.n === 1, `${again2.n} alert(s)`);

  // ── acknowledging it ──
  const [overdueRow] = await q(`select id from led.alert where kind = 'LEG_OVERDUE' and package_id=$1`, [pkg.id]);
  const anon = await post(`/alerts/${overdueRow.id}/ack`, { note: "seen" });
  expect("an anonymous caller cannot acknowledge an alert", anon.status === 401);
  const username = `e2e-operator-${tag}`;
  const [account] = await q(
    `insert into ref.account (username, password_hash, password_salt, display_name)
     values ($1,$2,$3,'E2E Operator') returning id`, [username, randomBytes(64), randomBytes(16)]);
  const token = randomBytes(24).toString("hex");
  await q(`insert into ref.session (token_hash, account_id, expires_at)
    values ($1,$2,now() + interval '1 hour')`, [createHash("sha256").update(token).digest(), account.id]);
  const blank = await post(`/alerts/${overdueRow.id}/ack`, { note: "" }, token);
  expect("an acknowledgement without a note is refused", blank.status === 400);
  const ack = await post(`/alerts/${overdueRow.id}/ack`, { note: "Called the courier; vehicle delayed at the toll." }, token);
  expect("a signed-in operator acknowledges it", ack.status === 201, JSON.stringify(ack.body));
  const openList = (await get("/alerts?open=true")).body;
  expect("an acknowledged alert leaves the open list",
    !openList.alerts.some((a) => a.id === overdueRow.id));
  const allList = (await get("/alerts")).body;
  const listed = allList.alerts.find((a) => a.id === overdueRow.id);
  expect("the acknowledgement names the operator and keeps the note",
    listed?.acks?.[0]?.accountUsername === username && /toll/.test(listed?.acks?.[0]?.note ?? ""));
  const keys = await q(`select key_hash_hex from led.transfer_key where leg_id in ($1::uuid,$2::uuid)`, [leg1, leg2]);
  expect("only hashes are stored", keys.length === 2 && keys.every((k) =>
    !k.key_hash_hex.toUpperCase().includes(receive.body.transferKey) && !k.key_hash_hex.toUpperCase().includes(r2.body.transferKey)));
  if (appUrl) {
    const appLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(appUrl);
    const appClient = new pg.Client({ connectionString: appUrl, ...(appLocal ? {} : { ssl: { rejectUnauthorized: false } }) });
    await appClient.connect();
    let blocked = true;
    for (const sql of [
      "update led.transfer_attempt set outcome = 'granted' where false",
      "delete from led.alert where false",
      "update led.alert_ack set note = 'nothing happened' where false",
    ]) {
      try { await appClient.query(sql); blocked = false; }
      catch (e) { blocked &&= /permission denied/.test(e.message); }
    }
    await appClient.end();
    expect("the app role cannot rewrite attempts, delete alerts or edit acknowledgements", blocked);
  } else {
    console.log("SKIP  app-role append-only privilege check: E2E_APP_URL is not set");
  }
} catch (err) {
  expect("the run completed", false, err.stack ?? String(err));
} finally {
  await client.query("rollback").catch(() => {});
  const left = await client.query(
    `select (select count(*) from ref.authority where name=$4) +
            (select count(*) from ref.package where id=$1::uuid) +
            (select count(*) from led.event where package_id=$1::uuid) +
            (select count(*) from led.alert where package_id=$1::uuid) +
            (select count(*) from led.transfer_attempt where leg_id in ($2::uuid,$3::uuid)) as n`,
    [packetId ?? null, leg1Id ?? null, leg2Id ?? null, `RBSE e2e ${tag}`],
  ).then((r) => Number(r.rows[0].n)).catch(() => -1);
  expect("nothing was left in the database", left === 0, `${left} row(s)`);
  await app.close();
  await client.end();
}

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
