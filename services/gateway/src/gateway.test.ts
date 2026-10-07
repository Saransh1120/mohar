import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  REQUEST_SIGNATURE_HEADERS as H,
  generateKeypair,
  signBody,
  signedRequestHeaders,
} from "@mohar/crypto-core";
import { buildGateway } from "./app.js";
import { configFromEnv, type GatewayConfig } from "./config.js";

/**
 * ── The gateway, over real HTTP, in front of a stand-in ledger ───────────────
 *
 * The gateway under test is the built one, listening on a real port and called
 * with `fetch`. Behind it is a small HTTP server that answers the two lookups
 * the gateway makes (`/auth/me`, `/devices/:id`) and otherwise echoes what it
 * was sent, so each test can see both what the caller got back and whether the
 * request reached the ledger at all, and with which bytes.
 *
 * Nothing here asserts an outcome the gateway did not produce: every 401, 403
 * and 429 below is the gateway's own answer to a real request.
 */

const SECRET = "test-gateway-secret";
const OPERATOR = "token-of-a-control-room-operator";
const OBSERVER = "token-of-an-observer";
/** A control room operator limited to one centre. */
const LIMITED = "token-of-an-operator-limited-to-one-centre";
const CENTRE = "66666666-6666-4666-8666-666666666666";
/** What the stand-in ledger says each account is limited to; a test may change it. */
const limits = new Map<string, string[]>();
/** When set, what the stand-in ledger says `limited` is, whatever the centre list holds. */
let limitedFlag: boolean | null = null;

const enrolled = generateKeypair();
const revoked = generateKeypair();
const stranger = generateKeypair();
const DEVICE = "11111111-1111-4111-8111-111111111111";
const OTHER_DEVICE = "22222222-2222-4222-8222-222222222222";
const REVOKED_DEVICE = "33333333-3333-4333-8333-333333333333";
const UNKNOWN_DEVICE = "44444444-4444-4444-8444-444444444444";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const seen: Seen[] = [];
const liveTokens = new Set([OPERATOR, OBSERVER, LIMITED]);
let streamsOpen = 0;
let ledger: http.Server;
let ledgerUrl = "";

const reached = (method: string, path: string) =>
  seen.filter((s) => s.method === method && s.url.split("?")[0] === path);

before(async () => {
  ledger = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "/";
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url, headers: req.headers, body });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, {
          "content-type": "application/json",
          // The ledger's own CORS grant. The gateway must not pass it on.
          "access-control-allow-origin": "*",
        });
        res.end(JSON.stringify(value));
      };

      if (url === "/auth/me") {
        const token = (req.headers.authorization ?? "").slice(7);
        if (!liveTokens.has(token)) return json(401, { error: "Not signed in." });
        if (token === LIMITED) {
          return json(200, {
            account: {
              id: "acc-lim",
              username: "lim",
              displayName: "Limited",
              role: "control_room",
              centreIds: limits.get("acc-lim") ?? [CENTRE],
              // Limited to a district that has no centre left is limited all the same.
              limited: limitedFlag ?? (limits.get("acc-lim") ?? [CENTRE]).length > 0,
            },
          });
        }
        return json(200, {
          account:
            token === OPERATOR
              ? { id: "acc-op", username: "op", displayName: "Operator", role: "control_room" }
              : { id: "acc-obs", username: "obs", displayName: "Observer", role: "observer" },
        });
      }
      if (url.startsWith("/devices/") && req.method === "GET") {
        const id = url.slice("/devices/".length);
        if (id === DEVICE) return json(200, { id, kind: "field_app", pubkey: enrolled.publicKeyHex, revokedAt: null });
        if (id === OTHER_DEVICE) return json(200, { id, kind: "field_app", pubkey: stranger.publicKeyHex, revokedAt: null });
        if (id === REVOKED_DEVICE) {
          return json(200, { id, kind: "field_app", pubkey: revoked.publicKeyHex, revokedAt: "2026-09-30T04:00:00.000Z" });
        }
        return json(404, { error: "unknown device" });
      }
      if (url.startsWith("/alerts/stream")) {
        streamsOpen += 1;
        res.writeHead(200, { "content-type": "text/event-stream", "access-control-allow-origin": "*" });
        res.write('event: alerts\ndata: {"total":3}\n\n');
        res.on("close", () => (streamsOpen -= 1));
        return;
      }
      return json(200, { reached: true, method: req.method, url });
    });
  });
  await new Promise<void>((resolve) => ledger.listen(0, "127.0.0.1", resolve));
  ledgerUrl = `http://127.0.0.1:${(ledger.address() as AddressInfo).port}`;
});

