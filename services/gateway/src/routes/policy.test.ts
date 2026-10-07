import test from "node:test";
import assert from "node:assert/strict";
import { RULES, SCOPED_ROUTES, canonicalPath, matchRule, openToScoped } from "./policy.js";

function rule(method: string, path: string) {
  const canon = canonicalPath(path);
  assert.ok(canon, `${path} should be a canonical path`);
  return matchRule(method, canon.segments);
}

test("the three routes that were open to anyone now need a credential", () => {
  assert.equal(rule("POST", "/keys/issue").rule.access, "control_room");
  assert.equal(rule("POST", "/devices").rule.access, "control_room");
  assert.equal(rule("POST", "/events").rule.access, "event");
});

test("the door, the hand-off and the ceremony take a device's signature, not a session", () => {
  for (const path of [
    "/legs/4d1e/dispatch",
    "/legs/4d1e/receive",
    "/legs/4d1e/confirm",
    "/rooms/9a/entry",
    "/rooms/9a/exit",
    "/ceremonies/77/official",
  ]) {
    const m = rule("POST", path);
    assert.equal(m.rule.access, "device", path);
    assert.equal(m.rule.limit, "field", path);
  }
  assert.equal(rule("POST", "/ceremonies").rule.access, "device");
  assert.equal(rule("POST", "/stations/abc/wrap-key").rule.access, "device");
  const access = rule("POST", "/access/request");
  assert.equal(access.rule.access, "field");
  assert.equal(access.rule.limit, "access", "key guesses have their own, tighter limit");
});

test("on an override's call the phone signs as itself and an operator uses a session", () => {
  for (const path of ["/overrides/7b/call/device/join", "/overrides/7b/call/device/offer", "/overrides/7b/call/device/state"]) {
    assert.equal(rule("POST", path).rule.access, "device", path);
  }
  const inbox = rule("POST", "/overrides/7b/call/device/inbox");
  assert.equal(inbox.rule.access, "device");
  assert.equal(inbox.rule.limit, "read", "a polled inbox must not eat the hand-off limit");
  assert.equal(rule("POST", "/overrides/device-requests").rule.access, "device");
  for (const path of ["/overrides/7b/call/join", "/overrides/7b/call/answer", "/overrides/7b/call/state", "/overrides/7b/decision"]) {
    assert.equal(rule("POST", path).rule.access, "control_room", path);
  }
  assert.equal(rule("GET", "/overrides/7b/call/inbox").rule.access, "account");
});

test("the planned legs are read by a phone's signature or by a signed-in account", () => {
  const legs = rule("GET", "/legs");
  assert.equal(legs.rule.access, "field");
  assert.equal(legs.rule.limit, "read");
  assert.equal(rule("POST", "/legs").rule.access, "control_room");
});

test("platform credential enrolment needs an operator and leg challenges need a signed phone", () => {
  for (const path of ["/webauthn/register/challenge", "/webauthn/register/complete"]) {
    const result = rule("POST", path);
    assert.equal(result.listed, true, path);
    assert.equal(result.rule.access, "control_room", path);
  }
  for (const step of ["dispatch", "receive", "confirm"]) {
    const result = rule("POST", `/legs/4d1e/${step}/webauthn/challenge`);
    assert.equal(result.listed, true, step);
    assert.equal(result.rule.access, "device", step);
  }
});

test("path parameters are captured by name", () => {
  assert.deepEqual(rule("POST", "/stations/abc/wrap-key").params, { deviceId: "abc" });
  assert.deepEqual(rule("POST", "/rosters/c1/morning/lock").params, {
    centreId: "c1",
    session: "morning",
  });
});

test("only liveness, sign-in and the transparency surface are public", () => {
  const open = RULES.filter((r) => r.access === "public").map((r) => `${r.method} ${r.pattern}`);
  assert.deepEqual(open.sort(), [
    "GET /anchors",
    "GET /auth/config",
    "GET /auth/me",
    "GET /counters",
    "GET /health",
    "GET /ping",
    "GET /verify/inclusion/:eventId",
    "POST /auth/signin",
    "POST /auth/signout",
    "POST /auth/signup",
    "POST /public/seam-scan",
  ]);
});

test("a route nobody listed is not open: a read needs an account, a write needs the control room", () => {
  const read = rule("GET", "/something/added/later");
  assert.equal(read.listed, false);
  assert.equal(read.rule.access, "account");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const write = rule(method, "/something/added/later");
    assert.equal(write.listed, false);
    assert.equal(write.rule.access, "control_room", method);
  }
});

