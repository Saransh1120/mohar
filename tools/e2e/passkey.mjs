#!/usr/bin/env node
/**
 * An operator's passkey, against the ledger's real sign-in routes.
 *
 * E2E_OWNER_URL=postgres://<schema owner>@host/<db> node tools/e2e/passkey.mjs
 * Needs migration 019 and pnpm build. A software P-256 key stands in for the
 * authenticator, so what is checked is the ledger's side: the challenge, the
 * signature, the origin, the user-verified flag and the counter. The browser's
 * prompt and a real fingerprint are outside this test. Everything is rolled back.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(root, "services", "ledger", "package.json"));
const { Client } = require("pg");
const Fastify = require("fastify");
const at = (path) => new URL(`../../${path}`, import.meta.url).href;
const { registerAuthRoutes } = await import(at("services/ledger/dist/http/auth-routes.js"));
const { createAccount } = await import(at("services/ledger/dist/domain/accounts.js"));

const url = process.env.E2E_OWNER_URL;
if (!url) { console.error("Set E2E_OWNER_URL to a schema-owner database URL."); process.exit(2); }
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const client = new Client({ connectionString: url, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
await client.connect();
let depth = 0;
const scoped = {
  query: (sql, args) => {
    const text = typeof sql === "string" ? sql.trim().toLowerCase() : "";
    if (text === "begin") return client.query(`savepoint pk${++depth}`);
    if (text === "commit") return client.query(`release savepoint pk${depth--}`);
    if (text === "rollback") return client.query(`rollback to savepoint pk${depth--}`);
    return client.query(sql, args);
  },
  release: () => {},
};
const pool = { connect: async () => scoped, query: (sql, args) => client.query(sql, args) };
const app = Fastify({ logger: false });
registerAuthRoutes(app, pool);
await app.ready();
let passed = 0;
const check = (label, condition) => { assert.ok(condition, label); console.log(`ok ${++passed} - ${label}`); };

// ── a software authenticator ──
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const rpHash = createHash("sha256").update("localhost").digest();
const clientData = (type, challenge, origin = "http://localhost:5173") =>
  Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
function authenticator() {
  const credId = randomBytes(16);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = Buffer.concat([
    Buffer.from([0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, "base64url"),
    Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, "base64url"),
  ]);
  return {
    id: b64(credId),
    create(challenge) {
      const authData = Buffer.concat([rpHash, Buffer.from([0x45, 0, 0, 0, 0]), Buffer.alloc(16),
        Buffer.from([0, credId.length]), credId, cose]);
      const header = Buffer.from([0xa3, 0x63, 0x66, 0x6d, 0x74, 0x64, 0x6e, 0x6f, 0x6e, 0x65, 0x67, 0x61, 0x74,
        0x74, 0x53, 0x74, 0x6d, 0x74, 0xa0, 0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61]);
      // A roaming key: no attachment is reported, as a security key on a desk would not.
      return { id: b64(credId), rawId: b64(credId), type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: b64(clientData("webauthn.create", challenge)),
          attestationObject: b64(Buffer.concat([header, Buffer.from([0x58, authData.length]), authData])),
          transports: ["usb"] } };
    },
    get(challenge, { counter = 1, verified = true, origin } = {}) {
      const data = Buffer.concat([rpHash, Buffer.from([verified ? 0x05 : 0x01, 0, 0, 0, counter])]);
      const clientBytes = clientData("webauthn.get", challenge, origin);
      const signature = sign("sha256", Buffer.concat([data, createHash("sha256").update(clientBytes).digest()]), privateKey);
      return { id: b64(credId), rawId: b64(credId), type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: b64(clientBytes), authenticatorData: b64(data), signature: b64(signature) } };
    },
  };
}

await client.query("begin");
try {
  const tag = randomBytes(3).toString("hex");
  // Passwords that exist only for this run.
  const make = async (name) => {
    const password = randomBytes(18).toString("base64url");
    const made = await createAccount(scoped, { username: name, displayName: name, password, role: "control_room" });
    return { id: made.id, username: name, password };
  };
  const op = await make(`pk-op-${tag}`);
  const other = await make(`pk-other-${tag}`);

  let from = 0;
  // Each call from its own address, so the ledger's own attempt limit is not what is being tested.
  const post = (path, payload, token) => app.inject({ method: "POST", url: path, payload,
    remoteAddress: `10.9.${Math.floor(from / 250)}.${(from++ % 250) + 1}`,
    headers: token ? { authorization: `Bearer ${token}` } : {} });
  const signIn = (who) => post("/auth/signin", { username: who.username, password: who.password });
  const sessions = async (who) => (await client.query(
    "select count(*)::int as n from ref.session where account_id = $1", [who.id])).rows[0].n;

  const plain = await signIn(op);
  check("with no passkey, the password signs the account in", plain.statusCode === 200 && typeof plain.json().token === "string");
  const token = plain.json().token;
  const otherToken = (await signIn(other)).json().token;

  const key = authenticator();
  const begun = (await post("/auth/passkey/register/challenge", {}, token)).json();
  check("the account is given a challenge to enrol a passkey against",
    typeof begun.challengeId === "string" && begun.options.rp.id === "localhost" &&
    begun.options.authenticatorSelection.userVerification === "required");

  const stolen = await post("/auth/passkey/register/complete",
    { challengeId: begun.challengeId, response: key.create(begun.options.challenge) }, otherToken);
  check("another account cannot finish this account's enrolment", stolen.statusCode === 409);

  const again = (await post("/auth/passkey/register/challenge", {}, token)).json();
  const unverified = authenticator();
  const noUv = unverified.create(again.options.challenge);
  // Flip the user-verified bit off in the authenticator data (flags byte follows the 32-byte RP hash).
  const raw = Buffer.from(noUv.response.attestationObject, "base64url");
  const flagsAt = raw.indexOf(rpHash) + 32;
  raw[flagsAt] = 0x41;
  noUv.response.attestationObject = b64(raw);
  const weak = await post("/auth/passkey/register/complete", { challengeId: again.challengeId, response: noUv }, token);
  check("a credential that did not verify its user is not enrolled", weak.statusCode === 422);

  const third = (await post("/auth/passkey/register/challenge", {}, token)).json();
  const enrolled = await post("/auth/passkey/register/complete",
    { challengeId: third.challengeId, response: key.create(third.options.challenge), label: "e2e key" }, token);
  check("a roaming key that verified its user is enrolled", enrolled.statusCode === 201 && enrolled.json().passkey.label === "e2e key");
  const replayed = await post("/auth/passkey/register/complete",
    { challengeId: third.challengeId, response: key.create(third.options.challenge) }, token);
  check("the enrolment challenge is good once", replayed.statusCode === 409);

  const [added] = (await client.query(
    "select evidence, consequence, requires_decision from led.alert where kind = 'ACCOUNT_PASSKEY_ADDED' and evidence ->> 'accountId' = $1", [op.id])).rows;
  check("the enrolment is raised as an alert that does not rank itself",
    added?.evidence?.passkeysBefore === 0 && !/critical|high|medium|low|severe|urgent/i.test(added.consequence));
  const stored = (await client.query(
    "select encode(public_key,'hex') as k from ref.account_passkey where account_id = $1", [op.id])).rows[0].k;
  check("what is kept is a public key; nothing in the alert carries it", !JSON.stringify(added.evidence).includes(stored));

  const before = await sessions(op);
  const first = await signIn(op);
  check("the password now earns a challenge and no session",
    first.statusCode === 200 && first.json().passkeyRequired === true && first.json().token === undefined &&
    first.json().options.allowCredentials[0].id === key.id && (await sessions(op)) === before);
  const wrongPassword = await post("/auth/signin", { username: op.username, password: "not-the-password-at-all" });
  check("a wrong password is refused as before, with no challenge", wrongPassword.statusCode === 401 && !wrongPassword.json().signInId);

  const impostor = authenticator();
  const forged = impostor.get(first.json().options.challenge);
  forged.id = key.id; forged.rawId = key.id;
  const byImpostor = await post("/auth/signin/passkey", { signInId: first.json().signInId, response: forged });
  check("an assertion signed by a different key is refused", byImpostor.statusCode === 401);
  const afterFailure = await post("/auth/signin/passkey",
    { signInId: first.json().signInId, response: key.get(first.json().options.challenge) });
  check("and the challenge it failed against is spent: the right key cannot use it afterwards",
    afterFailure.statusCode === 401 && (await sessions(op)) === before);

  const tries = [
    ["without the user verified", (c) => key.get(c, { verified: false })],
    ["from another origin", (c) => key.get(c, { origin: "https://control.example" })],
  ];
  for (const [what, respond] of tries) {
    const step = (await signIn(op)).json();
    const res = await post("/auth/signin/passkey", { signInId: step.signInId, response: respond(step.options.challenge) });
    check(`an assertion ${what} is refused`, res.statusCode === 401);
  }
  const mixed = (await signIn(op)).json();
  const otherStep = (await signIn(op)).json();
  const crossed = await post("/auth/signin/passkey", { signInId: mixed.signInId, response: key.get(otherStep.options.challenge) });
  check("an assertion over a different challenge is refused", crossed.statusCode === 401);

  const good = (await signIn(op)).json();
  const opened = await post("/auth/signin/passkey", { signInId: good.signInId, response: key.get(good.options.challenge, { counter: 5 }) });
  check("the right key over the right challenge opens the session",
    opened.statusCode === 200 && typeof opened.json().token === "string" && opened.json().account.passkeys === 1);
  const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${opened.json().token}` } });
  check("that session is the account's", me.statusCode === 200 && me.json().account.id === op.id);
  const twice = await post("/auth/signin/passkey", { signInId: good.signInId, response: key.get(good.options.challenge, { counter: 6 }) });
  check("the sign-in challenge is good once", twice.statusCode === 401);

  const older = (await signIn(op)).json();
  const rolledBack = await post("/auth/signin/passkey", { signInId: older.signInId, response: key.get(older.options.challenge, { counter: 3 }) });
  check("a counter that went backwards is refused, as a copied key would show", rolledBack.statusCode === 401);

  const list = (await app.inject({ method: "GET", url: "/auth/accounts", headers: { authorization: `Bearer ${otherToken}` } })).json().accounts;
  check("the accounts list says which accounts hold a passkey",
    list.find((a) => a.id === op.id)?.passkeys === 1 && list.find((a) => a.id === other.id)?.passkeys === 0);

  const removed = await post(`/auth/accounts/${op.id}/passkeys/remove`, {}, otherToken);
  check("another operator removes the passkeys", removed.statusCode === 200 && removed.json().removed === 1);
  const [gone] = (await client.query(
    "select evidence, requires_decision from led.alert where kind = 'ACCOUNT_PASSKEYS_REMOVED' and evidence ->> 'accountId' = $1", [op.id])).rows;
  check("that is raised as an alert somebody has to acknowledge, naming who did it",
    gone?.requires_decision === true && gone.evidence.removedByAccountId === other.id);
  const [{ kept }] = (await client.query(
    "select count(*)::int as kept from ref.account_passkey where account_id = $1 and removed_at is not null", [op.id])).rows;
  check("the passkey's row is kept, marked removed", kept === 1);
  const back = await signIn(op);
  check("the password signs the account in alone again", back.statusCode === 200 && typeof back.json().token === "string");

  const fourth = (await post("/auth/passkey/register/challenge", {}, back.json().token)).json();
  const reenrolled = await post("/auth/passkey/register/complete",
    { challengeId: fourth.challengeId, response: key.create(fourth.options.challenge) }, back.json().token);
  check("the same authenticator can be enrolled again after it was removed", reenrolled.statusCode === 201);
} finally {
  await client.query("rollback");
  await app.close();
  await client.end();
}
console.log(`${passed}/${passed} passkey checks passed; transaction rolled back`);