after(async () => {
  ledger.closeAllConnections();
  await new Promise((resolve) => ledger.close(resolve));
});

/** A fresh gateway for one test, so one test's refusals do not count against the next. */
async function gateway(
  fn: (base: string, config: GatewayConfig) => Promise<void>,
  change: (c: GatewayConfig) => void = () => {},
): Promise<void> {
  const config = configFromEnv({
    LEDGER_URL: ledgerUrl,
    GATEWAY_SECRET: SECRET,
    CORS_ORIGINS: "http://control.example",
  });
  change(config);
  const app = await buildGateway({ config, logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  seen.length = 0;
  try {
    await fn(base, config);
  } finally {
    await app.close();
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const jsonHeaders = { "content-type": "application/json" };

async function call(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body }) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json, headers: res.headers };
}

function signedEvent(deviceId: string, privateKeyHex: string, over: Record<string, unknown> = {}) {
  const body = {
    v: 1,
    id: "99999999-9999-4999-8999-999999999999",
    kind: "MONITOR_HEARTBEAT",
    examId: "55555555-5555-4555-8555-555555555555",
    occurredAt: "2026-10-02T09:30:00.000Z",
    actorDeviceId: deviceId,
    payload: { monitorId: deviceId, sequence: 7 },
    ...over,
  };
  return { body, deviceSig: signBody(body, privateKeyHex) };
}

// ── the three things item 4 named ───────────────────────────────────────────

test("POST /keys/issue: nobody, the wrong role, and an operator", async () => {
  await gateway(async (base) => {
    const body = JSON.stringify({ packageId: "p", stage: "unlock" });

    const nobody = await call(base, "POST", "/keys/issue", jsonHeaders, body);
    assert.equal(nobody.status, 401);
    assert.equal(nobody.json["reason"], "not_signed_in");

    const observer = await call(base, "POST", "/keys/issue", { ...jsonHeaders, ...bearer(OBSERVER) }, body);
    assert.equal(observer.status, 403);
    assert.equal(observer.json["reason"], "role_not_permitted");
    assert.equal(observer.json["roleHeld"], "observer");
    assert.equal(observer.json["roleNeeded"], "control_room");

    assert.equal(reached("POST", "/keys/issue").length, 0, "neither refusal reached the ledger");

    const operator = await call(base, "POST", "/keys/issue", { ...jsonHeaders, ...bearer(OPERATOR) }, body);
    assert.equal(operator.status, 200);
    const [got] = reached("POST", "/keys/issue");
    assert.equal(got?.body, body, "the body arrives byte for byte");
    assert.equal(got?.headers.authorization, `Bearer ${OPERATOR}`);
    assert.equal(got?.headers["x-mohar-gateway"], SECRET, "the ledger is shown the gateway's secret");
  });
});

test("POST /devices: enrolment is the control room's, and only theirs", async () => {
  await gateway(async (base) => {
    const body = JSON.stringify({ kind: "field_app", pubkeyHex: stranger.publicKeyHex });
    assert.equal((await call(base, "POST", "/devices", jsonHeaders, body)).status, 401);
    assert.equal((await call(base, "POST", "/devices", { ...jsonHeaders, ...bearer(OBSERVER) }, body)).status, 403);
    assert.equal(reached("POST", "/devices").length, 0);
    assert.equal((await call(base, "POST", "/devices", { ...jsonHeaders, ...bearer(OPERATOR) }, body)).status, 200);
    assert.equal(reached("POST", "/devices").length, 1);
  });
});

test("POST /events: the event's own signature is the credential", async () => {
  await gateway(async (base) => {
    const post = (payload: unknown) => call(base, "POST", "/events", jsonHeaders, JSON.stringify(payload));

    const unsigned = await post({ body: { actorDeviceId: DEVICE } });
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.json["reason"], "event_unreadable");

    const unknown = await post(signedEvent(UNKNOWN_DEVICE, stranger.privateKeyHex));
    assert.equal(unknown.status, 401);
    assert.equal(unknown.json["reason"], "device_unknown");

    // Signed, but not by the key enrolled for the device it names.
    const forged = await post(signedEvent(DEVICE, stranger.privateKeyHex));
    assert.equal(forged.status, 401);
    assert.equal(forged.json["reason"], "signature_invalid");

    const fromRevoked = await post(signedEvent(REVOKED_DEVICE, revoked.privateKeyHex));
    assert.equal(fromRevoked.status, 401);
    assert.equal(fromRevoked.json["reason"], "device_revoked");
    assert.equal(fromRevoked.json["revokedAt"], "2026-09-30T04:00:00.000Z");

    // An operator's session does not stand in for a device's signature here.
    const bySession = await call(base, "POST", "/events", { ...jsonHeaders, ...bearer(OPERATOR) }, "{}");
    assert.equal(bySession.status, 401);

    assert.equal(reached("POST", "/events").length, 0, "none of those reached the ledger");

    const good = signedEvent(DEVICE, enrolled.privateKeyHex);
    const sent = JSON.stringify(good);
    const ok = await call(base, "POST", "/events", jsonHeaders, sent);
    assert.equal(ok.status, 200);
    assert.equal(reached("POST", "/events")[0]?.body, sent, "the signed bytes are not re-serialised");
  });
});

