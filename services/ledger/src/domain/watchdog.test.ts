import test from "node:test";
import assert from "node:assert/strict";
import {
  describeOverdueLeg,
  describeUnopenedPacket,
  type OverdueLegFacts,
  type UnopenedPacketFacts,
} from "./watchdog.js";

/**
 * ── The Delayed Transfer Alert, from facts to what it says ───────────────────
 *
 * `describeOverdueLeg` against hand-built facts. The sweep's SQL — which legs
 * count as late and that each is raised once — is exercised against a real
 * database by tools/e2e/transfer.mjs.
 */

const NOW = new Date("2026-09-27T09:00:00.000Z");
const min = (m: number) => new Date(NOW.getTime() - m * 60_000);

function facts(over: Partial<OverdueLegFacts> = {}): OverdueLegFacts {
  return {
    legId: "aaaaaaaa-0000-4000-8000-000000000002",
    legNo: 2,
    packageId: "bbbbbbbb-0000-4000-8000-000000000001",
    centreId: "cccccccc-0000-4000-8000-000000000001",
    centreCode: "JPR-014",
    packetSerial: "PKT-JPR-0091",
    fromRole: "courier",
    toRole: "custodian",
    fromPlace: "Route vehicle",
    toPlace: "District strong room, Jaipur",
    expectedBy: min(12),
    dispatchedAt: null,
    keyReleasedAt: null,
    refusedAttempts: 0,
    lastVerified: null,
    ...over,
  };
}

const courier = {
  personId: "eeeeeeee-0000-4000-8000-000000000001",
  name: "B. Meena",
  role: "courier",
  step: "dispatch" as const,
  legNo: 2,
  at: min(40).toISOString(),
};

test("the evidence states how late, in seconds, and when it was noticed", () => {
  const { evidence } = describeOverdueLeg(facts(), NOW);
  assert.equal(evidence["overdueBySeconds"], 12 * 60);
  assert.equal(evidence["detectedAt"], NOW.toISOString());
  assert.equal(evidence["expectedBy"], min(12).toISOString());
  assert.equal(evidence["legNo"], 2);
});

test("a leg nobody dispatched names the last person verified with the packet", () => {
  const custodianOfLegOne = { ...courier, step: "confirm" as const, legNo: 1 };
  const { evidence, consequence } = describeOverdueLeg(
    facts({ lastVerified: custodianOfLegOne }),
    NOW,
  );
  assert.equal(evidence["stage"], "not_dispatched");
  assert.match(consequence, /Nobody has dispatched this leg/);
  assert.match(consequence, /B\. Meena \(courier\)/);
});

test("a leg with no hand-off at all says so rather than naming anyone", () => {
  const { evidence, consequence } = describeOverdueLeg(
    facts({ legNo: 1, fromRole: "press_operator", fromPlace: "Government Press, Jaipur" }),
    NOW,
  );
  assert.equal(evidence["lastVerified"], undefined);
  assert.match(consequence, /press operator at Government Press, Jaipur/);
  assert.match(consequence, /no hand-off of this packet has been recorded yet/);
});

test("a dispatched leg that nobody accepted is unaccounted for between two places", () => {
  const { evidence, consequence } = describeOverdueLeg(
    facts({ dispatchedAt: min(40), lastVerified: courier }),
    NOW,
  );
  assert.equal(evidence["stage"], "dispatched");
  assert.equal(evidence["dispatchedAt"], min(40).toISOString());
  assert.match(consequence, /B\. Meena \(courier\) dispatched this packet from Route vehicle/);
  assert.match(consequence, /nobody at District strong room, Jaipur has accepted it/);
});

test("a released key that was never submitted keeps the packet on the receiver", () => {
  const receiver = { ...courier, name: "C. Rathore", role: "custodian", step: "receive" as const };
  const { evidence, consequence } = describeOverdueLeg(
    facts({ dispatchedAt: min(40), keyReleasedAt: min(20), lastVerified: receiver }),
    NOW,
  );
  assert.equal(evidence["stage"], "key_released");
  assert.match(consequence, /C\. Rathore \(custodian\) passed every check/);
  assert.match(consequence, /key was never submitted/);
});

test("refused attempts are counted in the consequence", () => {
  const { evidence, consequence } = describeOverdueLeg(
    facts({ dispatchedAt: min(40), lastVerified: courier, refusedAttempts: 2 }),
    NOW,
  );
  assert.equal(evidence["refusedAttempts"], 2);
  assert.match(consequence, /2 attempts were refused on this leg/);
});

