import test from "node:test";
import assert from "node:assert/strict";
import { RULES, canonicalPath, matchRule } from "./policy.js";

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
