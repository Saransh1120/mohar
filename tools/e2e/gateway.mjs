#!/usr/bin/env node
/**
 * The gateway in front of the real ledger routes, against a real Postgres,
 * leaving nothing behind.
 *
 *   E2E_OWNER_URL=postgres://<schema owner>@host/<db>  node tools/e2e/gateway.mjs
 *
 * Safe to point at a database you care about: like sweeps.mjs and seal.mjs,
 * everything the ledger writes - two accounts, their sessions, a device, a
 * chain event, a refused hand-off attempt - happens inside one transaction that
 * is rolled back at the end.
 *
 * Two real servers, both on loopback ports the system picks:
 *
 *   this script --HTTP--> gateway (services/gateway/dist) --HTTP--> ledger routes
 *
 * The ledger side is the built route code from services/ledger/dist with its
 * gateway guard switched on, so it answers nobody but the gateway. The gateway
 * is the built one, unmodified. Every status below is what those two processes
 * actually answered; services/gateway's own unit tests cover the same rules
 * against a stand-in, and this is the check that the stand-in told the truth
 * about the ledger.
 *
 * Needs every migration applied. Build first (`pnpm build`).
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

// Read by the auth routes when they load. Sign-up must be in its default state.
delete process.env.ALLOW_SIGNUP;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(root, "services", "ledger", "package.json"));
const pg = require("pg");
const Fastify = require("fastify");
const at = (p) => new URL(`../../${p}`, import.meta.url).href;
const { registerAuthRoutes } = await import(at("services/ledger/dist/http/auth-routes.js"));
const { registerRoutes } = await import(at("services/ledger/dist/http/routes.js"));
const { registerRegistryRoutes } = await import(at("services/ledger/dist/http/registry-routes.js"));
const { registerTransferRoutes } = await import(at("services/ledger/dist/http/transfer-routes.js"));
const { registerAlertRoutes } = await import(at("services/ledger/dist/http/alert-routes.js"));
const { registerGatewayGuard } = await import(at("services/ledger/dist/http/gateway-guard.js"));
const { createAccount } = await import(at("services/ledger/dist/domain/accounts.js"));
const { buildGateway } = await import(at("services/gateway/dist/app.js"));
const { configFromEnv } = await import(at("services/gateway/dist/config.js"));
const { generateKeypair, signBody, signedRequestHeaders } = await import(
  at("packages/crypto-core/dist/index.js")
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
const show = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

const SECRET = randomBytes(24).toString("hex");
const tag = randomBytes(3).toString("hex");
const PASSWORD = `e2e-${randomBytes(12).toString("hex")}`;

// ── the ledger's routes, answering only to the gateway ──
const ledger = Fastify({ logger: false, trustProxy: "127.0.0.1" });
registerGatewayGuard(ledger, { GATEWAY_SECRET: SECRET });
registerAuthRoutes(ledger, pool);
registerRoutes(ledger, pool);
registerRegistryRoutes(ledger, pool);
registerTransferRoutes(ledger, pool);
registerAlertRoutes(ledger, pool);
await ledger.listen({ port: 0, host: "127.0.0.1" });
const ledgerUrl = `http://127.0.0.1:${ledger.server.address().port}`;

// ── the gateway ──
const gateway = await buildGateway({
  config: configFromEnv({ LEDGER_URL: ledgerUrl, GATEWAY_SECRET: SECRET }),
  logger: false,
});
await gateway.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${gateway.server.address().port}`;

async function call(method, path, { token, headers = {}, body, origin = base } = {}) {
  const sent = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(origin + path, {
    method,
    headers: {
      ...(sent === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(sent === undefined ? {} : { body: sent }),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

await client.query("begin");
try {
  // Two accounts, made the way the ledger makes them, inside the transaction.
  const operatorName = `e2e-op-${tag}`;
  const observerName = `e2e-obs-${tag}`;
  await createAccount(scoped, { username: operatorName, password: PASSWORD, displayName: "E2E Operator", role: "control_room" });
  await createAccount(scoped, { username: observerName, password: PASSWORD, displayName: "E2E Observer", role: "observer" });

  // ── the ledger answers only to its gateway ──
  const direct = await call("GET", "/health", { origin: ledgerUrl });
  expect("the ledger, reached directly without the gateway's secret, refuses",
    direct.status === 401 && direct.body?.reason === "not_from_gateway", show(direct));
  const directKey = await call("POST", "/keys/issue", { origin: ledgerUrl, body: {} });
  expect("that includes the routes that used to be open", directKey.status === 401, show(directKey));

  const health = await call("GET", "/health");
  expect("through the gateway, /health is public and is the ledger's own answer",
    health.status === 200 && health.body?.ok === true && "chainTip" in health.body, show(health));

  // ── sign-up is closed ──
  const config = await call("GET", "/auth/config");
  expect("with accounts in existence, the ledger reports registration closed",
    config.status === 200 && config.body?.signUpOpen === false, show(config));
  const signup = await call("POST", "/auth/signup", {
    body: { username: `e2e-new-${tag}`, password: PASSWORD, displayName: "Somebody", role: "control_room" },
  });
  expect("a stranger cannot register themselves as a control room operator",
    signup.status === 403 && /closed/i.test(signup.body?.error ?? ""), show(signup));

  // ── signing in ──
  const wrong = await call("POST", "/auth/signin", { body: { username: operatorName, password: "not the password" } });
  expect("a wrong password is refused by the ledger, through the gateway", wrong.status === 401, show(wrong));
  const opIn = await call("POST", "/auth/signin", { body: { username: operatorName, password: PASSWORD } });
  const obsIn = await call("POST", "/auth/signin", { body: { username: observerName, password: PASSWORD } });
  const op = opIn.body?.token;
  const obs = obsIn.body?.token;
  expect("the operator and the observer sign in", opIn.status === 200 && obsIn.status === 200 && op && obs, show(opIn));

  // ── reads need an account ──
  const anon = await call("GET", "/packages");
  expect("a read with no session is refused at the gateway",
    anon.status === 401 && anon.body?.reason === "not_signed_in", show(anon));
  const read = await call("GET", "/packages", { token: obs });
  expect("a read with a session is the ledger's answer",
    read.status === 200 && Array.isArray(read.body?.packages), show(read));

  // ── /keys/issue ──
  const keyAnon = await call("POST", "/keys/issue", { body: { packageId: randomUUID(), stage: "unlock" } });
  const keyObs = await call("POST", "/keys/issue", { token: obs, body: { packageId: randomUUID(), stage: "unlock" } });
  expect("issuing a key with no session is refused", keyAnon.status === 401, show(keyAnon));
  expect("issuing a key as an observer is refused, with the role held and the role needed",
    keyObs.status === 403 && keyObs.body?.roleHeld === "observer" && keyObs.body?.roleNeeded === "control_room",
    show(keyObs));

  // ── accounts are an operator's to create ──
  const madeName = `e2e-made-${tag}`;
  const byObs = await call("POST", "/auth/accounts", {
    token: obs, body: { username: madeName, password: PASSWORD, displayName: "Made", role: "courier" } });
  expect("an observer cannot create an account", byObs.status === 403, show(byObs));
  const byOp = await call("POST", "/auth/accounts", {
    token: op, body: { username: madeName, password: PASSWORD, displayName: "Made By Operator", role: "courier" } });
  expect("an operator can, and is not signed in as it",
    byOp.status === 201 && byOp.body?.account?.role === "courier" && !("token" in byOp.body), show(byOp));
  const madeIn = await call("POST", "/auth/signin", { body: { username: madeName, password: PASSWORD } });
  const made = madeIn.body?.token;
  const madeRead = await call("GET", "/exams", { token: made });
  expect("the new account signs in and reads", madeIn.status === 200 && madeRead.status === 200, show(madeRead));

  const disabled = await call("POST", `/auth/accounts/${byOp.body?.account?.id}/disable`, {
    token: op, body: { reason: "e2e: leaving the posting" } });
  const afterDisable = await call("GET", "/exams", { token: made });
  expect("disabling it ends its session at the gateway at once, not after the cache runs out",
    disabled.status === 200 && afterDisable.status === 401, `${show(disabled)} then ${show(afterDisable)}`);

  // ── /devices ──
  const key = generateKeypair();
  const enrolAnon = await call("POST", "/devices", { body: { kind: "monitor", pubkeyHex: key.publicKeyHex } });
  const enrolObs = await call("POST", "/devices", { token: obs, body: { kind: "monitor", pubkeyHex: key.publicKeyHex } });
  expect("enrolling a device with no session, or as an observer, is refused",
    enrolAnon.status === 401 && enrolObs.status === 403, `${show(enrolAnon)} / ${show(enrolObs)}`);
  const enrolled = await call("POST", "/devices", { token: op, body: { kind: "monitor", pubkeyHex: key.publicKeyHex } });
  const deviceId = enrolled.body?.id;
  expect("an operator enrols it", enrolled.status === 201 && typeof deviceId === "string", show(enrolled));

  // ── /events ──
  const [auth] = await q(`insert into ref.authority (name) values ($1) returning id`, [`gateway e2e ${tag}`]);
  const [exam] = await q(
    `insert into ref.exam (authority_id, name, mode, starts_at, drand_round, sides_per_copy)
     values ($1,$2,'escorted', now() + interval '1 day', 21000000, 4) returning id`,
    [auth.id, `Physics ${tag}`]);
  const heartbeat = (sequence) => ({
    v: 1,
    id: randomUUID(),
    kind: "MONITOR_HEARTBEAT",
    examId: exam.id,
    occurredAt: new Date().toISOString(),
    actorDeviceId: deviceId,
    payload: { monitorId: deviceId, sequence, bufferedRecords: 0 },
  });
  const tipBefore = (await call("GET", "/health")).body?.chainTip?.seq ?? "0";

  const forgedBody = heartbeat(1);
  const forged = await call("POST", "/events", {
    body: { body: forgedBody, deviceSig: signBody(forgedBody, generateKeypair().privateKeyHex) } });
  expect("an event naming the device but signed by another key is refused at the gateway",
    forged.status === 401 && forged.body?.reason === "signature_invalid", show(forged));
  const bySession = await call("POST", "/events", { token: op, body: { body: forgedBody, deviceSig: "00" } });
  expect("an operator's session does not stand in for a device's signature", bySession.status === 401, show(bySession));
  expect("neither moved the chain",
    ((await call("GET", "/health")).body?.chainTip?.seq ?? "0") === tipBefore);

  const body1 = heartbeat(2);
  const appended = await call("POST", "/events", { body: { body: body1, deviceSig: signBody(body1, key.privateKeyHex) } });
  expect("an event signed by the enrolled device is appended to the chain",
    appended.status === 201 && appended.body?.status === "appended" && /^[0-9a-f]{64}$/.test(appended.body?.hash ?? ""),
    show(appended));
  const tipAfter = (await call("GET", "/health")).body?.chainTip;
  expect("and is the new chain tip", tipAfter?.hash === appended.body?.hash, JSON.stringify(tipAfter));

  // ── a device signing a request to an engine ──
  const legPath = `/legs/${randomUUID()}/dispatch`;
  const step = JSON.stringify({ deviceId, packetSerialTyped: `PKT-GW-${tag}` });
  const signed = signedRequestHeaders(deviceId, key.privateKeyHex, { method: "POST", path: legPath, body: step });
  const ruled = await call("POST", legPath, { headers: signed, body: step });
  expect("a hand-off step signed by the device reaches the hand-off engine, which rules on it",
    ruled.status === 200 && ruled.body?.outcome === "refused" &&
      ruled.body?.checks?.some((c) => c.check === "leg_known" && c.passed === false),
    show(ruled));
  const replayed = await call("POST", legPath, { headers: signed, body: step });
  expect("the same signed request played back is refused",
    replayed.status === 401 && replayed.body?.reason === "nonce_replayed", show(replayed));
  const other = JSON.stringify({ deviceId: randomUUID(), packetSerialTyped: `PKT-GW-${tag}` });
  const asOther = await call("POST", legPath, {
    headers: signedRequestHeaders(deviceId, key.privateKeyHex, { method: "POST", path: legPath, body: other }),
    body: other });
  expect("a device signing a request that names another device is refused",
    asOther.status === 403 && asOther.body?.reason === "device_mismatch", show(asOther));
  const unsigned = await call("POST", legPath, { token: op, body: step });
  expect("the same step with an operator's session and no device signature is refused",
    unsigned.status === 401 && unsigned.body?.reason === "device_signature_required", show(unsigned));
  const [attempts] = await q(
    `select count(*)::int as n from led.transfer_attempt where serial_typed = $1`, [`PKT-GW-${tag}`]);
  expect("only the one request that was let through is on the engine's record",
    attempts.n === 1, `${attempts.n} attempt(s)`);

  // ── revoking the device ──
  const revoke = await call("POST", `/devices/${deviceId}/revoke`, { token: op });
  const body2 = heartbeat(3);
  const afterRevoke = await call("POST", "/events", { body: { body: body2, deviceSig: signBody(body2, key.privateKeyHex) } });
  expect("once revoked, the device's next event is refused at the gateway at once",
    revoke.status === 200 && afterRevoke.status === 401 && afterRevoke.body?.reason === "device_revoked",
    `${show(revoke)} then ${show(afterRevoke)}`);

  // ── streams ──
  const noTicket = await fetch(`${base}/alerts/stream`);
  expect("a stream with no ticket and no session is refused", noTicket.status === 401, String(noTicket.status));
  await noTicket.body?.cancel();
  const ticket = (await call("POST", "/gateway/stream-ticket", { token: obs })).body?.ticket;
  const stream = await fetch(`${base}/alerts/stream?ticket=${encodeURIComponent(ticket)}`);
  const reader = stream.body.getReader();
  const frame = Buffer.from((await reader.read()).value ?? []).toString("utf8");
  expect("with a ticket, the ledger's alert stream arrives frame by frame",
    stream.status === 200 && /^event: alerts\ndata: \{/.test(frame), `${stream.status} ${frame.slice(0, 120)}`);
  await reader.cancel();
  const spent = await call("GET", `/alerts/stream?ticket=${encodeURIComponent(ticket)}`);
  expect("the ticket opens one stream and no more", spent.status === 401 && spent.body?.reason === "ticket_invalid", show(spent));

  // ── sign-in is limited before it costs the ledger a scrypt ──
  let refusedAt = 0;
  for (let i = 1; i <= 12 && !refusedAt; i++) {
    const r = await call("POST", "/auth/signin", { body: { username: `e2e-nobody-${tag}`, password: "guess" } });
    if (r.status === 429) refusedAt = i;
  }
  // Ten are allowed at once; four were used above for real sign-ins from this address.
  expect("guessing passwords from one address is cut off by the gateway",
    refusedAt > 0 && refusedAt <= 11, `429 at attempt ${refusedAt}`);

  // ── what the gateway kept ──
  const status = await call("GET", "/gateway/status", { token: op });
  const reasons = Object.keys(status.body?.refusedByReason ?? {});
  expect("the operator can read what was refused, by reason, with the evidence",
    status.status === 200 &&
      ["not_signed_in", "role_not_permitted", "signature_invalid", "nonce_replayed", "device_mismatch",
        "device_revoked", "device_signature_required", "ticket_invalid", "rate_limited"].every((r) => reasons.includes(r)),
    reasons.join(","));
  expect("an observer cannot", (await call("GET", "/gateway/status", { token: obs })).status === 403);
} catch (err) {
  expect("the run completed", false, err.stack ?? String(err));
} finally {
  await gateway.close().catch(() => {});
  await ledger.close().catch(() => {});
  await client.query("rollback").catch(() => {});
  const left = await client
    .query(
      `select (select count(*) from ref.account where username like $1)::int
            + (select count(*) from ref.authority where name like 'gateway e2e %')::int as n`,
      [`e2e-%-${tag}`])
    .then((r) => r.rows[0].n)
    .catch(() => -1);
  expect("nothing was left in the database", left === 0, `${left} row(s)`);
  await client.end();
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${!r.ok && r.detail ? `\n        ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