test("a listed route under another method falls to the catch-all, not to its own row", () => {
  // DELETE /devices is not a route the ledger has. It must not be let through
  // on the strength of POST /devices being listed.
  const m = rule("DELETE", "/devices");
  assert.equal(m.listed, false);
  assert.equal(m.rule.access, "control_room");
});

test("reads are for signed-in accounts: packages, keys, alerts, the activity ledger", () => {
  for (const path of ["/packages", "/keys", "/alerts", "/activity", "/devices", "/rooms"]) {
    assert.equal(rule("GET", path).rule.access, "account", path);
  }
});

test("demo set-up is matched by prefix and is the control room's", () => {
  assert.equal(rule("POST", "/demo/journey").rule.access, "control_room");
  assert.equal(rule("POST", "/demo/strongroom").rule.access, "control_room");
  assert.equal(rule("POST", "/demo/strongroom").listed, true);
});

test("an escaped path is judged as the route the ledger would serve", () => {
  // The ledger's router decodes %61 to "a". Matching on the raw text would
  // send this to the catch-all (any account) instead of its own rule.
  const canon = canonicalPath("/auth/%61ccounts");
  assert.deepEqual(canon, { segments: ["auth", "accounts"], path: "/auth/accounts" });
  assert.equal(rule("GET", "/auth/%61ccounts").rule.access, "control_room");
  assert.equal(rule("POST", "/keys/%69ssue").rule.limit, "key_issue");
});

test("a trailing slash is the same route", () => {
  assert.equal(canonicalPath("/keys/issue/")?.path, "/keys/issue");
  assert.deepEqual(canonicalPath("/"), { segments: [], path: "/" });
});

test("paths that cannot be reduced to plain segments are refused", () => {
  for (const bad of [
    "keys/issue",
    "/keys//issue",
    "/keys/../devices",
    "/keys/./issue",
    "/keys/%2e%2e/devices",
    "/keys%2Fissue",
    "/keys/%5Cissue",
    "/keys/iss%00ue",
    "/keys/%E0%A4%A",
    "//",
  ]) {
    assert.equal(canonicalPath(bad), null, bad);
  }
});

test("a segment with a space or a plus is forwarded re-encoded, not raw", () => {
  assert.equal(canonicalPath("/rosters/c1/morning%20shift")?.path, "/rosters/c1/morning%20shift");
  assert.deepEqual(canonicalPath("/rosters/c1/a+b")?.segments, ["rosters", "c1", "a+b"]);
});

test("an account limited to centres reaches the filtered reads and nothing that writes", () => {
  const id = "0b9d6c1e-6f0a-4c5e-9a55-1a2b3c4d5e6f";
  for (const [method, path] of [
    ["GET", "/packages"],
    ["GET", `/packages/${id}`],
    ["GET", "/legs"],
    ["GET", "/alerts"],
    ["GET", "/alerts/summary"],
    ["GET", "/exams"],
    ["GET", "/auth/me"],
    ["POST", "/auth/signout"],
  ] as const) {
    assert.equal(openToScoped(method, canonicalPath(path)!.segments), true, `${method} ${path}`);
  }
  for (const [method, path] of [
    ["GET", "/centres"],
    ["GET", "/alerts/stream"],
    ["GET", "/events/stream"],
    ["GET", "/events"],
    ["GET", "/devices"],
    ["GET", "/auth/accounts"],
    ["GET", `/packages/${id}/events`],
    ["GET", `/legs/${id}/attempts`],
    ["POST", "/packages"],
    ["POST", `/alerts/${id}/ack`],
    ["POST", `/packages/${id}/seam-test`],
    ["PUT", `/auth/accounts/${id}/centres`],
    ["POST", "/keys/issue"],
    ["POST", "/demo/route"],
  ] as const) {
    assert.equal(openToScoped(method, canonicalPath(path)!.segments), false, `${method} ${path}`);
  }
});

test("nothing a limited account can reach is a route that changes custody", () => {
  for (const line of SCOPED_ROUTES) {
    const [method, pattern] = line.split(" ");
    if (method === "GET") continue;
    assert.ok(
      pattern === "/auth/signout" || pattern === "/public/seam-scan",
      `${line} writes, and a limited account changes nothing`,
    );
  }
});

test("setting an account's centres is the control room's, counted as account administration", () => {
  const m = matchRule("PUT", ["auth", "accounts", "x", "centres"]);
  assert.equal(m.listed, true);
  assert.equal(m.rule.access, "control_room");
  assert.equal(m.rule.limit, "account_admin");
});