test("a batch is let through on its first event that verifies, and refused if none does", async () => {
  await gateway(async (base) => {
    const junk = [signedEvent(DEVICE, stranger.privateKeyHex), { nonsense: true }];
    const refused = await call(base, "POST", "/events/batch", jsonHeaders, JSON.stringify(junk));
    assert.equal(refused.status, 401);
    assert.deepEqual((refused.json["findings"] as string[]).sort(), ["event_unreadable", "signature_invalid"]);

    const mixed = [...junk, signedEvent(DEVICE, enrolled.privateKeyHex)];
    const ok = await call(base, "POST", "/events/batch", jsonHeaders, JSON.stringify(mixed));
    assert.equal(ok.status, 200);
    assert.equal(reached("POST", "/events/batch").length, 1);
  });
});

// ── a device signing a request ──────────────────────────────────────────────

test("a hand-off step signed by an enrolled device is forwarded; once", async () => {
  await gateway(async (base) => {
    const path = "/legs/77777777-7777-4777-8777-777777777777/dispatch";
    const body = JSON.stringify({ deviceId: DEVICE, packetSerialTyped: "PKT-JPR-0091" });
    const headers = {
      ...jsonHeaders,
      ...signedRequestHeaders(DEVICE, enrolled.privateKeyHex, { method: "POST", path, body }),
    };

    const first = await call(base, "POST", path, headers, body);
    assert.equal(first.status, 200);
    assert.equal(reached("POST", path)[0]?.body, body);

    // The same four headers again: a captured request, played back.
    const replay = await call(base, "POST", path, headers, body);
    assert.equal(replay.status, 401);
    assert.equal(replay.json["reason"], "nonce_replayed");
    assert.equal(reached("POST", path).length, 1);
  });
});

