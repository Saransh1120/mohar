import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { iceConfig, turnCredential } from "./turn.js";

/**
 * ── Relay credentials ────────────────────────────────────────────────────────
 *
 * The form is coturn's `use-auth-secret`. No relay was available to try these
 * against; what is checked here is the form, the expiry, and that a setting
 * that cannot be used is left out and reported.
 */

const NOW = new Date("2026-10-03T06:00:00.000Z");
const SECRET = "a-shared-secret-of-enough-length";

test("the username is the expiry time and who it was issued to; the credential is the HMAC of it", () => {
  const c = turnCredential(SECRET, "9b0e-account", NOW, 3600);
  const expires = Math.floor(NOW.getTime() / 1000) + 3600;
  assert.equal(c.username, `${expires}:9b0e-account`);
  assert.equal(c.credential, createHmac("sha1", SECRET).update(c.username).digest("base64"));
  assert.equal(c.expiresAt.toISOString(), "2026-10-03T07:00:00.000Z");
});

test("a colon in who it was issued to cannot move the expiry", () => {
  const c = turnCredential(SECRET, "9999999999:forged", NOW, 60);
  assert.equal(c.username.split(":").length, 2);
  assert.equal(c.username.split(":")[0], String(Math.floor(NOW.getTime() / 1000) + 60));
});

test("two parties get different credentials, and neither is the secret", () => {
  const a = turnCredential(SECRET, "operator", NOW);
  const b = turnCredential(SECRET, "phone", NOW);
  assert.notEqual(a.credential, b.credential);
  assert.ok(!a.credential.includes(SECRET) && !a.username.includes(SECRET));
});

test("with nothing configured the call is offered the STUN server and no relay", () => {
  const c = iceConfig({});
  assert.equal(c.relay, false);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.serversFor("x"), [{ urls: "stun:stun.l.google.com:19302" }]);
});

test("with a relay configured each end is handed its own short-lived credential for it", () => {
  const c = iceConfig({ TURN_URLS: "turn:relay.example.org:3478, turns:relay.example.org:5349", TURN_SECRET: SECRET });
  assert.equal(c.relay, true);
  const servers = c.serversFor("phone-1", NOW);
  assert.equal(servers.length, 2);
  const relay = servers[1]!;
  assert.deepEqual(relay.urls, ["turn:relay.example.org:3478", "turns:relay.example.org:5349"]);
  assert.equal(relay.credential, turnCredential(SECRET, "phone-1", NOW).credential);
  assert.notEqual(c.serversFor("operator-1", NOW)[1]!.username, relay.username);
});

test("a relay address without its secret is not offered, and the reason is reported", () => {
  const c = iceConfig({ TURN_URLS: "turn:relay.example.org:3478" });
  assert.equal(c.relay, false);
  assert.equal(c.serversFor("x").length, 1);
  assert.match(c.problems.join(" "), /without TURN_SECRET/);
});

test("an address that is not a relay address is left out and named", () => {
  const c = iceConfig({ TURN_URLS: "https://relay.example.org, turn:relay.example.org:3478", TURN_SECRET: SECRET });
  assert.equal(c.relay, true);
  assert.deepEqual(c.serversFor("x", NOW)[1]!.urls, ["turn:relay.example.org:3478"]);
  assert.match(c.problems.join(" "), /https:\/\/relay\.example\.org/);
});

test("a STUN setting that is not JSON falls back to the default and says so", () => {
  const c = iceConfig({ CALL_ICE_SERVERS: "stun:somewhere" });
  assert.deepEqual(c.serversFor("x"), [{ urls: "stun:stun.l.google.com:19302" }]);
  assert.match(c.problems.join(" "), /not valid JSON/);
});

test("an out-of-range lifetime falls back to an hour", () => {
  const c = iceConfig({ TURN_URLS: "turn:r:3478", TURN_SECRET: SECRET, TURN_TTL_S: "5" });
  const username = c.serversFor("x", NOW)[1]!.username!;
  assert.equal(username.split(":")[0], String(Math.floor(NOW.getTime() / 1000) + 3600));
  assert.match(c.problems.join(" "), /TURN_TTL_S/);
});
