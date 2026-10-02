import test from "node:test";
import assert from "node:assert/strict";
import { CALL_FRESH_MS, CallRooms, judgeCall, type CallRow } from "./override-call.js";

/**
 * ── The override's call: what counts as one, and how its set-up is carried ───
 *
 * The rule and the mailboxes, without a database. The routes, the record and
 * the approval that reads it are exercised by tools/e2e/doors.mjs.
 */

const NOW = new Date("2026-10-02T09:00:00.000Z");
const OP = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PHONE = "33333333-3333-4333-8333-333333333333";
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

const row = (party: CallRow["party"], event: CallRow["event"], secondsAgo: number, over: Partial<CallRow> = {}): CallRow => ({
  party,
  accountId: OP,
  deviceId: party === "field" ? PHONE : null,
  event,
  detail: {},
  recordedAt: ago(secondsAgo),
  ...over,
});

const live: CallRow[] = [
  row("field", "offered", 60),
  row("operator", "answered", 58),
  row("operator", "connected", 50, { detail: { framesDecoded: 120 } }),
  row("field", "connected", 49),
];
const failed = (rows: CallRow[], who = OP) =>
  judgeCall(rows, who, NOW).checks.filter((c) => !c.passed).map((c) => c.check);

test("an offer carried, an answer carried, video seen and the phone confirming is a call on record", () => {
  const s = judgeCall(live, OP, NOW);
  assert.equal(s.onRecord, true);
  assert.deepEqual(s.checks.map((c) => c.check), ["call_set_up", "operator_saw_video", "field_confirmed"]);
});

test("nothing on record fails every check", () => {
  assert.deepEqual(failed([]), ["call_set_up", "operator_saw_video", "field_confirmed"]);
});

test("one operator's call is not another's", () => {
  assert.deepEqual(failed(live, OTHER), ["call_set_up", "operator_saw_video", "field_confirmed"]);
});

test("an offer the operator never answered is not a call", () => {
  assert.deepEqual(failed(live.filter((r) => r.event !== "answered")), ["call_set_up"]);
});

test("an answer from before the phone's latest offer does not answer it", () => {
  assert.deepEqual(failed([...live, row("field", "offered", 10)]), ["call_set_up"]);
});

test("connected with no frames decoded is not having seen anything", () => {
  const rows = live.map((r) => (r.party === "operator" && r.event === "connected" ? { ...r, detail: { framesDecoded: 0 } } : r));
  const s = judgeCall(rows, OP, NOW);
  assert.deepEqual(s.checks.filter((c) => !c.passed).map((c) => c.check), ["operator_saw_video"]);
  assert.match(s.checks[1]!.evidence, /decoded no video/);
});

test("the operator's word alone, without the phone's, is one end of a call", () => {
  assert.deepEqual(failed(live.filter((r) => !(r.party === "field" && r.event === "connected"))), ["field_confirmed"]);
});

test("a call from an hour ago does not carry an approval now", () => {
  const old = CALL_FRESH_MS / 1000 + 60;
  const rows = [
    row("field", "offered", old + 20),
    row("operator", "answered", old + 18),
    row("operator", "connected", old + 10, { detail: { framesDecoded: 500 } }),
    row("field", "connected", old + 9),
  ];
  const s = judgeCall(rows, OP, NOW);
  assert.deepEqual(s.checks.filter((c) => !c.passed).map((c) => c.check), ["operator_saw_video", "field_confirmed"]);
  assert.match(s.checks[1]!.evidence, /live now/);
});

test("the phone is told of operators already waiting, and each operator that the phone has come", () => {
  const rooms = new CallRooms();
  assert.deepEqual(rooms.operatorJoins("r", OP, "First"), { devicePresent: false });
  assert.deepEqual(rooms.deviceJoins("r").operators, [{ accountId: OP, name: "First" }]);
  assert.deepEqual(rooms.inbox("r", "device", 0).map((s) => [s.kind, s.from]), [["operator-joined", OP]]);
  assert.deepEqual(rooms.inbox("r", OP, 0).map((s) => s.kind), ["device-joined"]);
  // A second operator arriving later is announced to the phone too.
  assert.deepEqual(rooms.operatorJoins("r", OTHER, "Second"), { devicePresent: true });
  assert.deepEqual(rooms.inbox("r", "device", 0).map((s) => s.from), [OP, OTHER]);
});

test("an offer goes only to the operator it names, and only if they are there", () => {
  const rooms = new CallRooms();
  rooms.operatorJoins("r", OP, "First");
  rooms.deviceJoins("r");
  assert.equal(rooms.offer("r", OTHER, "sdp"), false);
  assert.equal(rooms.offer("r", OP, "sdp-for-op"), true);
  assert.equal(rooms.inbox("r", OP, 0).find((s) => s.kind === "offer")?.sdp, "sdp-for-op");
  assert.equal(rooms.inbox("r", OTHER, 0).length, 0);
});

test("an answer needs the phone on the call, and one request's messages stay in that request", () => {
  const rooms = new CallRooms();
  rooms.operatorJoins("r", OP, "First");
  assert.equal(rooms.answer("r", OP, "sdp"), false);
  rooms.deviceJoins("r");
  assert.equal(rooms.answer("r", OP, "answer-sdp"), true);
  assert.equal(rooms.inbox("r", "device", 0).at(-1)?.sdp, "answer-sdp");
  assert.equal(rooms.inbox("another", "device", 0).length, 0);
});

test("the inbox is read from a sequence number on, and leaving tells the other end", () => {
  const rooms = new CallRooms();
  rooms.operatorJoins("r", OP, "First");
  rooms.deviceJoins("r");
  const seen = rooms.inbox("r", "device", 0).at(-1)!.seq;
  assert.equal(rooms.inbox("r", "device", seen).length, 0);
  rooms.leave("r", OP);
  assert.deepEqual(rooms.inbox("r", "device", seen).map((s) => [s.kind, s.from]), [["bye", OP]]);
  assert.equal(rooms.offer("r", OP, "sdp"), false);
});
