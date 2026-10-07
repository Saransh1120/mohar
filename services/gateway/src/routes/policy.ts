/**
 * ── Who may call what ────────────────────────────────────────────────────────
 *
 * One table, read top to bottom, first match wins. Every route the ledger
 * serves is listed with the credential it needs and the limit it is counted
 * against. The table is the whole policy: there is no second place where a
 * route is opened up.
 *
 * A route that is not listed is not open. It falls to the last two rows: a read
 * needs a signed-in account and anything else needs a control room operator.
 * So a route added to the ledger and forgotten here is over-restricted until
 * somebody lists it, never under-restricted.
 *
 * What the gateway decides is who is asking. Whether the act is allowed —
 * whether this courier may dispatch this leg, whether this key opens this
 * packet — stays with the engine behind it, which records the attempt either
 * way. A request refused here never reached an engine and is in the gateway's
 * own record instead (`GET /gateway/status`).
 */

/** The credential a route needs. */
export type Access =
  /** None. */
  | "public"
  /** A signed-in account, any role. */
  | "account"
  /** A signed-in account whose role is control_room. */
  | "control_room"
  /**
   * An act a device does: a request signed by an enrolled device, with that
   * device's key. A session does not stand in for it. The engine behind the
   * route is handed a `deviceId`, and this is what makes that id the device
   * that sent the request rather than a number somebody typed.
   */
  | "device"
  /**
   * A request signed by an enrolled device, or a signed-in account. Only the
   * access engine's decision route is left here: the Unlock page asks it on
   * behalf of an ESP32 station whose key the browser does not hold.
   */
  | "field"
  /** The body is an event signed by an enrolled device. */
  | "event"
  /** A signed-in account, by bearer token or by a one-use stream ticket. */
  | "stream";

export type LimitName =
  | "ip"
  | "auth_fail"
  | "anon"
  | "signin"
  | "signup"
  | "read"
  | "write"
  | "field"
  | "access"
  | "key_issue"
  | "enrol"
  | "account_admin"
  | "events"
  | "stream";

export interface Rule {
  method: "GET" | "POST" | "PUT" | "*";
  /** Segments; `:name` matches one, a final `*` matches whatever is left. */
  pattern: string;
  access: Access;
  limit: LimitName;
}

const r = (method: Rule["method"], pattern: string, access: Access, limit: LimitName): Rule => ({
  method,
  pattern,
  access,
  limit,
});

