import test from "node:test";
import assert from "node:assert/strict";
import { describeDwell, describeFootfall, dwellLimitSeconds, type DwellFacts } from "./strongroom.js";
import { overrideStanding, rateAgainstBaseline, type OverrideDecisionRow } from "./override.js";
import { approvalChannelOf } from "./override-events.js";
import { describeIncomplete, institutionOf, judgeLead, stateFromSteps } from "./opening.js";

/**
 * ── The door, the override and the opening, from facts to rulings ────────────
 *
 * The parts of the three engines that decide or describe without a database.
 * What they do against real tables - every check, every refusal, the time lock
 * opening with the real beacon - is exercised by tools/e2e/doors.mjs and
 * tools/e2e/opening.mjs.
 */

const NOW = new Date("2026-09-27T09:00:00.000Z");
const min = (m: number) => new Date(NOW.getTime() - m * 60_000);
const SEVERITY = ["critical", "severity", "high priority", "medium", "urgent"];

// ── the strong room ──

test("the dwell limit is twice the expected time, and at least five minutes over", () => {
  assert.equal(dwellLimitSeconds(1), 6 * 60);
  assert.equal(dwellLimitSeconds(4), 9 * 60);
  assert.equal(dwellLimitSeconds(5), 10 * 60);
  assert.equal(dwellLimitSeconds(30), 60 * 60);
});

function visit(over: Partial<DwellFacts> = {}): DwellFacts {
  return {
    visitId: "aaaaaaaa-0000-4000-8000-000000000001",
    roomId: "bbbbbbbb-0000-4000-8000-000000000001",
    roomName: "District strong room",
    entrants: [
      { name: "C. Rathore", role: "custodian" },
      { name: "D. Singh", role: "district_officer" },
    ],
    task: "collect one packet",
    enteredAt: min(40),
    expectedMinutes: 4,
    exitedAt: null,
    ...over,
  };
}

test("a visit with no exit is described as still open, not as over", () => {
  const { evidence, consequence } = describeDwell(visit(), NOW);
  assert.equal(evidence["stillInside"], true);
  assert.equal(evidence["dwellSeconds"], 40 * 60);
  assert.equal(evidence["expectedSeconds"], 4 * 60);
  assert.equal("exitedAt" in evidence, false);
  assert.match(consequence, /C\. Rathore \(custodian\) and D\. Singh \(district officer\)/);
  assert.match(consequence, /40 minutes ago, against 4 expected, and no exit is on record/);
});

test("a visit that ended late is measured to its exit, not to now", () => {
  const { evidence, consequence } = describeDwell(visit({ exitedAt: min(10) }), NOW);
  assert.equal(evidence["dwellSeconds"], 30 * 60);
  assert.equal(evidence["stillInside"], false);
  assert.match(consequence, /for 30 minutes for "collect one packet", against 4 expected/);
  assert.match(consequence, /CCTV/);
});

test("a footfall alert states both counts", () => {
  const { evidence, consequence } = describeFootfall({
    visitId: "v",
    roomId: "r",
    roomName: "District strong room",
    monitorDeviceId: "m",
    authorisedEntrants: 2,
    countedAtLeast: 3,
    monitorEvents: 2,
    entrants: [{ name: "C. Rathore", role: "custodian" }],
    enteredAt: min(10),
    exitedAt: NOW,
  });
  assert.equal(evidence["countedAtLeast"], 3);
  assert.equal(evidence["authorisedEntrants"], 2);
  assert.match(consequence, /at least 3 people going into District strong room during a visit that admitted 2/);
});

// ── the override ──

const approve = (accountId: string, over: Partial<OverrideDecisionRow> = {}): OverrideDecisionRow => ({
  accountId,
  decision: "approved",
  videoConfirmed: true,
  officersPresent: true,
  ...over,
});

test("no decisions is pending", () => {
  assert.equal(overrideStanding(true, []).status, "pending");
});

test("one approval approves nothing", () => {
  const s = overrideStanding(true, [approve("a")]);
  assert.equal(s.status, "pending");
  assert.equal(s.approvals, 1);
});

test("two approvals from two operators approve it", () => {
  assert.equal(overrideStanding(true, [approve("a"), approve("b")]).status, "approved");
});

test("the same operator twice is one approval", () => {
  assert.equal(overrideStanding(true, [approve("a"), approve("a")]).status, "pending");
});

test("an approval that does not state the video and both officers does not count", () => {
  const s = overrideStanding(true, [approve("a"), approve("b", { videoConfirmed: false })]);
  assert.equal(s.status, "pending");
  assert.equal(s.approvals, 1);
});

test("one refusal refuses it, whatever else was approved", () => {
  const s = overrideStanding(true, [approve("a"), approve("b"), approve("c", { decision: "refused" })]);
  assert.equal(s.status, "refused");
});

test("a request whose typed seam id is not the packet's cannot be approved into use", () => {
  assert.equal(overrideStanding(false, [approve("a"), approve("b")]).status, "unusable");
});

test("rates are per hundred legs and measured against the baseline", () => {
  const rows = rateAgainstBaseline(
    [
      { key: "a", label: "JPR-001", legs: 10, overrides: 5 },
      { key: "b", label: "JPR-002", legs: 40, overrides: 0 },
      { key: "c", label: "no legs", legs: 0, overrides: 0 },
    ],
    { legs: 50, overrides: 5 },
  );
  assert.deepEqual(rows.map((r) => r.key), ["a", "b"]);
  assert.equal(rows[0]!.per100, 50);
  assert.equal(rows[0]!.timesBaseline, 5);
  assert.equal(rows[1]!.timesBaseline, 0);
});