test("the ledger is told which device's signature was verified, and a caller cannot say so itself", async () => {
  await gateway(async (base) => {
    const path = "/legs/77777777-7777-4777-8777-777777777777/receive";
    const body = JSON.stringify({ deviceId: DEVICE, packetSerialTyped: "PKT-JPR-0091" });
    const forged = "x-mohar-verified-device";
    const ok = await call(base, "POST", path, {
      ...jsonHeaders,
      // A device naming some other device as verified: dropped, and replaced by
      // the one whose signature actually verified.
      [forged]: "99999999-9999-4999-8999-999999999999",
      ...signedRequestHeaders(DEVICE, enrolled.privateKeyHex, { method: "POST", path, body }),
    }, body);
    assert.equal(ok.status, 200);
    assert.equal(reached("POST", path)[0]?.headers[forged], DEVICE);

    // A session carries no device signature, so nothing is said about one,
    // whatever the caller puts in the header.
    const read = await call(base, "GET", "/packages", { ...bearer(OPERATOR), [forged]: DEVICE });
    assert.equal(read.status, 200);
    assert.equal(reached("GET", "/packages")[0]?.headers[forged], undefined);
  });
});

test("a signed request is refused with what was found, and never reaches the ledger", async () => {
  await gateway(async (base) => {
    const path = "/rooms/88888888-8888-4888-8888-888888888888/entry";
    const body = JSON.stringify({ deviceId: DEVICE, entrants: [] });
    const sign = (deviceId: string, key: string, at = new Date(), signedBody = body) => ({
      ...jsonHeaders,
      ...signedRequestHeaders(deviceId, key, { method: "POST", path, body: signedBody }, at),
    });

    const altered = await call(base, "POST", path, sign(DEVICE, enrolled.privateKeyHex), body.replace("[]", "[1]"));
    assert.equal(altered.json["reason"], "signature_invalid", "the body was changed after signing");

    const otherPath = await call(
      base,
      "POST",
      "/rooms/88888888-8888-4888-8888-888888888888/exit",
      sign(DEVICE, enrolled.privateKeyHex),
      body,
    );
    assert.equal(otherPath.json["reason"], "signature_invalid", "signed for entry, sent to exit");

    const late = await call(base, "POST", path, sign(DEVICE, enrolled.privateKeyHex, new Date(Date.now() - 10 * 60_000)), body);
    assert.equal(late.status, 401);
    assert.equal(late.json["reason"], "clock_skew");
    assert.equal(late.json["skewSeconds"], -600);
    assert.equal(late.json["limitSeconds"], 120);

    const wrongKey = await call(base, "POST", path, sign(DEVICE, stranger.privateKeyHex), body);
    assert.equal(wrongKey.json["reason"], "signature_invalid");

    const notEnrolled = await call(base, "POST", path, sign(UNKNOWN_DEVICE, stranger.privateKeyHex), body);
    assert.equal(notEnrolled.json["reason"], "device_unknown");

    // Revoked and ten minutes stale: both are found, not only the first.
    const both = await call(
      base,
      "POST",
      path,
      sign(REVOKED_DEVICE, revoked.privateKeyHex, new Date(Date.now() - 10 * 60_000)),
      body,
    );
    assert.deepEqual(both.json["findings"], ["clock_skew", "device_revoked"]);

    const partial = sign(DEVICE, enrolled.privateKeyHex) as Record<string, string>;
    delete partial[H.nonce];
    const incomplete = await call(base, "POST", path, partial, body);
    assert.equal(incomplete.json["reason"], "signature_headers_incomplete");
    assert.deepEqual(incomplete.json["missing"], [H.nonce]);

    assert.equal(reached("POST", path).length, 0);
  });
});

