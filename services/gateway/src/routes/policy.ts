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
   * An act done in the field: a request signed by an enrolled device, or a
   * signed-in account (the control room standing in for the device, which is
   * how the Transfers and Ceremony pages work).
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

  // ── the transparency surface: what the public verify portal reads ──
  r("GET", "/anchors", "public", "anon"),
  r("GET", "/verify/inclusion/:eventId", "public", "anon"),

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
  r("POST", "/devices/:id/revoke", "control_room", "write"),
  r("POST", "/fingerprints", "control_room", "write"),
  r("POST", "/fingerprints/:id/revoke", "control_room", "write"),
  r("POST", "/packages/:id/declared-state", "control_room", "write"),
  r("POST", "/packages/:id/seam-seal", "control_room", "write"),
  r("POST", "/packages/:id/seam-test", "account", "write"),

  // ── hand-offs ──
  r("POST", "/legs", "control_room", "write"),
  r("POST", "/legs/:legId/dispatch", "field", "field"),
  r("POST", "/legs/:legId/receive", "field", "field"),
  r("POST", "/legs/:legId/confirm", "field", "field"),
  r("POST", "/legs/:legId/override", "field", "field"),
  r("POST", "/overrides/:id/decision", "control_room", "write"),

  // ── the strong room door ──
  r("POST", "/rooms", "control_room", "write"),
  r("POST", "/rooms/:roomId/entry", "field", "field"),
  r("POST", "/rooms/:roomId/exit", "field", "field"),

  // ── rosters and the opening ceremony ──
  r("PUT", "/rosters/:centreId/:session", "control_room", "write"),
  r("POST", "/rosters/:centreId/:session/lock", "control_room", "write"),
  r("POST", "/stations/:deviceId/wrap-key", "field", "field"),
  r("GET", "/stations/:deviceId/envelopes", "field", "read"),
  r("POST", "/ceremonies", "field", "field"),
  r("POST", "/ceremonies/:id/official", "field", "field"),
  r("POST", "/ceremonies/:id/confirm", "field", "field"),
  r("POST", "/ceremonies/:id/release", "field", "field"),
  r("POST", "/ceremonies/:id/opened", "field", "field"),

  // ── alerts, anchors, demo set-up ──
  r("POST", "/alerts/:id/ack", "account", "write"),
  r("POST", "/anchors/build", "control_room", "write"),
  r("POST", "/demo/*", "control_room", "write"),

  // ── everything not listed above ──
  r("GET", "/*", "account", "read"),
  r("*", "/*", "control_room", "write"),
]);

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