test("unknown facts are left out, never written as null", () => {
  const { evidence } = describeOverdueLeg(
    facts({ centreCode: null, packetSerial: null, lastVerified: null }),
    NOW,
  );
  for (const [k, v] of Object.entries(evidence)) {
    assert.notEqual(v, null, `${k} is null`);
  }
  assert.equal("packetSerial" in evidence, false);
  assert.equal("dispatchedAt" in evidence, false);
});

// ── the packet nobody opened ──

function unopened(over: Partial<UnopenedPacketFacts> = {}): UnopenedPacketFacts {
  return {
    packageId: "bbbbbbbb-0000-4000-8000-000000000001",
    centreId: "cccccccc-0000-4000-8000-000000000001",
    centreCode: "JPR-014",
    packetSerial: "PKT-JPR-0091",
    examName: "Class 12 Physics",
    // The exam starts in 9 minutes, so the packet was due to open 6 minutes ago.
    examStartsAt: new Date(NOW.getTime() + 9 * 60_000),
    lastEventKind: null,
    lastEventAt: null,
    lastVerified: null,
    ...over,
  };
}

test("an unopened packet is measured from fifteen minutes before the exam", () => {
  const { evidence } = describeUnopenedPacket(unopened(), NOW);
  assert.equal(evidence["scheduledOpenAt"], min(6).toISOString());
  assert.equal(evidence["overdueBySeconds"], 6 * 60);
  assert.equal(evidence["examStartsAt"], new Date(NOW.getTime() + 9 * 60_000).toISOString());
  assert.equal(evidence["detectedAt"], NOW.toISOString());
});

test("it says whether the exam has started, and does not guess what happened to the packet", () => {
  const before = describeUnopenedPacket(unopened(), NOW).consequence;
  assert.match(before, /The exam has not started yet/);
  assert.match(before, /still sealed or it was opened without the ceremony/);

  const after = describeUnopenedPacket(unopened({ examStartsAt: min(20) }), NOW).consequence;
  assert.match(after, /The exam's start time has passed/);
});

test("an unopened packet names the last person verified with it", () => {
  const custodian = { ...courier, name: "C. Rathore", role: "custodian", step: "confirm" as const };
  const { evidence, consequence } = describeUnopenedPacket(
    unopened({ lastVerified: custodian }),
    NOW,
  );
  assert.deepEqual(evidence["lastVerified"], custodian);
  assert.match(consequence, /C\. Rathore \(custodian\) was the last person verified with it/);
  assert.match(consequence, /centre JPR-014/);
});

test("an unopened packet with no verified hand-off says so", () => {
  const { evidence, consequence } = describeUnopenedPacket(unopened(), NOW);
  assert.equal("lastVerified" in evidence, false);
  assert.match(consequence, /No hand-off of it has been verified/);
});

test("the newest chain event is evidence only when there is one", () => {
  const none = describeUnopenedPacket(unopened(), NOW).evidence;
  assert.equal("lastEventKind" in none, false);

  const some = describeUnopenedPacket(
    unopened({ lastEventKind: "SEAL_APPLIED", lastEventAt: min(600) }),
    NOW,
  ).evidence;
  assert.equal(some["lastEventKind"], "SEAL_APPLIED");
  assert.equal(some["lastEventAt"], min(600).toISOString());
  for (const [k, v] of Object.entries(some)) assert.notEqual(v, null, `${k} is null`);
});

test("the unopened packet alert carries no severity word", () => {
  const { evidence, consequence } = describeUnopenedPacket(unopened({ examStartsAt: min(20) }), NOW);
  const text = `${consequence} ${JSON.stringify(evidence)}`.toLowerCase();
  for (const word of ["critical", "severity", "high priority", "medium", "urgent"]) {
    assert.equal(text.includes(word), false, `mentions "${word}"`);
  }
});

test("the alert carries no severity word", () => {
  for (const f of [
    facts(),
    facts({ dispatchedAt: min(40), lastVerified: courier }),
    facts({ dispatchedAt: min(40), keyReleasedAt: min(20), lastVerified: courier }),
  ]) {
    const { evidence, consequence } = describeOverdueLeg(f, NOW);
    const text = `${consequence} ${JSON.stringify(evidence)}`.toLowerCase();
    for (const word of ["critical", "severity", "high priority", "medium", "urgent"]) {
      assert.equal(text.includes(word), false, `mentions "${word}"`);
    }
  }
});