test("a device cannot sign a request that names another device", async () => {
  await gateway(async (base) => {
    const path = "/legs/77777777-7777-4777-8777-777777777777/receive";
    const body = JSON.stringify({ deviceId: OTHER_DEVICE });
    const inBody = await call(
      base,
      "POST",
      path,
      { ...jsonHeaders, ...signedRequestHeaders(DEVICE, enrolled.privateKeyHex, { method: "POST", path, body }) },
      body,
    );
    assert.equal(inBody.status, 403);
    assert.equal(inBody.json["reason"], "device_mismatch");
    assert.equal(inBody.json["signedBy"], DEVICE);
    assert.equal(inBody.json["named"], OTHER_DEVICE);

    const stationPath = `/stations/${OTHER_DEVICE}/wrap-key`;
    const inPath = await call(
      base,
      "POST",
      stationPath,
      { ...jsonHeaders, ...signedRequestHeaders(DEVICE, enrolled.privateKeyHex, { method: "POST", path: stationPath, body: "{}" }) },
      "{}",
    );
    assert.equal(inPath.status, 403);
    assert.equal(inPath.json["where"], "path");
    assert.equal(seen.filter((s) => s.method === "POST").length, 0);
  });
});

test("a session does not open a door or hand a packet over: those take the device's signature", async () => {
  await gateway(async (base) => {
    for (const path of [
      "/legs/77777777-7777-4777-8777-777777777777/confirm",
      "/rooms/88888888-8888-4888-8888-888888888888/entry",
      "/ceremonies",
    ]) {
      const body = JSON.stringify({ deviceId: DEVICE });
      const bySession = await call(base, "POST", path, { ...jsonHeaders, ...bearer(OPERATOR) }, body);
      assert.equal(bySession.status, 401, path);
      assert.equal(bySession.json["reason"], "device_signature_required", path);
      assert.equal(reached("POST", path).length, 0, path);

      const signed = await call(
        base,
        "POST",
        path,
        { ...jsonHeaders, ...signedRequestHeaders(DEVICE, enrolled.privateKeyHex, { method: "POST", path, body }) },
        body,
      );
      assert.equal(signed.status, 200, path);
    }
  });
});

test("the access engine's decision route takes a device or a signed-in account", async () => {
  await gateway(async (base) => {
    const body = JSON.stringify({ packageId: "p", stage: "unlock", deviceId: DEVICE });
    assert.equal((await call(base, "POST", "/access/request", jsonHeaders, body)).status, 401);
    assert.equal(
      (await call(base, "POST", "/access/request", { ...jsonHeaders, ...bearer(OBSERVER) }, body)).status,
      200,
    );
    const signed = signedRequestHeaders(DEVICE, enrolled.privateKeyHex, { method: "POST", path: "/access/request", body });
    assert.equal((await call(base, "POST", "/access/request", { ...jsonHeaders, ...signed }, body)).status, 200);
  });
});

// ── rate limits ─────────────────────────────────────────────────────────────

test("POST /access/request is limited per caller, per packet, per stage", async () => {
  await gateway(async (base, config) => {
    const ask = (packageId: string, token = OPERATOR) =>
      call(base, "POST", "/access/request", { ...jsonHeaders, ...bearer(token) },
        JSON.stringify({ packageId, stage: "unlock", deviceId: DEVICE, presentedKey: "MHR-UNLOCK-0000" }));

    for (let i = 0; i < config.limits.access.burst; i++) {
      assert.equal((await ask("packet-a")).status, 200, `guess ${i + 1}`);
    }
    const next = await ask("packet-a");
    assert.equal(next.status, 429);
    assert.equal(next.json["reason"], "rate_limited");
    assert.equal(next.json["limit"], "access");
    assert.equal(next.headers.get("retry-after"), "60");
    assert.equal(reached("POST", "/access/request").length, config.limits.access.burst);

    assert.equal((await ask("packet-b")).status, 200, "another packet is counted apart");
    assert.equal((await ask("packet-a", OBSERVER)).status, 200, "another caller is counted apart");
  });
});