export const RULES: readonly Rule[] = Object.freeze([
  // ── liveness and sign-in ──
  r("GET", "/ping", "public", "anon"),
  r("GET", "/health", "public", "anon"),
  r("GET", "/auth/config", "public", "anon"),
  r("POST", "/auth/signin", "public", "signin"),
  // Whether sign-up is open is the ledger's decision (ALLOW_SIGNUP, or no
  // account existing yet); the gateway only bounds how often it can be tried.
  r("POST", "/auth/signup", "public", "signup"),
  r("POST", "/auth/signout", "public", "anon"),
  r("GET", "/auth/me", "public", "anon"),
  r("GET", "/auth/accounts", "control_room", "read"),
  r("POST", "/auth/accounts", "control_room", "account_admin"),
  r("POST", "/auth/accounts/:id/disable", "control_room", "account_admin"),
  r("PUT", "/auth/accounts/:id/centres", "control_room", "account_admin"),

  // ── the transparency surface: what the public verify portal reads ──
  r("GET", "/anchors", "public", "anon"),
  r("GET", "/counters", "public", "anon"),
  r("GET", "/verify/inclusion/:eventId", "public", "anon"),
  r("POST", "/public/seam-scan", "public", "anon"),

  // ── the chain ──
  // A signed event authenticates itself: the signature is the credential.
  r("POST", "/events", "event", "events"),
  r("POST", "/events/batch", "event", "events"),
  r("POST", "/packages/:id/seal", "event", "events"),
  r("GET", "/events/stream", "stream", "stream"),
  r("GET", "/alerts/stream", "stream", "stream"),

  // ── the access engine and its keys ──
  r("POST", "/access/request", "field", "access"),
  r("POST", "/keys/issue", "control_room", "key_issue"),
  r("POST", "/keys/rotate", "control_room", "key_issue"),
  r("POST", "/keys/:id/revoke", "control_room", "write"),

  // ── the registers ──
  r("POST", "/devices", "control_room", "enrol"),
  r("POST", "/webauthn/register/challenge", "control_room", "enrol"),
  r("POST", "/webauthn/register/complete", "control_room", "enrol"),
  r("POST", "/devices/:id/revoke", "control_room", "write"),
  r("POST", "/centres/district", "control_room", "write"),
  r("POST", "/fingerprints", "control_room", "write"),
  r("POST", "/fingerprints/:id/revoke", "control_room", "write"),
  r("POST", "/packages/:id/declared-state", "control_room", "write"),
  r("POST", "/packages/:id/seam-seal", "control_room", "write"),
  r("POST", "/packages/:id/seam-test", "account", "write"),

  // ── hand-offs ──
  r("POST", "/legs", "control_room", "write"),
  // Read by the phone, signed as itself, and by the control room's Transfers
  // page, with a session. Reading the plan is not an act a device does.
  r("GET", "/legs", "field", "read"),
  r("POST", "/legs/:legId/dispatch", "device", "field"),
  r("POST", "/legs/:legId/receive", "device", "field"),
  r("POST", "/legs/:legId/confirm", "device", "field"),
  r("POST", "/legs/:legId/dispatch/webauthn/challenge", "device", "field"),
  r("POST", "/legs/:legId/receive/webauthn/challenge", "device", "field"),
  r("POST", "/legs/:legId/confirm/webauthn/challenge", "device", "field"),
  r("POST", "/legs/:legId/override", "device", "field"),
  r("POST", "/overrides/:id/decision", "control_room", "write"),
  // The override's video call. The phone's side is the phone's own signature;
  // its inbox is polled, so it is counted as a read and not against the limit
  // that hand-off attempts share.
  r("POST", "/overrides/device-requests", "device", "read"),
  r("POST", "/overrides/:id/call/device/join", "device", "field"),
  r("POST", "/overrides/:id/call/device/inbox", "device", "read"),
  r("POST", "/overrides/:id/call/device/offer", "device", "field"),
  r("POST", "/overrides/:id/call/device/state", "device", "field"),
  r("POST", "/overrides/:id/call/join", "control_room", "write"),
  r("POST", "/overrides/:id/call/answer", "control_room", "write"),
  r("POST", "/overrides/:id/call/state", "control_room", "write"),

  // ── the strong room door ──
  r("POST", "/rooms", "control_room", "write"),
  r("POST", "/rooms/:roomId/entry", "device", "field"),
  r("POST", "/rooms/:roomId/exit", "device", "field"),

  // ── rosters and the opening ceremony ──
  r("PUT", "/rosters/:centreId/:session", "control_room", "write"),
  r("POST", "/rosters/:centreId/:session/lock", "control_room", "write"),
  r("POST", "/rosters/:centreId/:session/reissue", "control_room", "write"),
  r("POST", "/stations/:deviceId/wrap-key", "device", "field"),
  r("GET", "/stations/:deviceId/envelopes", "device", "read"),
  r("POST", "/stations/:deviceId/cache", "device", "field"),
  r("POST", "/ceremonies/offline", "device", "field"),
  r("POST", "/ceremonies", "device", "field"),
  r("POST", "/ceremonies/:id/official", "device", "field"),
  r("POST", "/ceremonies/:id/confirm", "device", "field"),
  r("POST", "/ceremonies/:id/release", "device", "field"),
  r("POST", "/ceremonies/:id/opened", "device", "field"),

  // ── alerts, anchors, demo set-up ──
  r("POST", "/alerts/:id/ack", "account", "write"),
  r("POST", "/anchors/build", "control_room", "write"),
  r("POST", "/demo/*", "control_room", "write"),

  // ── everything not listed above ──
  r("GET", "/*", "account", "read"),
  r("*", "/*", "control_room", "write"),
]);

/**
 * ── What an account limited to named centres may reach ───────────────────────
 *
 * An account with a centre limit reads its centres' packets, hand-offs and
 * alerts, and nothing else. This list is the whole of what it can reach with
 * its session; everything not on it is refused, whatever the table above says
 * about its role. The ledger keeps the same list (`http/scope-guard`) and does
 * the filtering by centre. `tools/e2e/scope.mjs` compares the two, so one
 * cannot grow without the other.
 *
 * The streams are not on it. They carry every centre's events, and the ledger
 * cannot filter them per account: a stream opened with a ticket reaches it
 * with no account at all.
 */
