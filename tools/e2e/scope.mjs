#!/usr/bin/env node
/**
 * An account limited to one centre, against the ledger's real routes.
 *
 * Two centres, a packet, a hand-off and an alert at each. An operator limits an
 * account to the first centre; that account then reads the first centre's rows
 * and is refused everything else. Then the same by district: a centre moved
 * into the district is seen at once, one moved out is not seen again.
 * Everything is rolled back.
 */
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
const { registerScopeGuard, OPEN_TO_SCOPED } = await import(at("services/ledger/dist/http/scope-guard.js"));
const { registerAuthRoutes } = await import(at("services/ledger/dist/http/auth-routes.js"));
const { registerRegistryRoutes } = await import(at("services/ledger/dist/http/registry-routes.js"));
const { registerTransferRoutes } = await import(at("services/ledger/dist/http/transfer-routes.js"));
const { registerAlertRoutes } = await import(at("services/ledger/dist/http/alert-routes.js"));
const { createAccount, signIn } = await import(at("services/ledger/dist/domain/accounts.js"));
const { SCOPED_ROUTES } = await import(at("services/gateway/dist/routes/policy.js"));

const url = process.env.E2E_OWNER_URL;
if (!url) { console.error("Set E2E_OWNER_URL to a schema-owner database URL."); process.exit(2); }
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const client = new Client({ connectionString: url, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
await client.connect();
let depth = 0;
const scoped = {
  query: (sql, args) => {
    const text = typeof sql === "string" ? sql.trim().toLowerCase() : "";
    if (text === "begin") return client.query(`savepoint scope${++depth}`);
    if (text === "commit") return client.query(`release savepoint scope${depth--}`);
    if (text === "rollback") return client.query(`rollback to savepoint scope${depth--}`);
    return client.query(sql, args);
  },
  release: () => {},
};
const pool = { connect: async () => scoped, query: (sql, args) => client.query(sql, args) };
const app = Fastify({ logger: false });
registerScopeGuard(app, pool);
registerAuthRoutes(app, pool);
registerRegistryRoutes(app, pool);
registerTransferRoutes(app, pool);
registerAlertRoutes(app, pool);
await app.ready();
let passed = 0;
const check = (label, condition) => { assert.ok(condition, label); console.log(`ok ${++passed} - ${label}`); };

await client.query("begin");
try {
  const tag = randomBytes(3).toString("hex");
  const [auth] = (await client.query(
    "insert into ref.authority (name) values ($1) returning id", [`scope e2e ${tag}`],
  )).rows;
  const [exam] = (await client.query(
    `insert into ref.exam (authority_id,name,mode,starts_at,drand_round,sides_per_copy)
     values ($1,$2,'escorted',now() + interval '1 day',21000000,4) returning id`,
    [auth.id, `Scope ${tag}`],
  )).rows;
  const place = async (code) => {
    const [centre] = (await client.query(
      "insert into ref.centre (exam_id,code,lat,lon,capacity) values ($1,$2,26.9,75.8,100) returning id",
      [exam.id, code],
    )).rows;
    const [packet] = (await client.query(
      "insert into ref.package (exam_id,centre_id,copies) values ($1,$2,10) returning id",
      [exam.id, centre.id],
    )).rows;
    const [leg] = (await client.query(
      `insert into ref.route_leg (package_id,leg_no,from_role,to_role,from_place,to_place,window_start,window_end,expected_by)
       values ($1,1,'printer','courier','Press','Depot',now(),now() + interval '2 hours',now() + interval '3 hours')
       returning id`,
      [packet.id],
    )).rows;
    const [alert] = (await client.query(
      `insert into led.alert (kind,package_id,leg_id,evidence,requires_decision,consequence)
       values ('LEG_OVERDUE',$1,$2,'{}'::jsonb,true,$3) returning id`,
      [packet.id, leg.id, `e2e alert at ${code}`],
    )).rows;
    return { centre: centre.id, packet: packet.id, leg: leg.id, alert: alert.id };
  };
  const mine = await place(`SCOPE-A-${tag}`);
  const theirs = await place(`SCOPE-B-${tag}`);

  // Two accounts made and signed in through the ledger's own code, with
  // passwords that exist only for this run.
  const account = async (name, role) => {
    const password = randomBytes(18).toString("base64url");
    const made = await createAccount(scoped, { username: name, displayName: name, password, role });
    const session = await signIn(scoped, name, password, "e2e");
    return { id: made.id, headers: { authorization: `Bearer ${session.token}` } };
  };
  const operator = await account(`scope-op-${tag}`, "control_room");
  const second = await account(`scope-two-${tag}`, "control_room");
  // For this run, these two are the only operators there are.
  await client.query(
    "update ref.account set disabled_at = now(), disabled_reason = 'e2e' where role = 'control_room' and disabled_at is null and id <> all($1::uuid[])",
    [[operator.id, second.id]],
  );

  const get = (path, who) => app.inject({ method: "GET", url: path, headers: who.headers });
  const setCentres = (id, centreIds, who) =>
    app.inject({ method: "PUT", url: `/auth/accounts/${id}/centres`, headers: who.headers, payload: { centreIds } });

  check("the gateway and the ledger hold the same list of what a limited account may reach",
    [...OPEN_TO_SCOPED].sort().join("|") === [...SCOPED_ROUTES].sort().join("|"));

  const before = await get(`/packages?examId=${exam.id}`, second);
  check("with no limit, an account sees both centres' packets", before.json().packages.length === 2);

  const unknown = await setCentres(second.id, [exam.id], operator);
  check("a centre that does not exist is refused", unknown.statusCode === 400);

  const set = await setCentres(second.id, [mine.centre], operator);
  check("an operator limits the account to one centre", set.statusCode === 200 &&
    set.json().centreIds.length === 1 && set.json().centreIds[0] === mine.centre);

  const [raised] = (await client.query(
    "select evidence, consequence from led.alert where kind = 'ACCOUNT_CENTRES_CHANGED' and evidence ->> 'accountId' = $1",
    [second.id],
  )).rows;
  check("the change is raised as an alert naming who made it and what it was before and after",
    raised?.evidence?.changedByAccountId === operator.id &&
    raised.evidence.before.centreIds.length === 0 && raised.evidence.before.districts.length === 0 &&
    raised.evidence.after.centreIds[0] === mine.centre);
  check("the alert does not rank itself", !/critical|high|medium|low|severe|urgent/i.test(raised.consequence));

  const me = await get("/auth/me", second);
  check("the account is told its own limit", me.statusCode === 200 &&
    me.json().account.limited === true && me.json().account.centreIds[0] === mine.centre);

  const packets = (await get(`/packages?examId=${exam.id}`, second)).json().packages;
  check("its packet list holds its centre's packet and not the other's",
    packets.length === 1 && packets[0].id === mine.packet);
  const asked = (await get(`/packages?centreId=${theirs.centre}`, second)).json().packages;
  check("asking for the other centre by id returns nothing", asked.length === 0);

  const own = await get(`/packages/${mine.packet}`, second);
  const other = await get(`/packages/${theirs.packet}`, second);
  const absent = await get(`/packages/${exam.id}`, second);
  check("its own packet opens", own.statusCode === 200 && own.json().id === mine.packet);
  check("another centre's packet answers exactly as one that does not exist",
    other.statusCode === 404 && other.body === absent.body);

  const legs = (await get("/legs", second)).json().legs;
  check("it sees its centre's hand-off and not the other's",
    legs.some((l) => l.id === mine.leg) && !legs.some((l) => l.id === theirs.leg) &&
    legs.every((l) => l.package_id === mine.packet));
  const legsAsked = (await get(`/legs?packageId=${theirs.packet}`, second)).json().legs;
  check("naming the other packet's hand-offs returns nothing", legsAsked.length === 0);

  const alerts = (await get("/alerts?limit=500", second)).json().alerts;
  check("it sees its centre's alert and no other",
    alerts.length === 1 && alerts[0].id === mine.alert);
  const all = (await get("/alerts?limit=500", operator)).json().alerts;
  check("an operator with no limit still sees both, and the alert about the change",
    all.some((a) => a.id === mine.alert) && all.some((a) => a.id === theirs.alert) &&
    all.some((a) => a.kind === "ACCOUNT_CENTRES_CHANGED"));

  const summary = (await get("/alerts/summary", second)).json();
  check("its alert count is its centre's alerts, not everybody's",
    summary.total === 1 && summary.unacknowledged === 1);
  const exams = (await get("/exams", second)).json().exams;
  check("it is offered its centre's exam, counted over its own centre only",
    exams.length === 1 && exams[0].id === exam.id && exams[0].centreCount === 1 && exams[0].packageCount === 1);

  // A phone enrolled at the first centre, and one enrolled at none. What the
  // ledger is told is which device the gateway verified.
  const device = async (centreId) => (await client.query(
    "insert into ref.device (kind,pubkey,centre_id) values ('field',$1,$2) returning id",
    [randomBytes(32), centreId],
  )).rows[0].id;
  const asDevice = async (id, path) =>
    (await app.inject({ method: "GET", url: path, headers: { "x-mohar-verified-device": id } })).json().legs;
  const atCentre = await device(mine.centre);
  const roaming = await device(null);
  const phoneLegs = await asDevice(atCentre, "/legs");
  check("a phone enrolled at a centre reads that centre's hand-offs and no other's",
    phoneLegs.some((l) => l.id === mine.leg) && phoneLegs.every((l) => l.package_id === mine.packet));
  check("and gets nothing by naming another centre's packet",
    (await asDevice(atCentre, `/legs?packageId=${theirs.packet}`)).length === 0);
  check("a phone enrolled at no centre still reads the leg it was sent for",
    (await asDevice(roaming, `/legs?packageId=${theirs.packet}`)).some((l) => l.id === theirs.leg));

  const closed = [
    ["GET", "/centres"],
    ["GET", "/devices"],
    ["GET", "/auth/accounts"],
    ["GET", `/legs/${mine.leg}/attempts`],
    ["POST", `/alerts/${mine.alert}/ack`],
    ["POST", `/packages/${mine.packet}/declared-state`],
    ["PUT", `/auth/accounts/${second.id}/centres`],
  ];
  let refused = 0;
  for (const [method, path] of closed) {
    const res = await app.inject({ method, url: path, headers: second.headers, payload: method === "GET" ? undefined : {} });
    if (res.statusCode === 403 && res.json().reason === "account_scoped") refused += 1;
  }
  check("every other route refuses it, its own centre's included, and it cannot lift its own limit",
    refused === closed.length);
  const [{ acks }] = (await client.query(
    "select count(*)::int as acks from led.alert_ack where alert_id = $1", [mine.alert],
  )).rows;
  check("the refused acknowledgement recorded nothing", acks === 0);

  const last = await setCentres(operator.id, [mine.centre], operator);
  check("the last operator with no limit cannot be given one", last.statusCode === 409);

  const lifted = await setCentres(second.id, [], operator);
  check("an empty list lifts the limit", lifted.statusCode === 200 && lifted.json().centreIds.length === 0);
  const after = await get(`/packages?examId=${exam.id}`, second);
  check("and the account sees both centres again", after.json().packages.length === 2);
  const [{ n }] = (await client.query(
    "select count(*)::int as n from led.alert where kind = 'ACCOUNT_CENTRES_CHANGED' and evidence ->> 'accountId' = $1",
    [second.id],
  )).rows;
  check("lifting it is raised as well", n === 2);

  // ── by district ──
  const district = `Zila ${tag}`;
  const put = (centreIds, name) =>
    app.inject({ method: "POST", url: "/centres/district", headers: operator.headers, payload: { centreIds, district: name } });
  const districtAlerts = async () => (await client.query(
    "select evidence, consequence from led.alert where kind = 'CENTRE_DISTRICT_CHANGED' and evidence ->> 'district' is not distinct from $1 order by raised_at",
    [district],
  )).rows;

  const noSuch = await app.inject({ method: "PUT", url: `/auth/accounts/${second.id}/centres`,
    headers: operator.headers, payload: { centreIds: [], districts: [district] } });
  check("a limit to a district no centre is in is refused as a likely misspelling", noSuch.statusCode === 400);

  const placed = await put([mine.centre], district);
  check("an operator puts a centre in a district", placed.statusCode === 200 && placed.json().changed === 1);
  check("with no account limited to it, that changes nobody's view and raises nothing",
    placed.json().accountsAffected === 0 && (await districtAlerts()).length === 0);

  const byDistrict = await app.inject({ method: "PUT", url: `/auth/accounts/${second.id}/centres`,
    headers: operator.headers, payload: { centreIds: [], districts: [district.toUpperCase()] } });
  check("an account is limited to the district, however the name was capitalised",
    byDistrict.statusCode === 200 && byDistrict.json().limited === true &&
    byDistrict.json().districts.length === 1 && byDistrict.json().districts[0] === district);

  const inDistrict = (await get(`/packages?examId=${exam.id}`, second)).json().packages;
  check("it sees the district's one centre", inDistrict.length === 1 && inDistrict[0].id === mine.packet);

  const joined = await put([theirs.centre], district);
  check("a second centre joins the district, and the move is raised because an account's view changed",
    joined.statusCode === 200 && joined.json().accountsAffected === 1 && (await districtAlerts()).length === 1);
  const [moved] = await districtAlerts();
  check("the alert names the centre, the account and who moved it, and does not rank itself",
    moved.evidence.centres[0].id === theirs.centre &&
    moved.evidence.accountsAffected[0].id === second.id &&
    moved.evidence.changedByAccountId === operator.id &&
    !/critical|high|medium|low|severe|urgent/i.test(moved.consequence));
  const both = (await get(`/packages?examId=${exam.id}`, second)).json().packages;
  check("the account sees the new centre at once, with nobody touching the account", both.length === 2);

  await put([mine.centre, theirs.centre], null);
  const none = (await get(`/packages?examId=${exam.id}`, second)).json().packages;
  const stillLimited = (await get("/auth/me", second)).json().account;
  const stillRefused = await get("/devices", second);
  check("with both centres taken out, it sees nothing, and is still limited rather than set free",
    none.length === 0 && stillLimited.limited === true &&
    stillRefused.statusCode === 403 && stillRefused.json().reason === "account_scoped");

  const limitedMove = await app.inject({ method: "POST", url: "/centres/district", headers: second.headers,
    payload: { centreIds: [theirs.centre], district } });
  check("a limited account cannot put a centre in its own district",
    limitedMove.statusCode === 403 && limitedMove.json().reason === "account_scoped");
} finally {
  await client.query("rollback");
  await app.close();
  await client.end();
}
console.log(`${passed}/${passed} account scope checks passed; transaction rolled back`);