test("sign-in is limited per address and per username before it costs the ledger a scrypt", async () => {
  await gateway(
    async (base) => {
      const signIn = (username: string) =>
        call(base, "POST", "/auth/signin", jsonHeaders, JSON.stringify({ username, password: "x" }));
      for (let i = 0; i < 3; i++) assert.equal((await signIn(`user${i}`)).status, 200);
      const fourth = await signIn("user9");
      assert.equal(fourth.status, 429);
      assert.equal(fourth.json["limit"], "signin");
      assert.equal(reached("POST", "/auth/signin").length, 3);
    },
    (c) => (c.limits.signin = { burst: 3, perMinute: 1 }),
  );
});

test("guessed credentials stop being looked at; a session known to be good keeps working", async () => {
  await gateway(async (base, config) => {
    assert.equal((await call(base, "GET", "/packages", bearer(OPERATOR))).status, 200);

    for (let i = 0; i < config.limits.auth_fail.burst; i++) {
      const r = await call(base, "GET", "/packages", bearer(`guess-${i}`));
      assert.equal(r.status, 401, `guess ${i + 1}`);
    }
    const lookups = reached("GET", "/auth/me").length;
    const stopped = await call(base, "GET", "/packages", bearer("one-more-guess"));
    assert.equal(stopped.status, 429);
    assert.equal(stopped.json["limit"], "auth_fail");
    assert.equal(reached("GET", "/auth/me").length, lookups, "the last guess cost the ledger nothing");

    assert.equal((await call(base, "GET", "/packages", bearer(OPERATOR))).status, 200);
  });
});

test("a dead session polling is counted once, not on every poll", async () => {
  await gateway(async (base, config) => {
    for (let i = 0; i < config.limits.auth_fail.burst * 3; i++) {
      assert.equal((await call(base, "GET", "/summary", bearer("a-session-that-ended"))).status, 401);
    }
    assert.equal(reached("GET", "/auth/me").length, 1);
    // The address still has its allowance: the operator can sign in again and work.
    assert.equal((await call(base, "GET", "/summary", bearer(OPERATOR))).status, 200);
  });
});

// ── the path that is judged is the path that is forwarded ───────────────────

test("an escaped path is held to its own rule and forwarded in plain form", async () => {
  await gateway(async (base) => {
    const sneaky = await call(base, "GET", "/auth/%61ccounts", bearer(OBSERVER));
    assert.equal(sneaky.status, 403, "judged as /auth/accounts, which is the control room's");

    const ok = await call(base, "GET", "/auth/%61ccounts?x=1", bearer(OPERATOR));
    assert.equal(ok.status, 200);
    assert.equal(ok.json["url"], "/auth/accounts?x=1");

    // (`fetch` resolves dot segments itself before sending, so those are
    // covered where the path is handed over directly, in policy.test.ts.)
    for (const bad of ["/keys//issue", "/keys%2Fissue", "/keys/%5Cissue"]) {
      const r = await call(base, "POST", bad, bearer(OPERATOR));
      assert.equal(r.status, 400, bad);
      assert.equal(r.json["reason"], "path_not_canonical", bad);
    }
  });
});

test("a route nobody listed is not open", async () => {
  await gateway(async (base) => {
    assert.equal((await call(base, "GET", "/added/later")).status, 401);
    assert.equal((await call(base, "GET", "/added/later", bearer(OBSERVER))).status, 200);
    assert.equal((await call(base, "DELETE", "/added/later", bearer(OBSERVER))).status, 403);
    assert.equal((await call(base, "DELETE", "/added/later", bearer(OPERATOR))).status, 200);
  });
});

test("public routes need nothing, and a query string arrives as it was sent", async () => {
  await gateway(async (base) => {
    assert.equal((await call(base, "GET", "/ping")).status, 200);
    assert.equal((await call(base, "GET", "/anchors")).status, 200);
    const r = await call(base, "GET", "/packages?examId=a%20b&centreId=c+d", bearer(OBSERVER));
    assert.equal(r.json["url"], "/packages?examId=a%20b&centreId=c+d");
  });
});

// ── sessions ────────────────────────────────────────────────────────────────