export const SCOPED_ROUTES: readonly string[] = Object.freeze([
  "GET /packages",
  "GET /packages/:id",
  "GET /legs",
  "GET /alerts",
  "GET /alerts/summary",
  "GET /exams",
  "GET /auth/me",
  "GET /auth/config",
  "POST /auth/signout",
  "GET /health",
  "GET /ping",
  "GET /anchors",
  "GET /counters",
  "GET /verify/inclusion/:eventId",
  "POST /public/seam-scan",
]);

const SCOPED: { method: string; parts: string[] }[] = SCOPED_ROUTES.map((line) => {
  const [method = "", pattern = ""] = line.split(" ");
  return { method, parts: pattern.split("/").slice(1) };
});

/** Whether an account limited to named centres may make this request at all. */
export function openToScoped(method: string, segments: readonly string[]): boolean {
  const m = method.toUpperCase();
  return SCOPED.some(
    (s) =>
      s.method === m &&
      s.parts.length === segments.length &&
      s.parts.every((want, i) => want.startsWith(":") || want === segments[i]),
  );
}

/** How many of the rows above are the catch-alls at the end. */
const FALLBACK_ROWS = 2;

export interface CanonicalPath {
  segments: string[];
  /** The path the gateway judged, re-encoded. This is what is forwarded. */
  path: string;
}

/**
 * Reduce a request path to the one form the table is matched against.
 *
 * The ledger's router decodes percent-escapes before it routes, so
 * `/auth/%61ccounts` and `/auth/accounts` are the same route to it. If the
 * gateway matched on the raw text they would be two different rows here, and
 * the escaped one would be judged by the catch-all instead of its own rule.
 * So the path is decoded, checked, and re-encoded, and the gateway forwards
 * the form it judged. Anything that cannot be reduced to plain segments —
 * an empty segment, a dot segment, an encoded slash, a control character,
 * a broken escape — is refused rather than guessed at.
 */
export function canonicalPath(raw: string): CanonicalPath | null {
  if (!raw.startsWith("/")) return null;
  if (raw === "/") return { segments: [], path: "/" };
  const parts = raw.split("/").slice(1);
  if (parts[parts.length - 1] === "") parts.pop();

  const segments: string[] = [];
  for (const part of parts) {
    if (part === "") return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === ".." || /[/\\\u0000-\u001f\u007f]/.test(decoded)) return null;
    segments.push(decoded);
  }
  return { segments, path: "/" + segments.map(encodeURIComponent).join("/") };
}

interface Compiled {
  rule: Rule;
  parts: string[];
  rest: boolean;
}

const COMPILED: Compiled[] = RULES.map((rule) => {
  const parts = rule.pattern.split("/").slice(1);
  const rest = parts[parts.length - 1] === "*";
  return { rule, parts: rest ? parts.slice(0, -1) : parts, rest };
});

export interface Match {
  rule: Rule;
  params: Record<string, string>;
  /** False when only a catch-all row matched: the route has no rule of its own. */
  listed: boolean;
}

/** The first row that matches. There is always one: the last row matches everything. */
export function matchRule(method: string, segments: readonly string[]): Match {
  const m = method.toUpperCase();
  for (let i = 0; i < COMPILED.length; i++) {
    const c = COMPILED[i]!;
    if (c.rule.method !== "*" && c.rule.method !== m) continue;
    if (c.rest ? segments.length < c.parts.length : segments.length !== c.parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let j = 0; j < c.parts.length; j++) {
      const want = c.parts[j]!;
      const got = segments[j]!;
      if (want.startsWith(":")) params[want.slice(1)] = got;
      else if (want !== got) {
        ok = false;
        break;
      }
    }
    if (ok) return { rule: c.rule, params, listed: i < COMPILED.length - FALLBACK_ROWS };
  }
  // Unreachable while the last row is `* /*`; kept so the type has no hole.
  return { rule: RULES[RULES.length - 1]!, params: {}, listed: false };
}