test("with no overrides anywhere there is no baseline to be a multiple of", () => {
  const rows = rateAgainstBaseline([{ key: "a", label: "x", legs: 4, overrides: 0 }], { legs: 4, overrides: 0 });
  assert.equal(rows[0]!.timesBaseline, null);
});

// ── the opening ──

test("each official answers to a different body", () => {
  const all = (["superintendent", "observer", "police_escort"] as const).map((r) => institutionOf(r, "JPR-014"));
  assert.equal(new Set(all).size, 3);
  assert.match(all[0]!, /JPR-014/);
});

test("a lock a day or more ahead passes with no reason asked for", () => {
  const starts = new Date(NOW.getTime() + 30 * 3600_000);
  const lead = judgeLead(starts, NOW, undefined);
  assert.equal(lead.late, false);
  assert.equal(lead.passed, true);
  assert.equal(lead.leadSeconds, 30 * 3600);
});

test("a lock inside the last day is refused until it says why", () => {
  const starts = new Date(NOW.getTime() + 5 * 3600_000 + 20 * 60_000);
  const silent = judgeLead(starts, NOW, undefined);
  assert.equal(silent.late, true);
  assert.equal(silent.passed, false);
  assert.match(silent.evidence, /5 h 20 min before the exam starts/);
  assert.equal(judgeLead(starts, NOW, "ok").passed, false);

  const explained = judgeLead(starts, NOW, "exam moved forward by the board");
  assert.equal(explained.passed, true);
  assert.equal(explained.late, true);
  assert.match(explained.evidence, /inside the last day, with the reason given: "exam moved forward by the board"/);
});

test("exactly a day ahead is on time", () => {
  assert.equal(judgeLead(new Date(NOW.getTime() + 24 * 3600_000), NOW, undefined).late, false);
});

const step = (s: string, outcome: "passed" | "refused", officials: unknown[] = []) =>
  ({ step: s, outcome, officials }) as Parameters<typeof stateFromSteps>[0][number];
const official = (personId: string) => ({ personId, role: "observer" as const, institution: "Board" });

test("a ceremony has reached nothing until its scan passes", () => {
  assert.equal(stateFromSteps([step("scan", "refused"), step("authorize", "passed")]).reached, null);
});

test("one official identified is not identification reached", () => {
  const s = stateFromSteps([
    step("scan", "passed"),
    step("authorize", "passed"),
    step("identify", "passed", [official("a")]),
  ]);
  assert.equal(s.reached, "authorize");
  assert.equal(s.officials.length, 1);
});

test("refused steps do not advance a ceremony and do not erase what passed", () => {
  const s = stateFromSteps([
    step("scan", "passed"),
    step("authorize", "passed"),
    step("identify", "refused"),
    step("identify", "passed", [official("a")]),
    step("identify", "passed", [official("b")]),
    step("confirm", "refused"),
  ]);
  assert.equal(s.reached, "identify");
  assert.equal(s.officials.length, 2);
});

test("a release recorded without the steps before it has not reached release", () => {
  const s = stateFromSteps([step("scan", "passed"), step("release", "passed")]);
  assert.equal(s.reached, "scan");
});

test("a full ceremony reads back as opened", () => {
  const s = stateFromSteps([
    step("scan", "passed"),
    step("authorize", "passed"),
    step("identify", "passed", [official("a")]),
    step("identify", "passed", [official("b")]),
    step("confirm", "passed"),
    step("release", "passed"),
    step("opened", "passed"),
  ]);
  assert.equal(s.reached, "opened");
});

test("an unfinished ceremony's alert says how far it got and who was identified", () => {
  const { evidence, consequence } = describeIncomplete(
    {
      ceremonyId: "c",
      packageId: "p",
      centreCode: "JPR-014",
      packetSerial: "PKT-JPR-0091",
      scheduledOpenAt: min(3),
      reached: "identify",
      officials: [
        { name: "S. Verma", role: "superintendent" },
        { name: "O. Khan", role: "observer" },
      ],
      refusedSteps: 2,
    },
    NOW,
  );
  assert.equal(evidence["overdueBySeconds"], 180);
  assert.equal(evidence["reached"], "identify");
  assert.match(consequence, /reached "identify" with S\. Verma \(superintendent\) and O\. Khan \(observer\) identified/);
  assert.match(consequence, /2 steps were refused/);
  assert.match(consequence, /control room takes over/);
});

test("none of these alerts carries a severity word", () => {
  const texts = [
    describeDwell(visit(), NOW),
    describeDwell(visit({ exitedAt: min(10) }), NOW),
    describeIncomplete(
      { ceremonyId: "c", packageId: "p", centreCode: null, packetSerial: null, scheduledOpenAt: min(3), reached: null, officials: [], refusedSteps: 0 },
      NOW,
    ),
  ].map((a) => `${a.consequence} ${JSON.stringify(a.evidence)}`.toLowerCase());
  for (const text of texts) {
    for (const word of SEVERITY) assert.equal(text.includes(word), false, `mentions "${word}"`);
  }
});

test("an override is on the chain as live-video only when both approvals had a call on record", () => {
  assert.equal(approvalChannelOf([{ callOnRecord: true }, { callOnRecord: true }]), "live-video");
  assert.equal(approvalChannelOf([{ callOnRecord: true }, { callOnRecord: false }]), "operator-attestation");
  assert.equal(approvalChannelOf([{ callOnRecord: false }, { callOnRecord: false }]), "operator-attestation");
  assert.equal(approvalChannelOf([]), "operator-attestation");
});
