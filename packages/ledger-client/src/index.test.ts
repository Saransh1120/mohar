import test from "node:test";
import assert from "node:assert/strict";
import { LedgerSignInError, openSession } from "./index.js";

/**
 * The three ways a tool is told who it is, against a stand-in for `fetch`.
 * The same sign-in against the real auth routes and a real database is in
 * tools/e2e/tool-session.mjs.
 */

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function server(answers: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const answer = answers[path] ?? { status: 404, body: { error: "no such route" } };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  return { calls, fetchImpl };
}

const BASE = "http://ledger.example/";

test("with nothing set there is no credential and nothing is asked of the server", async () => {
  const s = server({});
  const session = await openSession(BASE, {}, s.fetchImpl);
  assert.equal(session.via, "none");
  assert.deepEqual(session.headers, {});
  await session.close();
  assert.equal(s.calls.length, 0);
});

test("a session the operator already holds is used as it is and not ended", async () => {
  const s = server({});
  const session = await openSession(BASE, { MOHAR_SESSION_TOKEN: " abc123 " }, s.fetchImpl);
  assert.equal(session.via, "token");
  assert.deepEqual(session.headers, { authorization: "Bearer abc123" });
  await session.close();
  assert.equal(s.calls.length, 0, "it is the operator's session to end, not the tool's");
});

test("with a username and password the tool signs in, and signs out once when closed", async () => {
  const s = server({
    "/auth/signin": { status: 200, body: { token: "t0k", account: { username: "asha", role: "control_room" } } },
    "/auth/signout": { status: 200, body: { ok: true } },
  });
  const session = await openSession(BASE, { MOHAR_OPERATOR: "asha", MOHAR_OPERATOR_PASSWORD: "p@ss word" }, s.fetchImpl);
  assert.equal(session.via, "sign-in");
  assert.equal(session.signedInAs, "asha");
  assert.deepEqual(session.headers, { authorization: "Bearer t0k" });
  assert.equal(s.calls[0]?.url, "http://ledger.example/auth/signin");
  assert.deepEqual(JSON.parse(String(s.calls[0]?.init?.body)), { username: "asha", password: "p@ss word" });

  await session.close();
  await session.close();
  const outs = s.calls.filter((c) => c.url.endsWith("/auth/signout"));
  assert.equal(outs.length, 1);
  assert.deepEqual(outs[0]?.init?.headers, { authorization: "Bearer t0k" });
});

test("a refused sign-in says who and why, and never repeats the password", async () => {
  const s = server({ "/auth/signin": { status: 401, body: { error: "Wrong username or password." } } });
  await assert.rejects(
    openSession(BASE, { MOHAR_OPERATOR: "asha", MOHAR_OPERATOR_PASSWORD: "hunter2-secret" }, s.fetchImpl),
    (err: unknown) => {
      assert.ok(err instanceof LedgerSignInError);
      assert.match(err.message, /asha.*401.*Wrong username or password/);
      assert.ok(!err.message.includes("hunter2-secret"));
      return true;
    },
  );
});

test("one of the pair without the other is an error, not a silent fall back to no credential", async () => {
  const s = server({});
  await assert.rejects(openSession(BASE, { MOHAR_OPERATOR: "asha" }, s.fetchImpl), LedgerSignInError);
  await assert.rejects(openSession(BASE, { MOHAR_OPERATOR_PASSWORD: "x" }, s.fetchImpl), LedgerSignInError);
  assert.equal(s.calls.length, 0);
});

test("a server that cannot be reached is reported as that", async () => {
  const failing = async (): Promise<Response> => {
    throw new Error("connect ECONNREFUSED");
  };
  await assert.rejects(
    openSession(BASE, { MOHAR_OPERATOR: "asha", MOHAR_OPERATOR_PASSWORD: "x" }, failing),
    /Could not reach http:\/\/ledger\.example to sign in/,
  );
});

test("a supplied token takes precedence over a username and password", async () => {
  const s = server({});
  const session = await openSession(
    BASE,
    { MOHAR_SESSION_TOKEN: "held", MOHAR_OPERATOR: "asha", MOHAR_OPERATOR_PASSWORD: "x" },
    s.fetchImpl,
  );
  assert.equal(session.via, "token");
  assert.equal(s.calls.length, 0);
});
