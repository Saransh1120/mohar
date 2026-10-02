#!/usr/bin/env node
/**
 * One packet, from the press to the exam hall, and what the chain says about it
 * afterwards.
 *
 *   E2E_OWNER_URL=postgres://<schema owner>@host/<db>  node tools/e2e/journey.mjs
 *
 * The other scripts each put one engine through its refusals. This one walks a
 * single packet through all of them in order: sealed with a label, the roster
 * locked, handed press to courier to custodian, held in a strong room, handed
 * to the superintendent, and opened by two officials once drand publishes the
 * round. Then it reads led.event back and checks that the journey is there as
 * signed events: in order, each signed by the device that may sign it, the
 * chain intact across the whole run, and none of the secrets in any of it.
 *
 * Nothing is asserted that an engine did not rule. Each step is put to the
 * ledger's own routes on a Fastify instance that is never bound to a port.
 *
 * Safe to point at a database you care about: everything runs inside one
 * transaction that is rolled back at the end. Needs the internet for the
 * opening, because the beacon is the real one and the test waits for it.
 *
 * Needs every migration applied, through 012. Build first (`pnpm build`).
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(root, "services", "ledger", "package.json"));
const pg = require("pg");
const Fastify = require("fastify");
const at = (p) => new URL(`../../${p}`, import.meta.url).href;
const { registerRoutes } = await import(at("services/ledger/dist/http/routes.js"));
const { registerRegistryRoutes } = await import(at("services/ledger/dist/http/registry-routes.js"));
const { registerSealRoutes } = await import(at("services/ledger/dist/http/seal-routes.js"));
const { registerTransferRoutes } = await import(at("services/ledger/dist/http/transfer-routes.js"));
const { registerStrongroomRoutes } = await import(at("services/ledger/dist/http/strongroom-routes.js"));
const { registerOpeningRoutes } = await import(at("services/ledger/dist/http/opening-routes.js"));
const { sweepOverdueLegs } = await import(at("services/ledger/dist/domain/watchdog.js"));
const { servicePublicKeyHex } = await import(at("services/ledger/dist/domain/service-events.js"));
const {
  QUICKNET, bodyHashOf, combineOpeningKey, generateKeypair, generateSeamLabel, generateWrapKeypair,
  shareContext, signBody, timeOfRound, unwrapControlPart, unwrapShare, verifyBodySignature, verifyChain,
} = await import(at("packages/crypto-core/dist/index.js"));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = Fastify({ logger: false });
registerRoutes(app, pool);
registerRegistryRoutes(app, pool);
registerSealRoutes(app, pool);
registerTransferRoutes(app, pool);
registerStrongroomRoutes(app, pool);
registerOpeningRoutes(app, pool);
await app.ready();
const call = async (method, url, payload, token) => {
  const res = await app.inject({
    method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const post = (url, payload, token) => call("POST", url, payload, token);
const api = { get: (path) => call("GET", path), post: (path, body) => call("POST", path, body) };

const tag = randomBytes(3).toString("hex");
await client.query("begin");
try {
  // The packets open about 40 s from now: long enough to walk the journey up
  // to the release, short enough to wait out.
  const OPEN_IN_S = 40;
  const LAT = 26.9124, LON = 75.7873;
  const [auth] = await q(`insert into ref.authority (name) values ($1) returning id`, [`journey e2e ${tag}`]);
  const [exam] = await q(
    `insert into ref.exam (authority_id, name, mode, starts_at, drand_round, sides_per_copy)
     values ($1,$2,'escorted', now() + make_interval(mins => 15, secs => $3), 1, 4) returning id, starts_at`,
    [auth.id, `Physics ${tag}`, OPEN_IN_S]);
  const [centre] = await q(
    `insert into ref.centre (exam_id, code, lat, lon, capacity) values ($1,$2,$3,$4,300) returning id`,
    [exam.id, `JR-${tag}`, LAT, LON]);
  const serial = `PKT-JR-${tag}`;
  const [pkg] = await q(
    `insert into ref.package (exam_id, centre_id, seal_serial, copies) values ($1,$2,$3,300) returning id`,
    [exam.id, centre.id, serial]);

  const device = async (kind, centreId = null) =>
    (await q(`insert into ref.device (kind, pubkey, centre_id) values ($1,$2,$3) returning id`,
      [kind, randomBytes(32), centreId]))[0].id;
  const person = async (name, role) =>
    (await q(`insert into ref.person (display_name, role, govt_id_hash) values ($1,$2,$3) returning id`,
      [name, role, randomBytes(32)]))[0].id;
  const enrol = (deviceId, slot, personId, role) =>
    q(`insert into ref.fingerprint_enrolment (device_id, template_slot, person_id, role) values ($1,$2,$3,$4)`,
      [deviceId, slot, personId, role]);

  const press = await person("A. Sharma", "press_operator");
  const courier = await person("B. Meena", "courier");
  const custodian = await person("C. Rathore", "custodian");
  const officer = await person("D. Singh", "district_officer");
  const superintendent = await person("S. Verma", "superintendent");
  const observer = await person("O. Khan", "observer");
  const police = await person("P. Yadav", "police_escort");

  const phone = await device("field");
  const door = await device("centre_pc");
  const station = await device("centre_pc", centre.id);
  await enrol(door, 1, custodian, "custodian");
  await enrol(door, 11, officer, "district_officer");
  await enrol(station, 1, superintendent, "superintendent");
  await enrol(station, 11, observer, "observer");
  await enrol(station, 21, police, "police_escort");

  const [acc] = await q(
    `insert into ref.account (username, password_hash, password_salt, display_name) values ($1,$2,$3,'Operator') returning id`,
    [`jr-${tag}`, randomBytes(64), randomBytes(16)]);
  const token = randomBytes(24).toString("hex");
  await q(`insert into ref.session (token_hash, account_id, expires_at) values ($1,$2, now() + interval '1 hour')`,
    [createHash("sha256").update(token).digest(), acc.id]);

  const recorded = (r) => r?.recorded === true;
  const secrets = [];

  // ════ 1. sealed at the press ════
  const label = generateSeamLabel();
  const secretHex = Buffer.from(label.seamSecret).toString("hex");
  secrets.push(secretHex);
  const pressDevice = await enrolDevice(api);
  const packet = await loadPacket(api, pkg.id);
  const sealed = await submitSeal(api, buildSealEvent(
    packet,
    { packageId: pkg.id, packetSerial: serial, seamId: label.seamId, labelCommitment: label.commitment,
      labelsPerPacket: 1, printedAt: new Date().toISOString() },
    pressDevice,
    { photoSha256: "ab".repeat(32), personId: press, geo: { lat: LAT, lon: LON, accuracyM: 8 } }));
  expect("the packet is sealed with its label", sealed.sealed && sealed.status === 201, JSON.stringify(sealed.body));

  // ════ 2. the roster is locked and the opening key issued ════
  const rosterUrl = `/rosters/${centre.id}/${exam.id}`;
  await call("PUT", rosterUrl, { assignments: [
    { role: "superintendent", personId: superintendent },
    { role: "observer", personId: observer },
    { role: "police_escort", personId: police },
  ] });
  const wrapKeys = generateWrapKeypair();
  await post(`/stations/${station}/wrap-key`, { x25519PubHex: wrapKeys.publicKeyHex });
  const lock = await post(`${rosterUrl}/lock`,
    { stationDeviceId: station, lateReason: "journey check: the exam is fifteen minutes away" }, token);
  expect("the roster locks and a key is issued for the packet",
    lock.body.outcome === "locked" && lock.body.packets.length === 1, JSON.stringify(lock.body.denyReasons ?? lock.body));
  expect("the lock reports its chain events: one envelope, one re-wrap",
    lock.body.chainEvents?.length === 2 && lock.body.chainEvents.every(recorded) &&
    lock.body.chainEvents[0].kind === "CONTROL_ENVELOPE_ISSUED" && lock.body.chainEvents[1].kind === "SHARES_REWRAPPED",
    JSON.stringify(lock.body.chainEvents));
  const round = lock.body.packets[0]?.drandRound;
  const opensAt = timeOfRound(round);

  // ════ 3. the hand-offs ════
  const now = Date.now();
  const planLeg = async (legNo, fromRole, toRole, fromPlace, toPlace) =>
    (await post("/legs", {
      packageId: pkg.id, legNo, fromRole, toRole, fromPlace, toPlace,
      windowStart: new Date(now - 3600e3).toISOString(), windowEnd: new Date(now + 3600e3).toISOString(),
      expectedBy: new Date(now + 1800e3).toISOString(),
    })).body.legId;
  const scan = { deviceId: phone, seamSecretHex: secretHex, seamIdRead: label.seamId };
  const handOff = async (legId, from, to, { wrongSerialFirst = false } = {}) => {
    const out = {};
    out.dispatch = await post(`/legs/${legId}/dispatch`, { ...scan, personId: from, biometricSlot: 3, biometricScore: 190 });
    if (wrongSerialFirst) {
      out.refused = await post(`/legs/${legId}/receive`,
        { ...scan, personId: to, biometricSlot: 4, biometricScore: 188, packetSerialTyped: "PKT-NOT-THIS" });
    }
    out.receive = await post(`/legs/${legId}/receive`,
      { ...scan, personId: to, biometricSlot: 4, biometricScore: 188, packetSerialTyped: serial });
    if (out.receive.body.transferKey) secrets.push(out.receive.body.transferKey);
    out.confirm = await post(`/legs/${legId}/confirm`,
      { ...scan, personId: to, biometricSlot: 4, biometricScore: 188, transferKey: out.receive.body.transferKey });
    return out;
  };
  const granted = (h) => ["dispatch", "receive", "confirm"].every((s) => h[s].body.outcome === "granted");
  const why = (h) => JSON.stringify(["dispatch", "receive", "confirm"].map((s) => h[s].body.denyReasons));

  const leg1 = await planLeg(1, "press_operator", "courier", "Government Press, Jaipur", "Route vehicle");
  const leg2 = await planLeg(2, "courier", "custodian", "Route vehicle", "District treasury");
  const leg3 = await planLeg(3, "custodian", "superintendent", "District treasury", `Centre JR-${tag}`);

  const h1 = await handOff(leg1, press, courier, { wrongSerialFirst: true });
  expect("leg 1: a wrong serial is refused, then press to courier is granted",
    h1.refused.body.outcome === "refused" && h1.refused.body.denyReasons.includes("packet_serial_mismatch") && granted(h1), why(h1));
  expect("each ruling on leg 1 says which event it put on the chain",
    h1.dispatch.body.chainEvent?.kind === "HANDOVER_INITIATED" && recorded(h1.dispatch.body.chainEvent) &&
    h1.refused.body.chainEvent?.kind === "HANDOVER_REFUSED" && recorded(h1.refused.body.chainEvent) &&
    h1.confirm.body.chainEvent?.kind === "HANDOVER_COMPLETED" && recorded(h1.confirm.body.chainEvent),
    JSON.stringify([h1.dispatch.body.chainEvent, h1.refused.body.chainEvent, h1.confirm.body.chainEvent]));
  expect("a granted receive issues the key and has no event of its own",
    Boolean(h1.receive.body.transferKey) && h1.receive.body.chainEvent === undefined);

  const h2 = await handOff(leg2, courier, custodian);
  expect("leg 2: courier to custodian is granted", granted(h2), why(h2));

  // ════ 4. the strong room: in to store it, in again to take it out ════
  const room = (await post("/rooms", { name: `Strong room ${tag}`, place: "District treasury", centreId: centre.id })).body.roomId;
  const finger = (personId, slot) => ({ personId, biometricSlot: slot, biometricScore: 180, assertedAt: new Date().toISOString() });
  const visit = async (task, touched) => {
    const entry = await post(`/rooms/${room}/entry`,
      { deviceId: door, entrants: [finger(custodian, 1), finger(officer, 11)], task, expectedMinutes: 4 });
    const exit = entry.body.visitId
      ? await post(`/rooms/${room}/exit`, { deviceId: door, visitId: entry.body.visitId, packagesTouched: touched })
      : { body: {} };
    return { entry, exit };
  };
  const stored = await visit("store one packet", 1);
  const taken = await visit("collect one packet", 1);
  expect("two people are let into the strong room, twice, and each visit is closed",
    [stored, taken].every((v) => v.entry.body.outcome === "granted" && v.exit.body.outcome === "granted"),
    JSON.stringify([stored.entry.body.denyReasons, taken.entry.body.denyReasons]));
  expect("each entry and exit reports its chain event",
    [stored, taken].every((v) => recorded(v.entry.body.chainEvent) && v.exit.body.chainEvents?.length === 1 &&
      recorded(v.exit.body.chainEvents[0])),
    JSON.stringify([stored.entry.body.chainEvent, stored.exit.body.chainEvents]));

  const h3 = await handOff(leg3, custodian, superintendent);
  const [atCentre] = await q(`select state from ref.package where id = $1`, [pkg.id]);
  expect("leg 3: custodian to superintendent is granted and the packet is at the centre",
    granted(h3) && atCentre.state === "at_centre", `${why(h3)} ${atCentre.state}`);

  // ════ 5. what a phone may not say ════
  const rogue = generateKeypair();
  const [rogueDevice] = await q(`insert into ref.device (kind, pubkey) values ('field',$1) returning id`,
    [Buffer.from(rogue.publicKeyHex, "hex")]);
  const claim = {
    v: 1, id: randomUUID(), examId: exam.id, packageId: pkg.id, centreId: centre.id,
    occurredAt: new Date().toISOString(), actorDeviceId: rogueDevice.id, deviceSeq: 1,
    kind: "HANDOVER_COMPLETED",
    payload: {
      legId: leg3, legNo: 3, fromPersonId: custodian, toPersonId: courier, fromRole: "custodian", toRole: "courier",
      seamId: label.seamId, packetSerial: serial, biometricSlot: 4, biometricScore: 200, toState: "in_transit", lateBySeconds: 0,
    },
  };
  const forged = await post("/events", { body: claim, deviceSig: signBody(claim, rogue.privateKeyHex) });
  expect("a phone signing its own HANDOVER_COMPLETED is turned away: only the service may conclude",
    forged.status === 422 && JSON.stringify(forged.body).includes("service_only_kind"), `${forged.status} ${JSON.stringify(forged.body)}`);

  // ════ 6. the opening ════
  const begun = await post("/ceremonies", { packageId: pkg.id, deviceId: station, seamIdRead: label.seamId, seamSecretHex: secretHex });
  const cid = begun.body.ceremonyId;
  const official = (personId, slot) => post(`/ceremonies/${cid}/official`, { personId, biometricSlot: slot, biometricScore: 181 });
  const one = await official(superintendent, 1);
  const two = await official(observer, 11);
  const confirm = await post(`/ceremonies/${cid}/confirm`, { packetSerialTyped: serial });
  expect("at the station: the scan passes, two officials are identified, the serial is confirmed",
    begun.body.outcome === "passed" && one.body.outcome === "passed" && two.body.outcome === "passed" &&
    confirm.body.outcome === "passed",
    JSON.stringify([begun.body.scan?.denyReasons, begun.body.authorize?.denyReasons, one.body.denyReasons, two.body.denyReasons, confirm.body.denyReasons]));

  let opened = false;
  let keyHex = "";
  if (confirm.body.outcome === "passed") {
    const shares = [one, two].map((r) => ({
      index: r.body.share.index, holder: r.body.share.holder, institution: r.body.share.institution,
      commitment: r.body.share.commitment,
      share: unwrapShare(r.body.share.wrapped, wrapKeys.privateKeyHex,
        shareContext(pkg.id, r.body.share.holder, r.body.official.personId)),
    }));
    for (const s of shares) secrets.push(Buffer.from(s.share).toString("hex"));

    let beacon = null;
    let fetchError = "";
    await sleep(Math.max(0, opensAt.getTime() - Date.now()) + 1500);
    for (let i = 0; i < 12 && !beacon; i += 1) {
      try {
        const res = await fetch(`https://api.drand.sh/${QUICKNET.chainHash}/public/${round}`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) beacon = await res.json();
        else fetchError = `drand answered ${res.status}`;
      } catch (err) { fetchError = String(err); }
      if (!beacon) await sleep(2000);
    }
    expect("drand published the round the envelope is locked to", Boolean(beacon), fetchError);

    if (beacon) {
      const controlPart = await unwrapControlPart(confirm.body.envelope, { round: beacon.round, signature: beacon.signature });
      secrets.push(Buffer.from(controlPart).toString("hex"));
      keyHex = Buffer.from(await combineOpeningKey(controlPart, shares, confirm.body.commitments)).toString("hex");
      secrets.push(keyHex);

      const release = await post(`/ceremonies/${cid}/release`, { openingKeyHex: keyHex });
      expect("the key the station assembled is accepted, and OPEN_CEREMONY goes on the chain",
        release.body.outcome === "granted" && recorded(release.body.chainEvent) && release.body.chainEvent.kind === "OPEN_CEREMONY",
        JSON.stringify(release.body.denyReasons ?? release.body.chainEvent));
      const done = await post(`/ceremonies/${cid}/opened`, { photoSha256: "ef".repeat(32), candidateWitnesses: 2 });
      expect("the opening is recorded, and PACKET_OPENED goes on the chain",
        done.body.outcome === "opened" && recorded(done.body.chainEvent) && done.body.chainEvent.kind === "PACKET_OPENED",
        JSON.stringify(done.body));
      opened = done.body.outcome === "opened";
    }
  }

  // ════ 7. what did not happen: a leg nobody completed ════
  const [centre2] = await q(
    `insert into ref.centre (exam_id, code, lat, lon, capacity) values ($1,$2,$3,$4,300) returning id`,
    [exam.id, `JR2-${tag}`, LAT, LON]);
  const [pkg2] = await q(
    `insert into ref.package (exam_id, centre_id, seal_serial, copies) values ($1,$2,$3,300) returning id`,
    [exam.id, centre2.id, `PKT-JR2-${tag}`]);
  const lateLeg = (await post("/legs", {
    packageId: pkg2.id, legNo: 1, fromRole: "press_operator", toRole: "courier",
    fromPlace: "Government Press, Jaipur", toPlace: "Route vehicle",
    windowStart: new Date(now - 7200e3).toISOString(), windowEnd: new Date(now - 600e3).toISOString(),
    expectedBy: new Date(now - 1800e3).toISOString(),
  })).body.legId;
  const overdue = await sweepOverdueLegs(pool);
  expect("the watchdog raises the leg nobody completed", overdue.some((r) => r.legId === lateLeg));

  // ════ 8. what the chain says ════
  const events = await q(
    `select e.seq::text as seq, e.kind, e.body, e.package_id, e.actor_device, d.kind as device_kind,
            encode(d.pubkey,'hex') as pubkey, encode(e.device_sig,'hex') as sig,
            encode(e.body_hash,'hex') as body_hash, encode(e.prev_hash,'hex') as prev_hash, encode(e.hash,'hex') as hash
       from led.event e join ref.device d on d.id = e.actor_device
      where e.exam_id = $1 order by e.seq`, [exam.id]);
  const kinds = events.map((e) => e.kind);
  const expected = [
    "SEAL_APPLIED",
    "CONTROL_ENVELOPE_ISSUED", "SHARES_REWRAPPED",
    "HANDOVER_INITIATED", "HANDOVER_REFUSED", "HANDOVER_COMPLETED",
    "HANDOVER_INITIATED", "HANDOVER_COMPLETED",
    "STRONGROOM_ENTRY", "STRONGROOM_EXIT", "STRONGROOM_ENTRY", "STRONGROOM_EXIT",
    "HANDOVER_INITIATED", "HANDOVER_COMPLETED",
    ...(opened ? ["OPEN_CEREMONY", "PACKET_OPENED"] : []),
    "LEG_OVERDUE",
  ];
  expect("the chain holds the journey, in the order it happened",
    JSON.stringify(kinds) === JSON.stringify(expected), kinds.join(" → "));

  const byKind = (k) => events.filter((e) => e.kind === k);
  const seal = byKind("SEAL_APPLIED")[0];
  const fromService = events.filter((e) => e.kind !== "SEAL_APPLIED");
  expect("the sealing is signed by the press device, not by the ledger",
    seal?.actor_device === pressDevice.deviceId && seal.device_kind === "field");
  expect("everything the engines ruled is signed by one service device, with the ledger's key",
    fromService.length === expected.length - 1 &&
    new Set(fromService.map((e) => e.actor_device)).size === 1 &&
    fromService.every((e) => e.device_kind === "service" && e.pubkey === servicePublicKeyHex()));
  expect("every signature verifies against the signer's enrolled key",
    events.every((e) => verifyBodySignature(e.body, e.sig, e.pubkey)));
  expect("every stored body hashes to the body hash in its row",
    events.every((e) => bodyHashOf(e.body) === e.body_hash));

  // The whole run of the chain, including anything another writer appended in
  // between: this run's events are links in the one chain, not a chain of
  // their own.
  const links = await q(
    `select seq::text as seq, encode(body_hash,'hex') as "bodyHash", encode(prev_hash,'hex') as "prevHash",
            encode(hash,'hex') as hash
       from led.event where seq >= $1::bigint order by seq`, [events[0]?.seq ?? "0"]);
  const breaks = links.length ? verifyChain(links, Uint8Array.from(Buffer.from(links[0].prevHash, "hex"))) : [{ reason: "empty" }];
  expect("the chain is intact from the sealing to the last event", breaks.length === 0, JSON.stringify(breaks.slice(0, 3)));

  // ── the payloads carry what the engines saw ──
  const completed = byKind("HANDOVER_COMPLETED").map((e) => e.body.payload);
  expect("the three completions name who gave, who took and where the packet then stood",
    completed.length === 3 &&
    completed[0].fromPersonId === press && completed[0].toPersonId === courier && completed[0].toState === "in_transit" &&
    completed[1].fromPersonId === courier && completed[1].toPersonId === custodian && completed[1].toState === "at_custodian" &&
    completed[2].fromPersonId === custodian && completed[2].toPersonId === superintendent && completed[2].toState === "at_centre" &&
    completed.every((p) => p.seamId === label.seamId && p.packetSerial === serial),
    JSON.stringify(completed.map((p) => [p.legNo, p.toState])));
  const refusal = byKind("HANDOVER_REFUSED")[0]?.body.payload;
  expect("the refusal carries its reason and a line for every check, run or not",
    refusal?.denyReasons.includes("packet_serial_mismatch") && refusal.attemptedByPersonId === courier &&
    refusal.evidence.some((l) => l.startsWith("packet_serial: failed")) &&
    refusal.evidence.some((l) => l.includes("not evaluated")), JSON.stringify(refusal?.evidence));
  const initiated = byKind("HANDOVER_INITIATED")[0]?.body.payload;
  expect("a dispatch names no transfer key time: none exists until the receiver passes",
    initiated && !("transferKeyIssuedAt" in initiated) && !("transferKeyExpiresAt" in initiated));
  const entries = byKind("STRONGROOM_ENTRY").map((e) => e.body.payload);
  expect("each strong room entry names both people and their fingers, and claims no face reading it did not get",
    entries.length === 2 && entries.every((p) => p.personIds.includes(custodian) && p.personIds.includes(officer) &&
      p.biometricSlots.length === 2 && !("faceMatched" in p)));
  const envelope = byKind("CONTROL_ENVELOPE_ISSUED")[0]?.body.payload;
  const [envRow] = await q(
    `select ciphertext_sha256 from led.share_envelope where package_id = $1 and kind = 'control_timelock'`, [pkg.id]);
  expect("the envelope event names the round, the quicknet chain and the hash of the stored ciphertext",
    envelope?.drandRound === round && envelope.drandChainHash === QUICKNET.chainHash &&
    envelope.ciphertextSha256 === envRow?.ciphertext_sha256 && envelope.stationDeviceId === station);
  const rewrapped = byKind("SHARES_REWRAPPED")[0]?.body.payload;
  expect("the re-wrap names the three officials and the station their shares are readable by",
    rewrapped?.rewrapped.length === 3 && rewrapped.rewrapped.every((r) => r.deviceId === station));
  if (opened) {
    const ceremony = byKind("OPEN_CEREMONY")[0]?.body.payload;
    expect("the opening names the two officials, their institutions, the mode and the round",
      ceremony?.mode === "live-authorized" && ceremony.controlPartUsed === true && ceremony.drandRound === round &&
      ceremony.officials.map((o) => o.personId).join() === [superintendent, observer].join() &&
      ceremony.officials[0].institution !== ceremony.officials[1].institution, JSON.stringify(ceremony));
    const openedPayload = byKind("PACKET_OPENED")[0]?.body.payload;
    expect("the opened event carries the photograph's hash and names nobody it did not see open it",
      openedPayload?.photoSha256 === "ef".repeat(32) && openedPayload.candidateWitnesses === 2 &&
      !("openedByPersonId" in openedPayload));
  }
  const late = byKind("LEG_OVERDUE")[0];
  expect("the overdue leg is on the chain against its own packet",
    late?.package_id === pkg2.id && late.body.payload.legId === lateLeg && late.body.payload.overdueBySeconds > 0);

  const everything = JSON.stringify(events.map((e) => e.body));
  expect("no seam secret, transfer key, share, control part or opening key is in any event",
    secrets.length >= 4 && secrets.every((s) => !everything.includes(s)));
} catch (err) {
  expect("the run completed", false, err.stack ?? String(err));
} finally {
  await client.query("rollback").catch(() => {});
  const left = await client
    .query(`select count(*)::int as n from ref.authority where name = $1`, [`journey e2e ${tag}`])
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
