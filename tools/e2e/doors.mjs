#!/usr/bin/env node
/**
 * The strong room door and the damaged-label override, against a real
 * Postgres, leaving nothing behind.
 *
 *   E2E_OWNER_URL=postgres://<schema owner>@host/<db>  node tools/e2e/doors.mjs
 *
 * Safe to point at a database you care about: like seal.mjs and sweeps.mjs,
 * everything runs inside one transaction that is rolled back at the end. The
 * routes are the ledger's own, on a Fastify instance that is never bound to a
 * port.
 *
 * The override is approved over a video call. No media can flow in a script, so
 * the script plays both ends of the call's set-up and reports through the
 * ledger's own call routes: what is checked here is what the ledger records and
 * how the approval reads that record, not that a camera works.
 *
 * Needs every migration applied, through 015. Build first (`pnpm build`).
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
const { registerStrongroomRoutes } = await import(at("services/ledger/dist/http/strongroom-routes.js"));
const { registerOverrideRoutes } = await import(at("services/ledger/dist/http/override-routes.js"));
const { registerTransferRoutes } = await import(at("services/ledger/dist/http/transfer-routes.js"));
const { sweepOverstays, dwellLimitSeconds } = await import(at("services/ledger/dist/domain/strongroom.js"));
const { generateSeamLabel } = await import(at("packages/crypto-core/dist/index.js"));

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

const app = Fastify({ logger: false });
registerTransferRoutes(app, pool);
registerOverrideRoutes(app, pool);
registerStrongroomRoutes(app, pool);
await app.ready();
const call = async (method, url, payload, token) => {
  const res = await app.inject({
    method, url, payload,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const post = (url, payload, token) => call("POST", url, payload, token);
const get = (url) => call("GET", url);

await client.query("begin");
try {
  const tag = randomBytes(3).toString("hex");
  const person = async (name, role) =>
    (await q(`insert into ref.person (display_name, role, govt_id_hash) values ($1,$2,$3) returning id`,
      [name, role, randomBytes(32)]))[0].id;
  const device = async (kind = "centre_pc") =>
    (await q(`insert into ref.device (kind, pubkey) values ($1,$2) returning id`, [kind, randomBytes(32)]))[0].id;
  const enrol = (deviceId, slot, personId, role) =>
    q(`insert into ref.fingerprint_enrolment (device_id, template_slot, person_id, role) values ($1,$2,$3,$4)`,
      [deviceId, slot, personId, role]);
  // An operator account with a live session, written directly: the routes
  // under test read the session, they do not create it.
  const operator = async (username) => {
    const [acc] = await q(
      `insert into ref.account (username, password_hash, password_salt, display_name)
       values ($1,$2,$3,$4) returning id`,
      [`${username}-${tag}`, randomBytes(64), randomBytes(16), `Operator ${username}`]);
    const token = randomBytes(24).toString("hex");
    await q(`insert into ref.session (token_hash, account_id, expires_at) values ($1,$2, now() + interval '1 hour')`,
      [createHash("sha256").update(token).digest(), acc.id]);
    return token;
  };

  // ════ the strong room door ════
  const door = await device();
  const custodian = await person("C. Rathore", "custodian");
  const officer = await person("D. Singh", "district_officer");
  const courier = await person("B. Meena", "courier");
  await enrol(door, 1, custodian, "custodian");
  await enrol(door, 11, officer, "district_officer");
  await enrol(door, 21, courier, "courier");

  const room = (await post("/rooms", { name: `Strong room ${tag}`, place: "District treasury" })).body.roomId;
  expect("a room is registered", /^[0-9a-f-]{36}$/.test(room ?? ""));

  const nowIso = () => new Date().toISOString();
  const finger = (personId, slot, over = {}) => ({
    personId, biometricSlot: slot, biometricScore: 180, assertedAt: nowIso(), ...over,
  });
  const entry = (entrants, over = {}) =>
    post(`/rooms/${room}/entry`, { deviceId: door, entrants, task: "collect one packet", expectedMinutes: 4, ...over });
  const failed = (r, check) => r.body.checks?.find((c) => c.check === check)?.passed === false;

  const alone = await entry([finger(custodian, 1)]);
  expect("one person at the door is refused",
    alone.body.outcome === "refused" && alone.body.denyReasons.includes("two_person_required"), JSON.stringify(alone.body.denyReasons));

  const twice = await entry([finger(custodian, 1), finger(custodian, 1)]);
  expect("the same person twice is refused", twice.body.outcome === "refused" && failed(twice, "two_entrants"));

  const barred = await entry([finger(custodian, 1), finger(courier, 21)]);
  expect("a courier is not let into a strong room",
    barred.body.outcome === "refused" && barred.body.denyReasons.includes("person_role_not_permitted"));

  const borrowed = await entry([finger(custodian, 1), finger(officer, 1)]);
  expect("a finger registered to someone else does not stand for the person named",
    borrowed.body.outcome === "refused" && failed(borrowed, "slots_registered"));

  const apart = await entry([
    finger(custodian, 1, { assertedAt: new Date(Date.now() - 200_000).toISOString() }),
    finger(officer, 11),
  ]);
  expect("two fingers more than 120 s apart are refused",
    apart.body.outcome === "refused" && apart.body.denyReasons.includes("two_person_window_not_met"));

  const weak = await entry([finger(custodian, 1, { biometricScore: 31 }), finger(officer, 11)]);
  expect("a doubtful fingerprint is refused", weak.body.outcome === "refused" && failed(weak, "biometric_scores"));

  const noFace = await entry([finger(custodian, 1, { faceMatched: true }), finger(officer, 11, { faceMatched: false })]);
  expect("a face that does not match is refused",
    noFace.body.outcome === "refused" && noFace.body.denyReasons.includes("face_not_matched"));

  const several = await entry([finger(custodian, 1, { biometricScore: 20 })], { deviceId: randomUUID() });
  expect("a refusal names everything that was wrong, not the first thing",
    several.body.denyReasons.length >= 3, several.body.denyReasons.join(","));

  expect("no refused attempt opened a visit",
    (await q(`select 1 from led.strongroom_visit where room_id = $1`, [room])).length === 0);
  expect("every refused attempt is on record",
    (await q(`select 1 from led.strongroom_attempt where room_id = $1 and outcome = 'refused'`, [room])).length === 8);

  const ok = await entry([finger(custodian, 1), finger(officer, 11)]);
  expect("two verified people within 120 s are let in",
    ok.body.outcome === "granted" && Boolean(ok.body.visitId), JSON.stringify(ok.body.denyReasons));
  const visitId = ok.body.visitId;
  expect("a room attached to no centre has no exam to file an event under, and the answer says so",
    ok.body.chainEvent?.recorded === false && /no centre/.test(ok.body.chainEvent.reason),
    JSON.stringify(ok.body.chainEvent));

  const rooms = await get("/rooms");
  const mine = rooms.body.rooms.find((r) => r.id === room);
  expect("the room shows who is inside", mine?.inside.length === 1 && mine.inside[0].visitId === visitId);

  // A visit that never ends: push its entry back past the limit and sweep.
  await q(`update led.strongroom_visit set entered_at = now() - interval '40 minutes' where id = $1`, [visitId]);
  expect("the limit for a four-minute task is nine minutes", dwellLimitSeconds(4) === 9 * 60);
  const swept = await sweepOverstays(pool);
  expect("a visit with no exit past its limit raises DWELL_EXCEEDED", swept.includes(visitId));
  const [still] = await q(`select evidence, consequence from led.alert where kind = 'DWELL_EXCEEDED' and evidence ->> 'visitId' = $1`, [visitId]);
  expect("the alert says they are still inside and names them",
    still?.evidence.stillInside === true && /C\. Rathore/.test(still.consequence) && /no exit is on record/.test(still.consequence));
  expect("it is raised once", (await sweepOverstays(pool)).length === 0);

  const out = await post(`/rooms/${room}/exit`, { deviceId: door, visitId, packagesTouched: 1 });
  expect("the exit is recorded with how long they stayed",
    out.body.outcome === "granted" && out.body.dwellSeconds >= 2390 && out.body.dwellExceeded === true, JSON.stringify(out.body));
  expect("footfall is reported as not evaluated when the room has no monitor",
    out.body.footfall?.evaluated === false && /no monitor/.test(out.body.footfall.detail));
  expect("the long stay is not alerted a second time at exit",
    (await q(`select 1 from led.alert where kind = 'DWELL_EXCEEDED' and evidence ->> 'visitId' = $1`, [visitId])).length === 1);

  const again = await post(`/rooms/${room}/exit`, { deviceId: door, visitId, packagesTouched: 0 });
  expect("a second exit for the same visit is refused",
    again.body.outcome === "refused" && again.body.denyReasons.includes("visit_already_closed"));

  // ── a room with a monitor: footfall from the monitor's own events ──
  const monitor = await device("monitor");
  const watched = (await post("/rooms", { name: `Watched room ${tag}`, place: "Treasury annexe", monitorDeviceId: monitor })).body.roomId;
  const [auth] = await q(`insert into ref.authority (name) values ($1) returning id`, [`doors e2e ${tag}`]);
  const [exam] = await q(
    `insert into ref.exam (authority_id, name, mode, starts_at, drand_round, sides_per_copy)
     values ($1,$2,'escorted', now() + interval '1 day', 21000000, 4) returning id`, [auth.id, `Physics ${tag}`]);
  const in2 = await post(`/rooms/${watched}/entry`, {
    deviceId: door, entrants: [finger(custodian, 1), finger(officer, 11)], task: "audit", expectedMinutes: 30 });
  // The monitor's signed door event, as the chain holds it: three bodies in.
  await q(
    `insert into led.event (id, exam_id, kind, occurred_at, received_at, clock_skew_ms, actor_device,
                            body, device_sig, body_hash, prev_hash, hash)
     values ($1,$2,'ROOM_ENTRY', now(), now(), 0, $3, $4::jsonb, $5, $6, $7, $8)`,
    [randomUUID(), exam.id, monitor,
      JSON.stringify({ payload: { monitorId: monitor, sequence: 1, doorOpen: true, enteredAtLeast: 3, exitedAtLeast: 0, presence: true, lightOn: true } }),
      Buffer.alloc(64), Buffer.alloc(32), randomBytes(32), randomBytes(32)]);
  const out2 = await post(`/rooms/${watched}/exit`, { deviceId: door, visitId: in2.body.visitId, packagesTouched: 0 });
  expect("three counted in against two admitted is a footfall mismatch",
    out2.body.footfall?.evaluated === true && out2.body.footfall.countedAtLeast === 3 && out2.body.footfall.mismatch === true,
    JSON.stringify(out2.body.footfall));
  const [ff] = await q(`select consequence from led.alert where kind = 'FOOTFALL_MISMATCH' and evidence ->> 'visitId' = $1`, [in2.body.visitId]);
  expect("FOOTFALL_MISMATCH is raised with the count", /at least 3 people/.test(ff?.consequence ?? ""));

  // ════ the damaged-label override ════
  const LAT = 26.9124, LON = 75.7873;
  const [centre] = await q(
    `insert into ref.centre (exam_id, code, lat, lon, capacity) values ($1,$2,$3,$4,300) returning id`,
    [exam.id, `DR-${tag}`, LAT, LON]);
  const serial = `PKT-DR-${tag}`;
  const [pkg] = await q(
    `insert into ref.package (exam_id, centre_id, seal_serial, copies) values ($1,$2,$3,300) returning id`,
    [exam.id, centre.id, serial]);
  const label = generateSeamLabel();
  await q(`insert into ref.seal_label (package_id, seam_id, commitment_hex) values ($1,$2,$3)`,
    [pkg.id, label.seamId, label.commitment]);
  const press = await person("A. Sharma", "press_operator");
  const phone = await device("field");
  const now = Date.now();
  const leg = (await post("/legs", {
    packageId: pkg.id, legNo: 1, fromRole: "press_operator", toRole: "courier",
    fromPlace: "Government Press, Jaipur", toPlace: "Route vehicle",
    windowStart: new Date(now - 3600e3).toISOString(), windowEnd: new Date(now + 3600e3).toISOString(),
    expectedBy: new Date(now + 1800e3).toISOString(),
  })).body.legId;
  const plan = { legNo: 9, fromRole: "courier", toRole: "custodian", fromPlace: "a", toPlace: "b",
    windowStart: new Date(now).toISOString(), windowEnd: new Date(now + 60e3).toISOString(), expectedBy: new Date(now + 30e3).toISOString() };
  expect("a leg planned for a packet that does not exist is answered as that, not as a server fault",
    (await post("/legs", { ...plan, packageId: randomUUID() })).status === 404);
  expect("and so is a leg naming a strong room that does not exist",
    (await post("/legs", { ...plan, packageId: pkg.id, roomId: randomUUID() })).status === 404);
  const step = { deviceId: phone, personId: press, biometricSlot: 3, biometricScore: 190 };
  const photo = "cd".repeat(32);

  const noScan = await post(`/legs/${leg}/dispatch`, step);
  expect("a hand-off with no scan and no override is refused",
    noScan.body.outcome === "refused" && noScan.body.denyReasons.includes("seam_token_absent"));

  const wrongId = await post(`/legs/${leg}/override`, {
    deviceId: phone, personId: press, seamIdTyped: generateSeamLabel().seamId,
    attemptedSeconds: 10, whichCodes: "both", photoSha256: photo });
  expect("a request typing another label's seam id is recorded and unusable",
    wrongId.status === 201 && wrongId.body.standing.status === "unusable");

  const request = await post(`/legs/${leg}/override`, {
    deviceId: phone, personId: press, seamIdTyped: label.seamId, serialTyped: serial,
    attemptedSeconds: 10, whichCodes: "both", photoSha256: photo });
  const overrideId = request.body.overrideId;
  expect("a damaged-label request is recorded as pending",
    request.status === 201 && request.body.standing.status === "pending" && request.body.evidence.seamIdMatches === true);
  expect("the control room is told: SEAM_DECODE_FAILED",
    (await q(`select 1 from led.alert where kind = 'SEAM_DECODE_FAILED' and evidence ->> 'overrideId' = $1`, [overrideId])).length === 1);
  const decodeEvents = await q(
    `select body from led.event where package_id = $1 and kind = 'SEAM_DECODE_FAILED' order by seq`, [pkg.id]);
  expect("both reports are on the chain with the photograph's hash and what was typed",
    decodeEvents.length === 2 && request.body.chainEvent?.recorded === true &&
    decodeEvents[1].body.payload.seamIdTyped === label.seamId && decodeEvents[1].body.payload.photoSha256 === photo,
    JSON.stringify(request.body.chainEvent));

  const pending = await post(`/legs/${leg}/dispatch`, { ...step, overrideId });
  expect("an override nobody has approved does not pass the seam check",
    pending.body.outcome === "refused" && pending.body.denyReasons.includes("seam_override_not_approved"));

  const approve = { decision: "approved", videoConfirmed: true, officersPresent: true, note: "seen on video, label torn at the corner" };
  expect("deciding needs a signed-in operator", (await post(`/overrides/${overrideId}/decision`, approve)).status === 401);
  const op1 = await operator("first");
  const op2 = await operator("second");
  const blind = await post(`/overrides/${overrideId}/decision`, { ...approve, videoConfirmed: false }, op1);
  expect("an approval without the video confirmation is not accepted", blind.status === 400);

  // ── the call the approval is given over ──
  const callUrl = `/overrides/${overrideId}/call`;
  const failedCall = (r) => (r.body.call?.checks ?? []).filter((c) => !c.passed).map((c) => c.check).join();
  const SDP = (who) => `v=0\r\no=- ${who} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n`;

  const noCall = await post(`/overrides/${overrideId}/decision`, approve, op1);
  expect("an approval with no call on record is turned away, and says what is missing",
    noCall.status === 409 && failedCall(noCall) === "call_set_up,operator_saw_video,field_confirmed",
    `${noCall.status} ${failedCall(noCall)}`);
  expect("that attempt is itself on record",
    (await q(`select 1 from led.override_call where request_id = $1 and event = 'approval_refused'`, [overrideId])).length === 1);
  expect("and decided nothing",
    (await q(`select 1 from led.seam_override_decision where request_id = $1`, [overrideId])).length === 0);

  expect("opening the call needs a signed-in operator", (await post(`${callUrl}/join`, {})).status === 401);
  const op1Join = await post(`${callUrl}/join`, {}, op1);
  const op1Id = op1Join.body.you;
  expect("an operator opens the call and is told the phone is not on it yet",
    op1Join.status === 200 && op1Join.body.devicePresent === false && Array.isArray(op1Join.body.iceServers));

  const otherPhone = await device("field");
  expect("a phone that did not make the request cannot be the phone on its call",
    (await post(`${callUrl}/device/join`, { deviceId: otherPhone })).status === 403);
  expect("an offer to an operator who has not opened the call is not carried",
    (await post(`${callUrl}/device/offer`, { deviceId: phone, to: randomUUID(), sdp: SDP("phone") })).status === 409);

  const phoneJoin = await post(`${callUrl}/device/join`, { deviceId: phone });
  expect("the requesting phone opens the call and is told which operators are waiting",
    phoneJoin.status === 200 && phoneJoin.body.operators.length === 1 && phoneJoin.body.operators[0].accountId === op1Id);
  const phoneInbox = await post(`${callUrl}/device/inbox`, { deviceId: phone, after: 0 });
  expect("the phone's inbox tells it to offer that operator a call",
    phoneInbox.body.signals.some((s) => s.kind === "operator-joined" && s.from === op1Id));
  expect("another phone cannot read that inbox",
    (await post(`${callUrl}/device/inbox`, { deviceId: otherPhone, after: 0 })).status === 403);

  const offered = await post(`${callUrl}/device/offer`, { deviceId: phone, to: op1Id, sdp: SDP("phone") });
  const op1Inbox = await call("GET", `${callUrl}/inbox?after=0`, undefined, op1);
  expect("the ledger carries the phone's offer to that operator",
    offered.status === 202 && op1Inbox.body.signals.some((s) => s.kind === "offer" && s.sdp === SDP("phone")));
  const answered = await post(`${callUrl}/answer`, { sdp: SDP("op1") }, op1);
  const phoneInbox2 = await post(`${callUrl}/device/inbox`, { deviceId: phone, after: phoneInbox.body.signals.at(-1).seq });
  expect("and the operator's answer back to the phone",
    answered.status === 202 && phoneInbox2.body.signals.length === 1 &&
    phoneInbox2.body.signals[0].kind === "answer" && phoneInbox2.body.signals[0].from === op1Id);

  await post(`${callUrl}/state`, { state: "connected", framesDecoded: 0 }, op1);
  const noPicture = await post(`/overrides/${overrideId}/decision`, approve, op1);
  expect("a call that connected but showed the operator no video does not carry an approval",
    noPicture.status === 409 && failedCall(noPicture) === "operator_saw_video,field_confirmed", failedCall(noPicture));

  await post(`${callUrl}/state`, { state: "connected", framesDecoded: 214, width: 640, height: 480 }, op1);
  const oneSided = await post(`/overrides/${overrideId}/decision`, approve, op1);
  expect("nor does one the phone has not confirmed from its end",
    oneSided.status === 409 && failedCall(oneSided) === "field_confirmed", failedCall(oneSided));

  await post(`${callUrl}/device/state`, { deviceId: phone, operator: op1Id, state: "connected" });

  const first = await post(`/overrides/${overrideId}/decision`, approve, op1);
  const [firstRow] = await q(
    `select call_evidence from led.seam_override_decision where request_id = $1`, [overrideId]);
  expect("with the call set up, video seen and the phone confirming, the approval is recorded with that evidence",
    first.status === 201 && first.body.call.onRecord === true && firstRow?.call_evidence.required === true &&
    firstRow.call_evidence.checks.length === 3 && firstRow.call_evidence.checks.every((c) => c.passed),
    JSON.stringify(first.body));
  expect("one approval leaves it pending", first.status === 201 && first.body.standing.status === "pending" && first.body.standing.approvals === 1);
  const sameAgain = await post(`/overrides/${overrideId}/decision`, approve, op1);
  expect("the same operator cannot be the second approval", sameAgain.status === 409);
  const stillPending = await post(`/legs/${leg}/dispatch`, { ...step, overrideId });
  expect("one approval is not enough for the hand-off", stillPending.body.outcome === "refused");

  const borrowedCall = await post(`/overrides/${overrideId}/decision`, approve, op2);
  expect("the second operator cannot approve on the first operator's call",
    borrowedCall.status === 409 && failedCall(borrowedCall) === "call_set_up,operator_saw_video,field_confirmed");

  const op2Id = (await post(`${callUrl}/join`, {}, op2)).body.you;
  await post(`${callUrl}/device/offer`, { deviceId: phone, to: op2Id, sdp: SDP("phone-2") });
  await post(`${callUrl}/answer`, { sdp: SDP("op2") }, op2);
  await post(`${callUrl}/state`, { state: "connected", framesDecoded: 96 }, op2);
  await post(`${callUrl}/device/state`, { deviceId: phone, operator: op2Id, state: "connected" });

  const second = await post(`/overrides/${overrideId}/decision`, approve, op2);
  expect("a second operator's approval, over their own call, approves it",
    second.status === 201 && second.body.standing.status === "approved", JSON.stringify(second.body));
  const [manualEvent] = await q(
    `select body from led.event where package_id = $1 and kind = 'SEAM_MANUAL_OVERRIDE' order by seq desc limit 1`,
    [pkg.id]);
  expect("the second approval appends both operator account IDs and the requesting person to the chain",
    second.body.chainEvent?.recorded === true &&
    manualEvent?.body.payload.approverAccountIds.length === 2 &&
    manualEvent.body.payload.fieldPersonIds.length === 1 &&
    manualEvent.body.payload.fieldPersonIds[0] === press &&
    manualEvent.body.payload.approvalChannel === "live-video",
    JSON.stringify(second.body.chainEvent));

  const record = await get(callUrl);
  expect("the call's record names both operators and shows each one's call standing",
    record.body.operators.length === 2 && record.body.operators.every((o) => o.onRecord) &&
    record.body.events.filter((e) => e.event === "approval_refused").length === 4 &&
    record.body.events.filter((e) => e.event === "offered").length === 2);
  const ownRequests = await post("/overrides/device-requests", { deviceId: phone });
  expect("the phone can list its own requests and how many approvals each has",
    ownRequests.body.requests.some((r) => r.id === overrideId && r.approvals === 2) &&
    (await post("/overrides/device-requests", { deviceId: otherPhone })).body.requests.length === 0);
  const [flag] = await q(`select consequence, evidence from led.alert where kind = 'SEAM_MANUAL_OVERRIDE' and evidence ->> 'overrideId' = $1`, [overrideId]);
  expect("the packet is flagged for inspection, naming both approvers",
    /inspected by hand/.test(flag?.consequence ?? "") && flag.evidence.approvers.length === 2);

  const through = await post(`/legs/${leg}/dispatch`, { ...step, overrideId });
  const seam = through.body.checks?.find((c) => c.check === "seam_commitment");
  expect("the approved override stands in for the scan on that leg",
    through.body.outcome === "granted" && /override approved by/.test(seam?.evidence ?? ""), JSON.stringify(through.body.denyReasons));
  expect("every other check on the leg still ran",
    through.body.checks.filter((c) => c.passed !== undefined).length >= 8);

  const leg2 = (await post("/legs", {
    packageId: pkg.id, legNo: 2, fromRole: "courier", toRole: "custodian",
    fromPlace: "Route vehicle", toPlace: "District strong room",
    windowStart: new Date(now - 3600e3).toISOString(), windowEnd: new Date(now + 3600e3).toISOString(),
    expectedBy: new Date(now + 1800e3).toISOString(),
  })).body.legId;
  const reuse = await post(`/legs/${leg2}/dispatch`, { ...step, personId: courier, overrideId });
  expect("an override approved for one leg does not pass another",
    reuse.body.denyReasons.includes("seam_override_not_approved"));

  const refusedReq = (await post(`/legs/${leg2}/override`, {
    deviceId: phone, personId: courier, seamIdTyped: label.seamId, attemptedSeconds: 12, whichCodes: "A", photoSha256: photo })).body.overrideId;
  const no = await post(`/overrides/${refusedReq}/decision`,
    { decision: "refused", videoConfirmed: true, officersPresent: false, note: "only one officer on camera" }, op1);
  expect("one refusal refuses it", no.body.standing.status === "refused");
  expect("a refusal needs no call", no.status === 201 && no.body.call.onRecord === false);
  const late = await post(`/overrides/${refusedReq}/decision`, approve, op2);
  expect("a refused request cannot then be approved", late.status === 409);

  // A deployment that has turned the call requirement off takes the operator's
  // word, as before, and every decision says that is what it did.
  const lax = Fastify({ logger: false });
  registerOverrideRoutes(lax, pool, { callRequired: false });
  await lax.ready();
  const wordOnly = (await post(`/legs/${leg2}/override`, {
    deviceId: phone, personId: courier, seamIdTyped: label.seamId, attemptedSeconds: 9, whichCodes: "B", photoSha256: photo })).body.overrideId;
  const laxRes = await lax.inject({
    method: "POST", url: `/overrides/${wordOnly}/decision`, payload: approve, headers: { authorization: `Bearer ${op1}` } });
  const [laxRow] = await q(`select call_evidence from led.seam_override_decision where request_id = $1`, [wordOnly]);
  expect("with the requirement off, an approval with no call is accepted and recorded as exactly that",
    laxRes.statusCode === 201 && laxRow?.call_evidence.required === false && laxRow.call_evidence.onRecord === false);
  await lax.close();

  const list = await get("/overrides");
  const row = list.body.overrides.find((o) => o.id === overrideId);
  expect("the list shows the request, both decisions and that it was used",
    row?.decisions.length === 2 && row.used === true && row.standing.status === "approved");

  const stats = await get("/overrides/stats");
  const c = stats.body.byCentre.find((x) => x.key === centre.id);
  expect("the override rate is counted per centre: one of two legs",
    c?.legs === 2 && c.overrides === 1 && c.per100 === 50, JSON.stringify(c));
  expect("and per officer", stats.body.byOfficer.some((o) => o.key === press && o.overrides === 1));

  // The app role cannot rewrite any of it.
  const grants = await q(
    `select table_name, privilege_type from information_schema.table_privileges
      where table_schema = 'led' and grantee = 'mohar_app'
        and table_name in ('strongroom_attempt','seam_override_request','seam_override_decision','opening_key','override_call')
        and privilege_type in ('UPDATE','DELETE','TRUNCATE')`);
  expect("mohar_app holds no UPDATE or DELETE on the new led tables", grants.length === 0, JSON.stringify(grants));
} catch (err) {
  expect("the run completed", false, err.stack ?? String(err));
} finally {
  await client.query("rollback").catch(() => {});
  const left = await client
    .query(`select count(*)::int as n from ref.strong_room where name like 'Strong room %' and place = 'District treasury'`)
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
