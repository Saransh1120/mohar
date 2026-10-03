#!/usr/bin/env node
/** Real WebAuthn registration and a signed dispatch, all in one rolled-back transaction.
 * E2E_OWNER_URL=postgres://<schema owner>@host/<db> node tools/e2e/webauthn.mjs
 * Needs migration 016 and pnpm build. A software key emulates the authenticator;
 * the browser prompt and a real phone are outside this test.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(root, "services", "ledger", "package.json"));
const pg = require("pg");
const Fastify = require("fastify");
const at = (p) => new URL(`../../${p}`, import.meta.url).href;
const { registerWebAuthnRoutes } = await import(at("services/ledger/dist/http/webauthn-routes.js"));
const { registerTransferRoutes } = await import(at("services/ledger/dist/http/transfer-routes.js"));
const { generateSeamLabel } = await import(at("packages/crypto-core/dist/index.js"));
const url = process.env.E2E_OWNER_URL;
if (!url) { console.error("Set E2E_OWNER_URL to the schema owner's connection string."); process.exit(2); }
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const client = new pg.Client({ connectionString: url, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
await client.connect();
let depth = 0;
const scoped = { query: (sql, params) => {
  const t = typeof sql === "string" ? sql.trim().toLowerCase() : "";
  if (t === "begin") return client.query(`savepoint s${++depth}`);
  if (t === "commit") return client.query(`release savepoint s${depth--}`);
  if (t === "rollback") return client.query(`rollback to savepoint s${depth--}`);
  return client.query(sql, params);
}, release: () => {} };
const pool = { connect: async () => scoped, query: (sql, params) => client.query(sql, params) };
const q = (sql, params) => client.query(sql, params).then((r) => r.rows);
const app = Fastify({ logger: false });
registerWebAuthnRoutes(app, pool);
registerTransferRoutes(app, pool);
await app.ready();
const post = async (path, payload, token) => {
  const res = await app.inject({ method: "POST", url: path, payload,
    headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const results = [];
const expect = (name, ok, detail = "") => results.push({ name, ok, detail });
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin: "http://localhost:5173", crossOrigin: false }));
const rpHash = createHash("sha256").update("localhost").digest();
const credId = randomBytes(16);
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const cose = Buffer.concat([
  Buffer.from([0xa5,1,2,3,0x26,0x20,1,0x21,0x58,0x20]), Buffer.from(jwk.x, "base64url"),
  Buffer.from([0x22,0x58,0x20]), Buffer.from(jwk.y, "base64url"),
]);
const attestation = (challenge) => {
  const authData = Buffer.concat([rpHash, Buffer.from([0x45,0,0,0,0]), Buffer.alloc(16),
    Buffer.from([0,credId.length]), credId, cose]);
  const header = Buffer.from([0xa3,0x63,0x66,0x6d,0x74,0x64,0x6e,0x6f,0x6e,0x65,0x67,0x61,0x74,0x74,0x53,0x74,0x6d,0x74,0xa0,0x68,0x61,0x75,0x74,0x68,0x44,0x61,0x74,0x61]);
  return { id: b64(credId), rawId: b64(credId), type: "public-key", authenticatorAttachment: "platform",
    clientExtensionResults: {}, response: { clientDataJSON: b64(clientData("webauthn.create", challenge)),
      attestationObject: b64(Buffer.concat([header, Buffer.from([0x58,authData.length]), authData])),
      transports: ["internal"] } };
};
const assertion = (challenge, counter = 1) => {
  const data = Buffer.concat([rpHash, Buffer.from([0x05,0,0,0,counter])]);
  const clientBytes = clientData("webauthn.get", challenge);
  const signature = sign("sha256", Buffer.concat([data, createHash("sha256").update(clientBytes).digest()]), privateKey);
  return { id: b64(credId), rawId: b64(credId), type: "public-key", authenticatorAttachment: "platform",
    clientExtensionResults: {}, response: { clientDataJSON: b64(clientBytes), authenticatorData: b64(data), signature: b64(signature) } };
};

const tag = randomBytes(3).toString("hex");
let packetId = null, personId = null, challengeId = null;
await client.query("begin");
try {
  const [auth] = await q(`insert into ref.authority (name) values ($1) returning id`, [`webauthn e2e ${tag}`]);
  const [exam] = await q(`insert into ref.exam (authority_id,name,mode,starts_at,drand_round,sides_per_copy)
    values ($1,$2,'escorted',now()+interval '1 day',21000000,4) returning id`, [auth.id, `WebAuthn ${tag}`]);
  const [centre] = await q(`insert into ref.centre (exam_id,code,lat,lon,capacity)
    values ($1,$2,26.9124,75.7873,300) returning id`, [exam.id, `WA-${tag}`]);
  const [pkg] = await q(`insert into ref.package (exam_id,centre_id,seal_serial,copies)
    values ($1,$2,$3,300) returning id`, [exam.id, centre.id, `PKT-WA-${tag}`]);
  packetId = pkg.id;
  const label = generateSeamLabel();
  await q(`insert into ref.seal_label (package_id,seam_id,commitment_hex) values ($1,$2,$3)`, [pkg.id,label.seamId,label.commitment]);
  const [person] = await q(`insert into ref.person (display_name,role,govt_id_hash)
    values ($1,'courier',$2) returning id`, [`WebAuthn courier ${tag}`, randomBytes(32)]);
  personId = person.id;
  const [device] = await q(`insert into ref.device (kind,pubkey) values ('field',$1) returning id`, [randomBytes(32)]);
  const [leg] = await q(`insert into ref.route_leg
    (package_id,leg_no,from_role,to_role,from_place,to_place,window_start,window_end,expected_by,geo_lat,geo_lon,geo_radius_m)
    values ($1,1,'courier','custodian','Press','Strong room',now()-interval '1 hour',now()+interval '1 hour',now()+interval '30 minutes',26.9124,75.7873,150) returning id`, [pkg.id]);
  const [account] = await q(`insert into ref.account (username,password_hash,password_salt,display_name)
    values ($1,$2,$3,'WebAuthn Operator') returning id`, [`webauthn-${tag}`,randomBytes(64),randomBytes(16)]);
  const token = randomBytes(24).toString("hex");
  await q(`insert into ref.session (token_hash,account_id,expires_at)
    values ($1,$2,now()+interval '1 hour')`, [createHash("sha256").update(token).digest(),account.id]);

  const reg = await post("/webauthn/register/challenge", { personId: person.id }, token);
  expect("operator receives registration challenge", reg.status === 201 && Boolean(reg.body.options?.challenge));
  challengeId = reg.body.challengeId;
  const complete = await post("/webauthn/register/complete", {
    personId: person.id, challengeId, response: attestation(reg.body.options.challenge),
  }, token);
  expect("platform credential is registered for the person", complete.status === 201, JSON.stringify(complete.body));
  const reused = await post("/webauthn/register/complete", {
    personId: person.id, challengeId, response: attestation(reg.body.options.challenge),
  }, token);
  expect("registration challenge cannot be reused", reused.status === 409);
  const issued = await post(`/legs/${leg.id}/dispatch/webauthn/challenge`, { personId: person.id, deviceId: device.id });
  expect("ledger issues a challenge for this person, phone, leg and step", issued.status === 201 && Boolean(issued.body.options?.challenge));
  const common = { deviceId: device.id, personId: person.id, seamIdRead: label.seamId,
    seamSecretHex: Buffer.from(label.seamSecret).toString("hex"), biometricSlot: 3, biometricScore: 180,
    geo: { lat: 26.9124, lon: 75.7873, accuracyM: 7 } };
  const wrongDevice = await post(`/legs/${leg.id}/dispatch`, { ...common, deviceId: randomUUID(), webauthn: {
    challengeId: issued.body.challengeId, response: assertion(issued.body.options.challenge),
  } });
  const [stillUnused] = await q(`select consumed_at from ref.webauthn_challenge where id=$1`, [issued.body.challengeId]);
  expect("another device cannot spend this challenge", wrongDevice.body.outcome === "refused" &&
    wrongDevice.body.checks?.find((c) => c.check === "webauthn_user_verified")?.passed === false &&
    stillUnused.consumed_at === null);
  const dispatch = await post(`/legs/${leg.id}/dispatch`, { ...common, webauthn: {
    challengeId: issued.body.challengeId, response: assertion(issued.body.options.challenge),
  } });
  expect("dispatch is granted with separate simulated and WebAuthn checks", dispatch.body.outcome === "granted" &&
    dispatch.body.checks?.find((c) => c.check === "biometric_presented")?.passed === true &&
    dispatch.body.checks?.find((c) => c.check === "webauthn_user_verified")?.passed === true,
  JSON.stringify(dispatch.body.denyReasons ?? dispatch.body));
  expect("granted dispatch was signed onto the chain", dispatch.body.chainEvent?.recorded === true && dispatch.body.chainEvent.kind === "HANDOVER_INITIATED");
  const [saved] = await q(`select webauthn_cred from ref.person where id=$1`, [person.id]);
  expect("authenticator sign counter was advanced", saved.webauthn_cred[0]?.counter === 1);
  const replay = await post(`/legs/${leg.id}/dispatch`, { ...common, webauthn: {
    challengeId: issued.body.challengeId, response: assertion(issued.body.options.challenge),
  } });
  expect("replayed assertion is refused and recorded separately", replay.body.outcome === "refused" &&
    replay.body.checks?.find((c) => c.check === "webauthn_user_verified")?.passed === false &&
    replay.body.chainEvent?.kind === "HANDOVER_REFUSED" && replay.body.chainEvent?.recorded === true);
  const noProof = await post(`/legs/${leg.id}/dispatch`, common);
  expect("enrolled person cannot fall back to simulation", noProof.body.outcome === "refused" &&
    noProof.body.denyReasons?.includes("webauthn_user_not_verified"));
  const failure = replay.body.checks?.find((c) => c.check === "webauthn_user_verified")?.evidence ?? "";
  expect("a refused proof says what was found, not a list of what it might have been",
    /missing, expired, used/.test(failure), failure);

  // A person whose phone is lost, or whose enrolment stopped half way, still
  // has a credential on record. Without a way to replace it they could never
  // hand a packet over again.
  const second = await post("/webauthn/register/challenge", { personId: person.id }, token);
  expect("a second credential for the same person is not registered silently", second.status === 409 && /replace/.test(second.body.error));
  const replaceChallenge = await post("/webauthn/register/challenge", { personId: person.id, replace: true }, token);
  expect("an operator can ask to replace it", replaceChallenge.status === 201);
  const unsaid = await post("/webauthn/register/complete", {
    personId: person.id, challengeId: replaceChallenge.body.challengeId, response: attestation(replaceChallenge.body.options.challenge),
  }, token);
  expect("completing without saying it is a replacement is refused", unsaid.status === 409);
  const again = await post("/webauthn/register/challenge", { personId: person.id, replace: true }, token);
  const replaced = await post("/webauthn/register/complete", {
    personId: person.id, challengeId: again.body.challengeId, response: attestation(again.body.options.challenge), replace: true,
  }, token);
  const [told] = await q(
    `select evidence, consequence, requires_decision from led.alert
      where kind = 'WEBAUTHN_CREDENTIAL_REPLACED' and evidence ->> 'personId' = $1`, [person.id]);
  expect("a replacement is accepted and the control room is told who did it",
    replaced.status === 201 && replaced.body.replaced === true &&
    told?.evidence.replacedByAccountId === account.id && told.evidence.previousCredentialIds.length === 1 &&
    /WebAuthn Operator/.test(told.consequence) && !/critical|high|medium|severity/i.test(told.consequence),
    JSON.stringify(replaced.body));
  const [after] = await q(`select webauthn_cred from ref.person where id=$1`, [person.id]);
  expect("the person still has exactly one credential", after.webauthn_cred.length === 1);
} catch (err) {
  expect("the run completed", false, err.stack ?? String(err));
} finally {
  await client.query("rollback").catch(() => {});
  const [left] = await q(`select
    (select count(*) from ref.authority where name=$1) +
    (select count(*) from ref.person where id=$2::uuid) +
    (select count(*) from ref.package where id=$3::uuid) +
    (select count(*) from ref.webauthn_challenge where id=$4::uuid) +
    (select count(*) from led.event where package_id=$3::uuid) as n`,
    [`webauthn e2e ${tag}`,personId,packetId,challengeId]).catch(() => [{ n: -1 }]);
  expect("nothing was left in the database", Number(left.n) === 0, `${left.n} row(s)`);
  await app.close();
  await client.end();
}
let failed = 0;
for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${!r.ok && r.detail ? `  (${r.detail})` : ""}`); }
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
