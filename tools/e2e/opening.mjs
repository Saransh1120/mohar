#!/usr/bin/env node
/**
 * Roster lock and the opening ceremony, end to end, against a real Postgres
 * and the real drand beacon, leaving nothing behind.
 *
 *   E2E_OWNER_URL=postgres://<schema owner>@host/<db>  node tools/e2e/opening.mjs
 *
 * Safe to point at a database you care about: everything runs inside one
 * transaction that is rolled back at the end.
 *
 * This one needs the internet and takes about half a minute, and both for the
 * same reason. The exam is scheduled so the packet is due to open a few
 * seconds from now; the roster is locked, which time-locks the control room's
 * part to the drand round for that moment; and then the test waits for drand
 * to publish that round, fetches it, and opens the envelope with it. Nothing
 * stands in for the beacon. Before the round, the test tries to release and is
 * refused.
 *
 * The script plays the station: it holds the unwrap key, unwraps the two
 * officials' shares it is handed, and assembles the key. The server never does.
 *
 * Needs every migration applied, through 009. Build first (`pnpm build`).
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
const { registerOpeningRoutes } = await import(at("services/ledger/dist/http/opening-routes.js"));
const { sweepIncompleteCeremonies } = await import(at("services/ledger/dist/domain/opening.js"));
const { sweepUnopenedPackets } = await import(at("services/ledger/dist/domain/watchdog.js"));
const {
  QUICKNET, combineOpeningKey, generateSeamLabel, generateWrapKeypair, timeOfRound,
  unwrapControlPart, unwrapShare, shareContext,
} = await import(at("packages/crypto-core/dist/index.js"));

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
registerOpeningRoutes(app, pool);
await app.ready();
const call = async (method, url, payload, token) => {
  const res = await app.inject({
    method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const post = (url, payload, token) => call("POST", url, payload, token);
const failed = (r, check) => (r.checks ?? r.body?.checks)?.find((c) => c.check === check)?.passed === false;

await client.query("begin");
try {
  const tag = randomBytes(3).toString("hex");
  // Due to open about 20 s from now: long enough to walk the ceremony up to
  // the release, short enough to wait out.
  const OPEN_IN_S = 40;
  const [auth] = await q(`insert into ref.authority (name) values ($1) returning id`, [`opening e2e ${tag}`]);
  const [exam] = await q(
    `insert into ref.exam (authority_id, name, mode, starts_at, drand_round, sides_per_copy)
     values ($1,$2,'escorted', now() + make_interval(mins => 15, secs => $3), 1, 4) returning id, starts_at`,
    [auth.id, `Physics ${tag}`, OPEN_IN_S]);
  const [centre] = await q(
    `insert into ref.centre (exam_id, code, lat, lon, capacity) values ($1,$2,26.9,75.7,300) returning id`,
    [exam.id, `OP-${tag}`]);
  const serial = `PKT-OP-${tag}`;
  const [pkg] = await q(
    `insert into ref.package (exam_id, centre_id, seal_serial, copies, state) values ($1,$2,$3,300,'at_centre') returning id`,
    [exam.id, centre.id, serial]);
  const label = generateSeamLabel();
  const secretHex = Buffer.from(label.seamSecret).toString("hex");
  await q(`insert into ref.seal_label (package_id, seam_id, commitment_hex) values ($1,$2,$3)`,
    [pkg.id, label.seamId, label.commitment]);

  const device = async () =>
    (await q(`insert into ref.device (kind, pubkey, centre_id) values ('centre_pc',$1,$2) returning id`,
      [randomBytes(32), centre.id]))[0].id;
  const station = await device();
  const otherStation = await device();
  const person = async (name, role, slot) => {
    const [p] = await q(`insert into ref.person (display_name, role, govt_id_hash) values ($1,$2,$3) returning id`,
      [name, role, randomBytes(32)]);
    if (slot) {
      await q(`insert into ref.fingerprint_enrolment (device_id, template_slot, person_id, role) values ($1,$2,$3,$4)`,
        [station, slot, p.id, role]);
    }
    return p.id;
  };
  const superintendent = await person("S. Verma", "superintendent", 1);
  const observer = await person("O. Khan", "observer", 11);
  const police = await person("P. Yadav", "police_escort", 21);
  const stranger = await person("X. Other", "observer", 31);
  const police2 = await person("R. Gurjar", "police_escort", 22);

  const [acc] = await q(
    `insert into ref.account (username, password_hash, password_salt, display_name) values ($1,$2,$3,'Operator') returning id`,
    [`op-${tag}`, randomBytes(64), randomBytes(16)]);
  const token = randomBytes(24).toString("hex");
  await q(`insert into ref.session (token_hash, account_id, expires_at) values ($1,$2, now() + interval '1 hour')`,
    [createHash("sha256").update(token).digest(), acc.id]);

  // ════ the roster ════
  const rosterUrl = `/rosters/${centre.id}/${exam.id}`;
  const assign = await call("PUT", rosterUrl, { assignments: [
    { role: "superintendent", personId: superintendent },
    { role: "observer", personId: observer },
  ] });
  expect("officials are assigned to the roster", assign.status === 200);

  expect("locking needs a signed-in operator",
    (await post(`${rosterUrl}/lock`, { stationDeviceId: station })).status === 401);

  const early = await post(`${rosterUrl}/lock`, { stationDeviceId: station }, token);
  expect("a roster missing an official, to an unpaired station, is refused for both",
    early.body.outcome === "refused" && failed(early, "roster_complete") && failed(early, "station_paired"),
    JSON.stringify(early.body.denyReasons));
  expect("a refused lock issues nothing",
    (await q(`select 1 from led.opening_key where package_id = $1`, [pkg.id])).length === 0);

  await call("PUT", rosterUrl, { assignments: [{ role: "police_escort", personId: police }] });
  const wrapKeys = generateWrapKeypair();
  const reg = await post(`/stations/${station}/wrap-key`, { x25519PubHex: wrapKeys.publicKeyHex });
  expect("the station registers its unwrap key", reg.status === 201);
  const swap = await post(`/stations/${station}/wrap-key`, { x25519PubHex: generateWrapKeypair().publicKeyHex });
  expect("a different unwrap key is not accepted in its place", swap.status === 409);

  // The exam is fifteen minutes away, so this lock is inside the last day.
  const unexplained = await post(`${rosterUrl}/lock`, { stationDeviceId: station }, token);
  expect("a lock inside the last day with no reason is refused",
    unexplained.body.outcome === "refused" && unexplained.body.denyReasons.includes("roster_lock_late") &&
    unexplained.body.denyReasons.length === 1, JSON.stringify(unexplained.body.denyReasons));
  expect("and issues nothing",
    (await q(`select 1 from led.opening_key where package_id = $1`, [pkg.id])).length === 0);

  const lock = await post(`${rosterUrl}/lock`,
    { stationDeviceId: station, lateReason: "exam moved forward by the board this morning" }, token);
  const [firstIssue] = await q(
    `select issue_no, kind, late, reason, lead_seconds, account_id, packets from led.roster_issue where centre_id = $1`, [centre.id]);
  expect("with a reason it locks, and the lock is on record as late, by whom, and why",
    lock.body.late === true && firstIssue?.kind === "lock" && firstIssue.late === true &&
    /moved forward/.test(firstIssue.reason) && firstIssue.account_id === acc.id &&
    firstIssue.lead_seconds > 800 && firstIssue.lead_seconds < 1000 && firstIssue.packets === 1,
    JSON.stringify(firstIssue));
  expect("the roster locks and a key is issued for the packet",
    lock.body.outcome === "locked" && lock.body.packets.length === 1 && lock.body.packets[0].packageId === pkg.id,
    JSON.stringify(lock.body.denyReasons ?? lock.body));
  const round = lock.body.packets[0]?.drandRound;
  const opensAt = timeOfRound(round);
  expect("the control room's part is locked to the round fifteen minutes before the exam",
    Math.abs(opensAt.getTime() - (new Date(exam.starts_at).getTime() - 15 * 60_000)) <= 3000,
    `${opensAt.toISOString()} vs exam ${new Date(exam.starts_at).toISOString()}`);

  const envelopes = await q(`select kind, holder, ciphertext from led.share_envelope where package_id = $1 order by kind`, [pkg.id]);
  expect("one time-locked envelope and three wrapped shares are stored",
    envelopes.filter((e) => e.kind === "control_timelock").length === 1 &&
    envelopes.filter((e) => e.kind === "field_person").length === 3);
  const [keyRow] = await q(`select * from led.opening_key where package_id = $1`, [pkg.id]);
  expect("the commitments are on record", /^[0-9a-f]{64}$/.test(keyRow?.key_commitment ?? ""));

  const relock = await post(`${rosterUrl}/lock`, { stationDeviceId: station, lateReason: "trying a second time" }, token);
  expect("a locked roster does not lock again", relock.body.outcome === "refused" && failed(relock, "roster_unlocked"));
  expect("a locked roster cannot be reassigned",
    (await call("PUT", rosterUrl, { assignments: [{ role: "observer", personId: stranger }] })).status === 409);

  const held = await call("GET", `/stations/${station}/envelopes`);
  expect("the station can fetch its envelope a day ahead",
    held.body.envelopes.length === 1 && held.body.envelopes[0].envelope.round === round);


  const start = (over = {}) => post("/ceremonies", {
    packageId: pkg.id, deviceId: station, seamIdRead: label.seamId, seamSecretHex: secretHex, ...over });

  // ════ a re-issue ════
  // A ceremony is begun and one official identified under the first issue.
  const abandoned = await start();
  const oldShare = await post(`/ceremonies/${abandoned.body.ceremonyId}/official`,
    { personId: superintendent, biometricSlot: 1, biometricScore: 181 });
  expect("a ceremony begins under the first issue and hands over a share",
    abandoned.body.outcome === "passed" && Boolean(oldShare.body.share));

  const swapOut = { changes: [{ role: "police_escort", personId: police2 }], reason: "police escort reassigned by the district" };
  expect("a re-issue needs a signed-in operator",
    (await post(`${rosterUrl}/reissue`, swapOut)).status === 401);
  const noReason = await post(`${rosterUrl}/reissue`, { ...swapOut, reason: "" }, token);
  expect("a re-issue with no reason is refused", noReason.body.outcome === "refused" && failed(noReason, "reason_given"));
  const wrongRole = await post(`${rosterUrl}/reissue`,
    { changes: [{ role: "police_escort", personId: stranger }], reason: "trying an observer as the escort" }, token);
  expect("a replacement on record in another role is refused",
    wrongRole.body.outcome === "refused" && failed(wrongRole, "roles_match"));
  const noChange = await post(`${rosterUrl}/reissue`,
    { changes: [{ role: "police_escort", personId: police }], reason: "the same person as before" }, token);
  expect("a re-issue that changes nobody is refused", noChange.body.outcome === "refused" && failed(noChange, "changes_named"));
  expect("no refused re-issue made a key",
    (await q(`select 1 from led.opening_key where package_id = $1`, [pkg.id])).length === 1);

  const reissue = await post(`${rosterUrl}/reissue`, swapOut, token);
  expect("a re-issue with a reason replaces the official and makes issue 2",
    reissue.body.outcome === "reissued" && reissue.body.issueNo === 2 && reissue.body.packets.length === 1 &&
    reissue.body.changes[0].fromPersonId === police && reissue.body.changes[0].toPersonId === police2,
    JSON.stringify(reissue.body.denyReasons ?? reissue.body));
  const keys = await q(`select issue_no, key_commitment, field_shares from led.opening_key where package_id = $1 order by issue_no`, [pkg.id]);
  expect("the packet has a new key, and the first issue is still on record",
    keys.length === 2 && keys[0].key_commitment !== keys[1].key_commitment &&
    keys[1].field_shares.some((s) => s.personId === police2) && !keys[1].field_shares.some((s) => s.personId === police));
  const allEnvelopes = await q(`select kind, issue_no from led.share_envelope where package_id = $1`, [pkg.id]);
  expect("all three shares and the envelope were made again, none of the old ones removed",
    allEnvelopes.filter((e) => e.issue_no === 2).length === 4 && allEnvelopes.filter((e) => e.issue_no === 1).length === 4);
  const [second] = await q(`select kind, reason, changes from led.roster_issue where centre_id = $1 and issue_no = 2`, [centre.id]);
  expect("the re-issue is on record with its reason and who changed",
    second?.kind === "reissue" && /reassigned/.test(second.reason) && second.changes[0].toPersonId === police2);
  const [dutyNow] = await q(`select person_id from ref.duty_roster where centre_id = $1 and role = 'police_escort'`, [centre.id]);
  expect("the duty roster names the replacement", dutyNow.person_id === police2);

  const carriedOn = await post(`/ceremonies/${abandoned.body.ceremonyId}/official`,
    { personId: observer, biometricSlot: 11, biometricScore: 181 });
  expect("the ceremony begun under the first issue cannot carry on",
    carriedOn.body.outcome === "refused" && failed(carriedOn, "current_issue") && !carriedOn.body.share);

  const rosterView = await call("GET", `/rosters?centreId=${centre.id}`);
  const rv = rosterView.body.rosters[0];
  expect("the roster view shows the key in force and both issues",
    rv.issued.length === 1 && rv.issued[0].issueNo === 2 && rv.issues.length === 2 && rv.issues[1].kind === "reissue");

  // ════ the ceremony ════

  const swapped = await start({ seamSecretHex: "ab".repeat(16) });
  expect("a label that does not match what was sealed stops the ceremony",
    swapped.body.outcome === "refused" && swapped.body.scan.denyReasons.includes("seam_token_mismatch"));
  expect("and raises SEAL_MISMATCH",
    (await q(`select 1 from led.alert where kind = 'SEAL_MISMATCH' and package_id = $1`, [pkg.id])).length === 1);

  const elsewhere = await start({ deviceId: otherStation });
  expect("a station the shares were not wrapped to is not authorised",
    elsewhere.body.outcome === "refused" && failed(elsewhere.body.authorize, "station_holds_envelopes"));

  const begun = await start();
  expect("the scan and the authorisation pass at the right station",
    begun.status === 201 && begun.body.outcome === "passed", JSON.stringify([begun.body.scan?.denyReasons, begun.body.authorize?.denyReasons]));
  const cid = begun.body.ceremonyId;
  const official = (personId, slot, over = {}) =>
    post(`/ceremonies/${cid}/official`, { personId, biometricSlot: slot, biometricScore: 181, ...over });

  const tooSoon = await post(`/ceremonies/${cid}/confirm`, { packetSerialTyped: serial });
  expect("the serial cannot be confirmed before two officials are identified",
    tooSoon.body.outcome === "refused" && tooSoon.body.denyReasons.includes("ceremony_step_out_of_order") && !tooSoon.body.envelope);

  const notOnRoster = await official(stranger, 31);
  expect("someone not on the locked roster is refused and handed no share",
    notOnRoster.body.outcome === "refused" && !notOnRoster.body.share && notOnRoster.body.denyReasons.includes("person_not_on_roster"));

  const wrongFinger = await official(superintendent, 11);
  expect("an official presenting another official's finger is refused",
    wrongFinger.body.outcome === "refused" && failed(wrongFinger, "slot_registered") && !wrongFinger.body.share);

  const one = await official(superintendent, 1);
  expect("the first official is identified and their wrapped share is released",
    one.body.outcome === "passed" && Boolean(one.body.share?.wrapped?.ciphertextHex), JSON.stringify(one.body.denyReasons));
  const oneAgain = await official(superintendent, 1);
  expect("the same official cannot be the second", oneAgain.body.outcome === "refused" && failed(oneAgain, "not_already_identified"));

  const two = await official(observer, 11);
  expect("the second official, from another institution, is identified",
    two.body.outcome === "passed" && two.body.identified === 2 && Boolean(two.body.share));
  const three = await official(police, 21);
  expect("a third share is not released", three.body.outcome === "refused" && !three.body.share);

  const wrongSerial = await post(`/ceremonies/${cid}/confirm`, { packetSerialTyped: "PKT-WRONG" });
  expect("a wrong serial is refused", wrongSerial.body.outcome === "refused" && wrongSerial.body.denyReasons.includes("packet_serial_mismatch"));
  const confirm = await post(`/ceremonies/${cid}/confirm`, { packetSerialTyped: serial.toLowerCase() });
  expect("the right serial is confirmed and the envelope handed over",
    confirm.body.outcome === "passed" && confirm.body.envelope?.round === round && Boolean(confirm.body.commitments?.keyCommitment));

  // ── before the round ──
  const beforeMs = opensAt.getTime() - Date.now();
  const guess = await post(`/ceremonies/${cid}/release`, { openingKeyHex: randomBytes(32).toString("hex") });
  expect("before the round is published, a release is refused as still locked",
    beforeMs <= 0 || (guess.body.outcome === "refused" && guess.body.denyReasons.includes("control_part_still_locked")),
    `${Math.round(beforeMs / 1000)}s before; ${JSON.stringify(guess.body.denyReasons)}`);
  expect("and a key that is not the key does not match the commitment", guess.body.denyReasons.includes("opening_key_mismatch"));

  let lockedOut = false;
  try {
    await unwrapControlPart(confirm.body.envelope, { round: round - 1, signature: "00".repeat(48) });
  } catch { lockedOut = true; }
  expect("the envelope does not open with an earlier round's beacon", lockedOut);

  // ── the station unwraps what it was handed ──
  const shares = [one, two].map((r) => ({
    index: r.body.share.index,
    holder: r.body.share.holder,
    institution: r.body.share.institution,
    commitment: r.body.share.commitment,
    share: unwrapShare(r.body.share.wrapped, wrapKeys.privateKeyHex,
      shareContext(pkg.id, r.body.share.holder, r.body.official.personId)),
  }));
  expect("the station unwraps both officials' shares with its own key",
    shares.every((s) => createHash("sha256").update(s.share).digest("hex") === s.commitment));

  // ── wait for drand ──
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
    expect("the published round opens the control room's part",
      createHash("sha256").update(controlPart).digest("hex") === confirm.body.commitments.controlCommitment);

    let alone = false;
    try { await combineOpeningKey(undefined, shares, confirm.body.commitments); } catch { alone = true; }
    expect("the two officials' shares without the control room's part open nothing", alone);

    const key = await combineOpeningKey(controlPart, shares, confirm.body.commitments);
    const keyHex = Buffer.from(key).toString("hex");

    const release = await post(`/ceremonies/${cid}/release`, { openingKeyHex: keyHex });
    expect("the key the station assembled is accepted: GRANTED",
      release.body.outcome === "granted", JSON.stringify(release.body.denyReasons));

    const stored = JSON.stringify([
      await q(`select * from led.share_envelope where package_id = $1`, [pkg.id]),
      await q(`select * from led.opening_key where package_id = $1`, [pkg.id]),
      await q(`select s.* from led.ceremony_step s join led.ceremony c on c.id = s.ceremony_id where c.package_id = $1`, [pkg.id]),
    ]);
    expect("the key, the control part and the shares are nowhere in the database",
      !stored.includes(keyHex) && !stored.includes(Buffer.from(controlPart).toString("hex")) &&
      shares.every((s) => !stored.includes(Buffer.from(s.share).toString("hex"))));

    const twice = await post(`/ceremonies/${cid}/release`, { openingKeyHex: keyHex });
    expect("the key is released once", twice.body.outcome === "refused");

    const tooLate = await post(`${rosterUrl}/reissue`,
      { changes: [{ role: "police_escort", personId: police }], reason: "changing it back after the opening" }, token);
    expect("after the opening minute the roster is not re-issued",
      tooLate.body.outcome === "refused" && failed(tooLate, "opening_in_future") && failed(tooLate, "packets_to_rekey"),
      JSON.stringify(tooLate.body.denyReasons));

    const opened = await post(`/ceremonies/${cid}/opened`, { photoSha256: "ef".repeat(32), candidateWitnesses: 2 });
    const [state] = await q(`select state from ref.package where id = $1`, [pkg.id]);
    expect("the opening is recorded with its photograph and the packet is marked opened",
      opened.body.outcome === "opened" && state.state === "opened");

    const view = await call("GET", `/ceremonies/${cid}`);
    expect("the ceremony reads back as opened, every step on record",
      view.body.reached === "opened" && view.body.officials.length === 2 &&
      view.body.steps.filter((s) => s.outcome === "refused").length >= 6,
      `${view.body.reached}, ${view.body.steps.length} steps`);
  }

  // ════ the hard floor ════
  const [pkg2c] = await q(
    `insert into ref.centre (exam_id, code, lat, lon, capacity) values ($1,$2,26.9,75.7,300) returning id`,
    [exam.id, `OP2-${tag}`]);
  const [pkg2] = await q(
    `insert into ref.package (exam_id, centre_id, seal_serial, copies, state) values ($1,$2,$3,300,'at_centre') returning id`,
    [exam.id, pkg2c.id, `PKT-OP2-${tag}`]);
  const label2 = generateSeamLabel();
  await q(`insert into ref.seal_label (package_id, seam_id, commitment_hex) values ($1,$2,$3)`,
    [pkg2.id, label2.seamId, label2.commitment]);
  const stalled = await post("/ceremonies", {
    packageId: pkg2.id, deviceId: station, seamIdRead: label2.seamId,
    seamSecretHex: Buffer.from(label2.seamSecret).toString("hex") });
  expect("a ceremony for a packet with no key issued passes its scan and is not authorised",
    stalled.body.scan.outcome === "passed" && stalled.body.authorize.denyReasons.includes("opening_key_not_issued"));

  const later = new Date(new Date(exam.starts_at).getTime() - 14 * 60_000);
  const incomplete = await sweepIncompleteCeremonies(pool, later);
  expect("a ceremony started and not released by its time raises CEREMONY_INCOMPLETE",
    incomplete.includes(pkg2.id) && !incomplete.includes(pkg.id), JSON.stringify(incomplete));
  const [floor] = await q(`select evidence, consequence from led.alert where kind = 'CEREMONY_INCOMPLETE' and package_id = $1`, [pkg2.id]);
  expect("it says how far the ceremony got", floor?.evidence.reached === "scan" && /control room takes over/.test(floor.consequence));
  expect("it is raised once", (await sweepIncompleteCeremonies(pool, later)).length === 0);
  const unopened = await sweepUnopenedPackets(pool, later);
  expect("the unopened-packet sweep leaves packets with a ceremony to the ceremony's own alert",
    !unopened.some((u) => u.packageId === pkg.id || u.packageId === pkg2.id));
} catch (err) {
  expect("the run completed", false, err.stack ?? String(err));
} finally {
  await client.query("rollback").catch(() => {});
  const left = await client
    .query(`select count(*)::int as n from ref.authority where name like 'opening e2e %'`)
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
