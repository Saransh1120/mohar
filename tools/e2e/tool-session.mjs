#!/usr/bin/env node
/**
 * A tool signing in as an operator, against the ledger's real auth routes and
 * a real Postgres, leaving nothing behind.
 *
 *   E2E_OWNER_URL=postgres://<schema owner>@host/<db>  node tools/e2e/tool-session.mjs
 *
 * `@mohar/ledger-client` is what seed, label-print, demo-setup and
 * provision-device use to present an operator's session to the gateway. Its
 * own unit tests run it against a stand-in. Here it signs in to the built auth
 * routes with an account this script makes, reads a route that needs a
 * session, signs out, and is then refused.
 *
 * The account's password is generated here, used once, and never printed.
 * Everything runs inside one transaction that is rolled back.
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
const { registerAuthRoutes } = await import(at("services/ledger/dist/http/auth-routes.js"));
const { createAccount } = await import(at("services/ledger/dist/domain/accounts.js"));
const { openSession, LedgerSignInError } = await import(at("packages/ledger-client/dist/index.js"));

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

const results = [];
const expect = (name, ok, detail = "") => results.push({ name, ok, detail });

const app = Fastify({ logger: false });
registerAuthRoutes(app, pool);
await app.ready();

// The client speaks HTTP; this hands its requests to the routes without a port.
const BASE = "http://ledger.e2e";
const viaRoutes = async (url, init = {}) => {
  const res = await app.inject({
    method: init.method ?? "GET",
    url: url.slice(BASE.length),
    headers: init.headers ?? {},
    ...(init.body ? { payload: init.body } : {}),
  });
  return new Response(res.body, { status: res.statusCode });
};
const me = async (headers) => (await viaRoutes(`${BASE}/auth/me`, { headers })).status;

const tag = randomBytes(3).toString("hex");
const username = `tool-${tag}`;
await client.query("begin");
try {
  const password = `${randomBytes(18).toString("base64url")}aA1!`;
  await createAccount(scoped, { username, password, displayName: "Tool operator", role: "control_room" });

  expect("with no credential a tool is not signed in", (await me({})) === 401);

  const none = await openSession(BASE, {}, viaRoutes);
  expect("nothing in the environment means no credential is sent", none.via === "none" && Object.keys(none.headers).length === 0);

  let refused = null;
  try {
    await openSession(BASE, { MOHAR_OPERATOR: username, MOHAR_OPERATOR_PASSWORD: `${password}x` }, viaRoutes);
  } catch (err) {
    refused = err;
  }
  expect("a wrong password is refused by the real route, and the error does not repeat it",
    refused instanceof LedgerSignInError && /refused \(401\)/.test(refused.message) && !refused.message.includes(password),
    String(refused?.message));

  const session = await openSession(BASE, { MOHAR_OPERATOR: username, MOHAR_OPERATOR_PASSWORD: password }, viaRoutes);
  expect("the right password signs the tool in as that operator",
    session.via === "sign-in" && session.signedInAs === username && /^Bearer /.test(session.headers.authorization ?? ""));
  expect("its header is accepted where a session is needed", (await me(session.headers)) === 200);

  const { rows: open } = await client.query(
    `select count(*)::int as n from ref.session s join ref.account a on a.id = s.account_id
      where a.username = $1 and s.revoked_at is null`, [username]);
  expect("one session is open for it", open[0].n === 1, `${open[0].n}`);

  await session.close();
  expect("closing signs it out: the same header is refused afterwards", (await me(session.headers)) === 401);
  const { rows: after } = await client.query(
    `select count(*)::int as n from ref.session s join ref.account a on a.id = s.account_id
      where a.username = $1 and s.revoked_at is null`, [username]);
  expect("and no session is left open", after[0].n === 0, `${after[0].n}`);

  // A session the operator already holds is used and left alone.
  const held = await openSession(BASE, { MOHAR_OPERATOR: username, MOHAR_OPERATOR_PASSWORD: password }, viaRoutes);
  const token = held.headers.authorization.slice("Bearer ".length);
  const lent = await openSession(BASE, { MOHAR_SESSION_TOKEN: token }, viaRoutes);
  await lent.close();
  expect("a supplied session token is used as it is and is still good after the tool closes",
    lent.via === "token" && (await me(lent.headers)) === 200);
  await held.close();
} catch (err) {
  expect("the run completed", false, err.stack ?? String(err));
} finally {
  await client.query("rollback").catch(() => {});
  const left = await client
    .query(`select count(*)::int as n from ref.account where username = $1`, [username])
    .then((r) => r.rows[0].n).catch(() => -1);
  expect("nothing was left in the database", left === 0, `${left} row(s)`);
  await app.close();
  await client.end();
}

let failedCount = 0;
for (const r of results) {
  if (!r.ok) failedCount += 1;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${!r.ok && r.detail ? `\n        ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