test("signing out through the gateway ends the session here at once", async () => {
  const token = "token-that-will-sign-out";
  liveTokens.add(token);
  try {
    await gateway(async (base) => {
      assert.equal((await call(base, "GET", "/packages", bearer(token))).status, 200);
      liveTokens.delete(token);
      // Still inside the cache's fifteen seconds: without the sign-out, this would pass.
      await call(base, "POST", "/auth/signout", bearer(token));
      const after = await call(base, "GET", "/packages", bearer(token));
      assert.equal(after.status, 401);
      assert.equal(after.json["reason"], "session_invalid");
    });
  } finally {
    liveTokens.delete(token);
  }
});

// ── streams ─────────────────────────────────────────────────────────────────

test("a stream opens with a ticket, once, and closes behind a caller who leaves", async () => {
  await gateway(async (base) => {
    assert.equal((await call(base, "GET", "/alerts/stream")).status, 401);
    assert.equal((await call(base, "POST", "/gateway/stream-ticket")).status, 401);

    const issued = await call(base, "POST", "/gateway/stream-ticket", bearer(OBSERVER));
    assert.equal(issued.status, 201);
    const ticket = String(issued.json["ticket"]);

    const res = await fetch(`${base}/alerts/stream?ticket=${encodeURIComponent(ticket)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.match(Buffer.from(first.value!).toString("utf8"), /event: alerts\ndata: \{"total":3\}/);
    assert.equal(reached("GET", "/alerts/stream")[0]?.url, "/alerts/stream", "the ticket is not forwarded");
    assert.equal(streamsOpen, 1);

    const again = await call(base, "GET", `/alerts/stream?ticket=${encodeURIComponent(ticket)}`);
    assert.equal(again.status, 401);
    assert.equal(again.json["reason"], "ticket_invalid");

    await reader.cancel();
    for (let i = 0; i < 50 && streamsOpen > 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(streamsOpen, 0, "the ledger's stream was closed when the caller left");
  });
});

test("a stream is closed after its maximum life, so the session is checked again", async () => {
  await gateway(
    async (base) => {
      const issued = await call(base, "POST", "/gateway/stream-ticket", bearer(OBSERVER));
      const res = await fetch(`${base}/alerts/stream?ticket=${String(issued.json["ticket"])}`);
      const reader = res.body!.getReader();
      let ended = false;
      for (let i = 0; i < 10 && !ended; i++) {
        try {
          ended = (await reader.read()).done;
        } catch {
          ended = true;
        }
      }
      assert.equal(ended, true);
    },
    (c) => (c.streamMaxMs = 150),
  );
});

// ── CORS, the ledger being down, and the record of refusals ─────────────────

test("which origin may read a response is the gateway's decision, not the ledger's", async () => {
  await gateway(async (base) => {
    const allowed = await call(base, "GET", "/ping", { origin: "http://control.example" });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://control.example");
    const other = await call(base, "GET", "/ping", { origin: "http://elsewhere.example" });
    assert.equal(other.headers.get("access-control-allow-origin"), null, "the ledger's * is not passed on");
  });
});

test("a ledger that is down is a 502, not a 401", async () => {
  await gateway(
    async (base) => {
      const open = await call(base, "GET", "/ping");
      assert.equal(open.status, 502);
      assert.equal(open.json["reason"], "upstream_unreachable");
      const signedIn = await call(base, "GET", "/packages", bearer(OPERATOR));
      assert.equal(signedIn.status, 502, "a lookup that failed does not sign the operator out");
    },
    (c) => (c.upstreamUrl = "http://127.0.0.1:9"),
  );
});

test("the status route shows an operator what was refused, with the evidence", async () => {
  await gateway(async (base) => {
    await call(base, "POST", "/keys/issue", jsonHeaders, "{}");
    await call(base, "POST", "/keys/issue", { ...jsonHeaders, ...bearer(OBSERVER) }, "{}");

    assert.equal((await call(base, "GET", "/gateway/status", bearer(OBSERVER))).status, 403);
    const status = await call(base, "GET", "/gateway/status", bearer(OPERATOR));
    assert.equal(status.status, 200);
    const recent = status.json["recentRefusals"] as Record<string, unknown>[];
    // Newest first: the observer's own look at this page, then the two above.
    assert.deepEqual(recent.map((r) => r["reason"]), ["role_not_permitted", "role_not_permitted", "not_signed_in"]);
    assert.equal(recent[1]?.["caller"], "account:obs");
    assert.deepEqual(recent[1]?.["detail"], { roleHeld: "observer", roleNeeded: "control_room" });
    assert.deepEqual(status.json["refusedByReason"], { not_signed_in: 1, role_not_permitted: 2 });
  });
});

// ── an account limited to named centres ─────────────────────────────────────

test("a limited account reads its filtered routes and is refused everything else, role or not", async () => {
  limits.delete("acc-lim");
  await gateway(async (base) => {
    for (const path of ["/packages", `/packages/${CENTRE}`, "/legs", "/alerts"]) {
      const res = await call(base, "GET", path, bearer(LIMITED));
      assert.equal(res.status, 200, path);
      assert.equal(reached("GET", path).length, 1, `${path} reached the ledger`);
    }

    // A control room operator may do every one of these. This one may not.
    const refused: [string, string][] = [
      ["GET", "/centres"],
      ["GET", "/devices"],
      ["GET", "/auth/accounts"],
      ["GET", `/legs/${CENTRE}/attempts`],
      ["POST", "/keys/issue"],
      ["POST", `/alerts/${CENTRE}/ack`],
      ["PUT", "/auth/accounts/acc-op/centres"],
      ["GET", "/alerts/stream"],
    ];
    for (const [method, path] of refused) {
      const res = await call(base, method, path, { ...jsonHeaders, ...bearer(LIMITED) }, method === "GET" ? undefined : "{}");
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.json["reason"], "account_scoped", `${method} ${path}`);
      assert.equal(reached(method, path).length, 0, `${method} ${path} did not reach the ledger`);
    }

    const ticket = await call(base, "POST", "/gateway/stream-ticket", bearer(LIMITED));
    assert.equal(ticket.status, 403);
    assert.equal(ticket.json["reason"], "account_scoped");
    const status = await call(base, "GET", "/gateway/status", bearer(LIMITED));
    assert.equal(status.status, 403);
    assert.equal(status.json["reason"], "account_scoped");

    // The same operator's routes, for an operator with no limit.
    const free = await call(base, "GET", "/devices", bearer(OPERATOR));
    assert.equal(free.status, 200);
  });
});

test("a centre limit changed through the gateway takes hold at once, not when the cache expires", async () => {
  limits.set("acc-lim", []);
  await gateway(async (base) => {
    const before = await call(base, "GET", "/devices", bearer(LIMITED));
    assert.equal(before.status, 200, "no limit yet");

    limits.set("acc-lim", [CENTRE]);
    const set = await call(
      base,
      "PUT",
      "/auth/accounts/acc-lim/centres",
      { ...jsonHeaders, ...bearer(OPERATOR) },
      JSON.stringify({ centreIds: [CENTRE] }),
    );
    assert.equal(set.status, 200);

    const after = await call(base, "GET", "/devices", bearer(LIMITED));
    assert.equal(after.status, 403);
    assert.equal(after.json["reason"], "account_scoped");
  });
  limits.delete("acc-lim");
});

test("an account limited to a district with no centre in it is still limited", async () => {
  limits.set("acc-lim", []);
  limitedFlag = true;
  try {
    await gateway(async (base) => {
      const res = await call(base, "GET", "/devices", bearer(LIMITED));
      assert.equal(res.status, 403);
      assert.equal(res.json["reason"], "account_scoped");
      const own = await call(base, "GET", "/packages", bearer(LIMITED));
      assert.equal(own.status, 200, "its own routes still answer, with whatever the ledger filters to");
    });
  } finally {
    limitedFlag = null;
    limits.delete("acc-lim");
  }
});
