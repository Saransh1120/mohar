/**
 * ── A tool's way through the gateway ─────────────────────────────────────────
 *
 * `tools/seed`, `label-print`, `demo-setup` and `provision-device` talk to the
 * ledger over HTTP. On a developer's machine they reach it directly on
 * loopback, where nothing checks who is asking. A deployment is behind the
 * gateway, and there enrolling a device or issuing a key takes a control room
 * operator's session. These tools had no way to present one.
 *
 * This is that way, and it is the operator's own account, not a credential for
 * tools: whatever a tool does through the gateway is done as a named person
 * and lands in the record under their name.
 *
 * Three cases, decided by the environment:
 *
 *   MOHAR_SESSION_TOKEN                        a session the operator already
 *                                              holds; used as it is and left
 *                                              alone afterwards
 *   MOHAR_OPERATOR + MOHAR_OPERATOR_PASSWORD   the tool signs in, works, and
 *                                              signs out when it is closed
 *   neither                                    no credential: a ledger reached
 *                                              directly, as before
 *
 * The password is read from the environment, sent once to `/auth/signin`, and
 * not kept, logged or returned by anything here.
 */

export interface LedgerSession {
  /** What to add to every request. Empty when no credential is in use. */
  headers: Readonly<Record<string, string>>;
  /** Who the session belongs to, where this tool signed in and was told. */
  signedInAs: string | null;
  /** How the session was obtained. */
  via: "token" | "sign-in" | "none";
  /** Ends a session this tool opened. Leaves a supplied token alone. */
  close(): Promise<void>;
}

export class LedgerSignInError extends Error {}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function openSession(
  base: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<LedgerSession> {
  const root = base.replace(/\/+$/, "");
  const token = env["MOHAR_SESSION_TOKEN"]?.trim();
  const username = env["MOHAR_OPERATOR"]?.trim();
  const password = env["MOHAR_OPERATOR_PASSWORD"];

  if (token) {
    return {
      headers: { authorization: `Bearer ${token}` },
      signedInAs: null,
      via: "token",
      close: async () => {},
    };
  }
  if (!username && !password) {
    return { headers: {}, signedInAs: null, via: "none", close: async () => {} };
  }
  if (!username || !password) {
    throw new LedgerSignInError(
      "Set both MOHAR_OPERATOR and MOHAR_OPERATOR_PASSWORD, or neither. Signing in needs both.",
    );
  }

  let res: Response;
  try {
    res = await fetchImpl(`${root}/auth/signin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch (err) {
    throw new LedgerSignInError(`Could not reach ${root} to sign in: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => null)) as
    | { token?: string; account?: { username?: string; role?: string }; error?: string }
    | null;
  if (!res.ok || !body?.token) {
    // The server's own words, which never include the password.
    throw new LedgerSignInError(`Sign-in as ${username} was refused (${res.status}): ${body?.error ?? "no reason given"}`);
  }

  const headers = { authorization: `Bearer ${body.token}` };
  let closed = false;
  return {
    headers,
    signedInAs: body.account?.username ?? username,
    via: "sign-in",
    close: async () => {
      if (closed) return;
      closed = true;
      // A session left open is good for twelve hours. Ending it is worth one
      // request; failing to is not worth failing the tool over.
      await fetchImpl(`${root}/auth/signout`, { method: "POST", headers }).catch(() => undefined);
    },
  };
}
