#!/usr/bin/env node
/**
 * Device enrolment with an attestation, against a real Postgres, leaving
 * nothing behind.
 *
 *   E2E_OWNER_URL=postgres://<schema owner>@host/<db>  node tools/e2e/attestation.mjs
 *
 * The enrolment route is the ledger's own. The certificate chains are made by
 * services/ledger's attestation fixture, in the shape Android's Keystore
 * produces, under a root this script hands the route as trusted. No chain off
 * a real handset is used: there is no app here that can ask a Keystore for one.
 *
 * Safe to point at a database you care about: everything runs inside one
 * transaction that is rolled back at the end.
 *
 * Needs every migration applied, through 014. Build first (`pnpm build`).
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(root, "services", "ledger", "package.json"));
const pg = require("pg");
const Fastify = require("fastify");
const at = (p) => new URL(`../../${p}`, import.meta.url).href;
const { registerRegistryRoutes } = await import(at("services/ledger/dist/http/registry-routes.js"));
const { vendor, certificate, keyDescription, ed25519Hex, tpmMaker, tpmQuote, tpmBundle } = await import(
  at("services/ledger/dist/domain/attestation-fixture.js")
);
const { tpmBinding } = await import(at("services/ledger/dist/domain/attestation.js"));
const { generateKeypair } = await import(at("packages/crypto-core/dist/index.js"));

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

const q = (t, p) => client.query(t, p).then((r) => r.rows);
const results = [];
const expect = (name, ok, detail = "") => results.push({ name, ok, detail });

const hardware = vendor("E2E hardware");
const stranger = vendor("Unknown maker");
const tpm = tpmMaker("E2E TPM");
const revoked = new Set();

/** One ledger per policy, as two deployments would be configured. */
const ledger = async (requiredKinds) => {
  const app = Fastify({ logger: false });
  registerRegistryRoutes(app, pool, {
    attestation: {
      roots: [hardware.x509],
      tpmRoots: [tpm.x509],
      requiredKinds: new Set(requiredKinds),
      revocation: (serial) => (revoked.has(parseInt(serial, 16)) ? "REVOKED" : undefined),
    },
  });
  await app.ready();
  const post = async (url, payload) => {
    const res = await app.inject({ method: "POST", url, payload });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const get = async (url) => {
    const res = await app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return { app, post, get };
};
const lenient = await ledger([]);
const strict = await ledger(["field"]);

const b64 = (...certs) => Buffer.concat(certs).toString("base64");
const failedChecks = (r) => (r.body.attestation?.checks ?? []).filter((c) => c.passed === false).map((c) => c.check);
const rowsFor = (pubkeyHex) =>
  q(`select device_id, outcome, enrolled, checks, facts, attestation_sha256
       from led.device_attestation where pubkey = decode($1,'hex') order by recorded_at, id`, [pubkeyHex]);
const deviceFor = (pubkeyHex) => q(`select id, attestation from ref.device where pubkey = decode($1,'hex')`, [pubkeyHex]);

await client.query("begin");
try {
  // ── nothing presented ──
  const plain = generateKeypair();
  const absent = await lenient.post("/devices", { kind: "field", pubkeyHex: plain.publicKeyHex });
  const [absentRow] = await rowsFor(plain.publicKeyHex);
  expect("a device presenting no attestation is enrolled, and is on record as having presented none",
    absent.status === 201 && absent.body.attestation.outcome === "absent" &&
    absentRow?.outcome === "absent" && absentRow.enrolled === true && absentRow.device_id === absent.body.id,
    JSON.stringify(absent.body));

  const needed = generateKeypair();
  const refusedAbsent = await strict.post("/devices", { kind: "field", pubkeyHex: needed.publicKeyHex });
  const [neededRow] = await rowsFor(needed.publicKeyHex);
  expect("where field devices must attest, one that presents nothing is refused and no device is made",
    refusedAbsent.status === 422 && refusedAbsent.body.denyReasons.includes("device_attestation_invalid") &&
    (await deviceFor(needed.publicKeyHex)).length === 0 &&
    neededRow?.outcome === "absent" && neededRow.enrolled === false && neededRow.device_id === null,
    JSON.stringify(refusedAbsent.body));
  const station = generateKeypair();
  expect("that rule is per kind: a centre PC is still enrolled without one",
    (await strict.post("/devices", { kind: "centre_pc", pubkeyHex: station.publicKeyHex })).status === 201);

  // ── a real answer to a real challenge ──
  // The phone makes its key, asks the ledger for a challenge for it, and its
  // hardware issues the leaf over both.
  const phone = async (api, { description = {}, issuer = hardware, challenge = "ask", serial = 424242 } = {}) => {
    const key = generateKeyPairSync("ed25519");
    const pubkeyHex = ed25519Hex(key.publicKey);
    const answered =
      challenge === "ask"
        ? Buffer.from((await api.post("/devices/challenge", { pubkeyHex })).body.challengeB64, "base64")
        : randomBytes(32);
    const leaf = certificate({
      subject: "Android Keystore Key",
      issuer: issuer === hardware ? "E2E hardware intermediate" : "Unknown maker intermediate",
      subjectKey: key.publicKey,
      signerKey: issuer.mid.privateKey,
      serial,
      keyDescription: keyDescription({ challenge: answered, ...description }),
    });
    return { pubkeyHex, attestationB64: b64(leaf, issuer.midCert, issuer.rootCert) };
  };

  const good = await phone(strict);
  const enrolled = await strict.post("/devices", { kind: "field", ...good });
  const [goodRow] = await rowsFor(good.pubkeyHex);
  const [goodDevice] = await deviceFor(good.pubkeyHex);
  expect("a chain from secure hardware over the enrolled key and this ledger's challenge enrols the device",
    enrolled.status === 201 && enrolled.body.attestation.outcome === "verified" &&
    enrolled.body.attestation.checks.length === 10, JSON.stringify(enrolled.body.attestation?.checks?.filter((c) => c.passed === false)));
  expect("the ruling is on record with every check, the security level and the boot state",
    goodRow?.outcome === "verified" && goodRow.enrolled === true && goodRow.device_id === enrolled.body.id &&
    goodRow.checks.length === 10 && goodRow.facts.attestationSecurityLevel === "TrustedEnvironment" &&
    goodRow.facts.verifiedBootState === "Verified" && goodRow.facts.deviceLocked === true,
    JSON.stringify(goodRow?.facts));
  expect("the bytes presented are kept with the device, and the record carries their hash",
    goodDevice?.attestation?.toString("base64") === good.attestationB64 &&
    goodRow.attestation_sha256 === createHash("sha256").update(Buffer.from(good.attestationB64, "base64")).digest("hex"));

  // ── the ways it is refused ──
  const refuse = async (name, made, expectFailed) => {
    const res = await strict.post("/devices", { kind: "field", ...made });
    const rows = await rowsFor(made.pubkeyHex);
    const row = rows[rows.length - 1];
    expect(name,
      res.status === 422 && res.body.outcome === "refused" &&
      JSON.stringify(failedChecks(res)) === JSON.stringify(expectFailed) &&
      (await deviceFor(made.pubkeyHex)).length === 0 &&
      row?.outcome === "refused" && row.enrolled === false && row.device_id === null,
      `${res.status} failed: ${JSON.stringify(failedChecks(res))}`);
    return res;
  };

  await refuse("an attestation made without asking this ledger for a challenge is refused",
    await phone(strict, { challenge: "none" }), ["challenge_fresh"]);

  const replay = await phone(strict);
  await strict.post("/devices/challenge", { pubkeyHex: replay.pubkeyHex }); // a newer challenge replaces the one answered
  await refuse("an attestation answering a challenge that has since been replaced is refused", replay, ["challenge_fresh"]);

  await refuse("a key the phone holds in software is refused",
    await phone(strict, { description: { attestationLevel: 0, keyMintLevel: 0 } }), ["hardware_backed"]);
  await refuse("a phone with an unlocked bootloader is refused",
    await phone(strict, { description: { deviceLocked: false, bootState: 2 } }), ["boot_verified"]);
  await refuse("a chain from a maker this ledger does not trust is refused",
    await phone(strict, { issuer: stranger }), ["root_trusted"]);

  const borrowed = await phone(strict);
  const other = generateKeypair();
  await refuse("a genuine attestation for one key does not enrol another",
    { pubkeyHex: other.publicKeyHex, attestationB64: borrowed.attestationB64 }, ["challenge_fresh", "key_is_enrolled_key"]);

  await refuse("bytes that are not a certificate chain are refused",
    { pubkeyHex: generateKeypair().publicKeyHex, attestationB64: randomBytes(300).toString("base64") }, ["chain_readable"]);

  revoked.add(555001);
  await refuse("a leaf whose serial is on the revocation list is refused",
    await phone(strict, { serial: 555001 }), ["not_revoked"]);

  const everything = await refuse("several faults at once are all named, not the first",
    await phone(strict, { issuer: stranger, challenge: "none", description: { attestationLevel: 0, keyMintLevel: 0, bootState: 3 } }),
    ["root_trusted", "hardware_backed", "challenge_fresh", "boot_verified"]);
  expect("and the checks that passed alongside them are still reported as passed",
    everything.body.attestation.checks.filter((c) => c.passed === true).length >= 4);

  // ── a presented attestation is judged even where none is required ──
  const lax = await phone(lenient, { description: { deviceLocked: false, bootState: 2 } });
  const laxRes = await lenient.post("/devices", { kind: "field", ...lax });
  expect("where attestation is optional, a bad one still enrols nothing: optional is not ignored",
    laxRes.status === 422 && (await deviceFor(lax.pubkeyHex)).length === 0);

  // ── a challenge is answered once ──
  const once = await phone(strict);
  const first = await strict.post("/devices", { kind: "field", ...once });
  const again = await strict.post("/devices", { kind: "field", ...once });
  expect("the same attestation sent again is refused: its challenge was answered once, and there is still one device",
    first.status === 201 && again.status === 422 &&
    JSON.stringify(failedChecks(again)) === JSON.stringify(["challenge_fresh"]) &&
    (await deviceFor(once.pubkeyHex)).length === 1, `${first.status} then ${again.status}`);
  const dup = await strict.post("/devices", { kind: "centre_pc", pubkeyHex: once.pubkeyHex });
  expect("and the same key presented again with nothing is a duplicate key, not a second device", dup.status === 409);

  // ── a centre PC: a TPM vouching for a key it does not hold ──
  const pc = async ({ challenge = "ask", signerKey, forKey } = {}) => {
    const key = generateKeyPairSync("ed25519");
    const pubkeyHex = ed25519Hex(key.publicKey);
    const answered =
      challenge === "ask"
        ? Buffer.from((await strict.post("/devices/challenge", { pubkeyHex })).body.challengeB64, "base64")
        : randomBytes(32);
    const quoted = tpmQuote({ extraData: tpmBinding(answered, forKey ?? pubkeyHex) });
    return {
      pubkeyHex,
      attestationB64: Buffer.from(tpmBundle(tpm, quoted, signerKey ? { signerKey } : {})).toString("base64"),
    };
  };
  const goodPc = await pc();
  const pcEnrolled = await strict.post("/devices", { kind: "centre_pc", ...goodPc });
  const [pcRow] = await rowsFor(goodPc.pubkeyHex);
  expect("a centre PC presenting a TPM quote over its key and the challenge is enrolled",
    pcEnrolled.status === 201 && pcEnrolled.body.attestation.outcome === "verified" &&
    pcEnrolled.body.attestation.checks.length === 10,
    JSON.stringify(pcEnrolled.body.attestation?.checks?.filter((c) => c.passed === false) ?? pcEnrolled.body));
  expect("and the record says the key is in software, with the boot measurement not evaluated",
    pcRow?.facts.kind === "tpm-quote" && /software.*does not hold it/.test(pcRow.facts.keyHeldIn) &&
    pcRow.checks.find((c) => c.check === "boot_measured").passed === undefined, JSON.stringify(pcRow?.facts));
  await refuse("a TPM quote made without this ledger's challenge is refused",
    await pc({ challenge: "none" }), ["binding_fresh"]);
  await refuse("a TPM quote naming some other key is refused",
    await pc({ forKey: "ab".repeat(32) }), ["binding_fresh"]);
  await refuse("a quote not signed by the certified attestation key is refused",
    await pc({ signerKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey }), ["quote_signed"]);

  // ── reading it back ──
  const listed = await strict.get("/devices/attestations");
  const mine = listed.body.attestations.find((a) => a.deviceId === enrolled.body.id);
  const none = listed.body.attestations.find((a) => a.deviceId === absent.body.id);
  expect("the Devices page can read each device's ruling: verified for one, absent for the other",
    listed.status === 200 && mine?.outcome === "verified" && mine.facts.keyMintSecurityLevel === "TrustedEnvironment" &&
    none?.outcome === "absent");
  expect("the device list itself is unchanged and does not depend on the new table",
    (await strict.get(`/devices/${enrolled.body.id}`)).body.pubkey === good.pubkeyHex);

  const grants = await q(
    `select privilege_type from information_schema.table_privileges
      where table_schema = 'led' and table_name = 'device_attestation' and grantee = 'mohar_app'
        and privilege_type in ('UPDATE','DELETE','TRUNCATE')`);
  expect("mohar_app holds no UPDATE or DELETE on led.device_attestation", grants.length === 0, JSON.stringify(grants));
} catch (err) {
  expect("the run completed", false, err.stack ?? String(err));
} finally {
  await client.query("rollback").catch(() => {});
  const left = await client
    .query(`select count(*)::int as n from led.device_attestation where facts ->> 'rootSubject' like '%E2E hardware root%'`)
    .then((r) => r.rows[0].n).catch(() => -1);
  expect("nothing was left in the database", left === 0, `${left} row(s)`);
  await lenient.app.close();
  await strict.app.close();
  await client.end();
}

let failedCount = 0;
for (const r of results) {
  if (!r.ok) failedCount += 1;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${!r.ok && r.detail ? `\n        ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
