/**
 * Typed client for the ledger API.
 *
 * Everything goes through `/api`, which Vite proxies to the ledger service. The
 * UI never talks to Postgres and never constructs a signed event — writes into
 * the chain come from attested devices only, and an operator's browser is not
 * one. What the control room can do is read, and record intent against
 * reference data.
 */

const BASE = "/api";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The session token, held where a reload can find it again.
 *
 * It is a bearer token: whoever holds it is the session. Twelve hours, revoked
 * server-side on sign-out, and never written anywhere the server can read back —
 * the ledger stores only its SHA-256.
 */
const TOKEN_KEY = "mohar.session";

export function storedToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private-mode browsers: the session simply does not survive a reload */
  }
}

function authHeaders(): Record<string, string> {
  const token = storedToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { headers: authHeaders() });
  if (!res.ok) throw new ApiError(res.status, `GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? `POST ${path} → ${res.status}`);
  return json;
}

// ── shapes returned by the service ──────────────────────────────────────────

export type PackageState =
  | "sealed"
  | "in_transit"
  | "at_custodian"
  | "at_centre"
  | "opened"
  | "returned"
  | "compromised";

export interface Health {
  ok: boolean;
  chainTip: { seq: string; hash: string } | null;
}

/** Counters. Every one of these is a count of something that happened. */
export interface Summary {
  packagesByState: Partial<Record<PackageState, number>>;
  access: { granted?: number; denied?: number };
  keys: { active: number; revoked: number; total: number };
  keyDenials: number;
  actsRequiringDecision: number;
  totals: {
    events: number;
    attempts: number;
    active_devices: number;
    centres: number;
    anchors: number;
  };
}

export type KeyStatus =
  | "verified"
  | "expired"
  | "unknown"
  | "revoked"
  | "not_presented"
  | "n/a";

/**
 * One recorded act. Carries the facts rather than a severity label — the
 * operator draws the conclusion, the system supplies the evidence.
 */
export interface ActivityEntry {
  ref: string;
  source: "event" | "access_attempt";
  at: string;
  recordedAt: string;
  act: string;
  facts: string[];
  kind: string;
  stage: string | null;
  examName: string | null;
  centreCode: string | null;
  packageId: string | null;
  actorRole: string | null;
  actorPerson: string | null;
  actorDeviceId: string | null;
  deviceKind: string | null;
  key: {
    presented: boolean;
    fingerprint: string | null;
    status: KeyStatus;
    epochPresented: number | null;
    epochCurrent: number | null;
    detail: string;
  };
  outcome: "granted" | "denied" | "recorded";
  denyReasons: string[];
  checksPassed: string[];
  position: {
    lat: number;
    lon: number;
    accuracyM: number | null;
    distanceM: number | null;
  } | null;
  clockSkewMs: number | null;
  sealSerialRead: string | null;
  requiresDecision: boolean;
  consequence: string | null;
  eventHash: string | null;
  payload: unknown;
}

export interface RosterEntry {
  personId: string;
  displayName: string;
  role: string;
  examId: string;
  validFrom: string;
  validTo: string;
}

export interface EpochStatus {
  epoch: number;
  startsAt: string;
  endsAt: string;
  secondsRemaining: number;
  percentElapsed: number;
}

export interface CustodyStage {
  stage: string;
  ordinal: number;
  description: string;
  expectedRole: string;
}

export interface AccessKey {
  id: string;
  packageId: string;
  stage: string;
  epoch: number;
  fingerprint: string;
  issuedToRole: string;
  issuedToPerson: string | null;
  validFrom: string;
  validTo: string;
  revokedAt: string | null;
  revokedReason: string | null;
  /** Present only on the response that issues it. */
  key?: string;
}

export interface CheckResult {
  check: string;
  passed: boolean;
  evidence: string;
  reason?: string;
}

export interface AccessDecisionResult {
  outcome: "granted" | "denied";
  sessionId: string;
  attemptSeq: string;
  /** The recorded attempt. A refusal photograph is bound to this. */
  attemptId: string;
  denyReasons: string[];
  checksPassed: string[];
  checks: CheckResult[];
  context: Record<string, unknown>;
}

export interface PackageSummary {
  id: string;
  examId: string;
  examName: string;
  centreId: string;
  centreCode: string;
  copies: number;
  sealSerial: string | null;
  declaredState: PackageState;
  observedState: PackageState;
  divergent: boolean;
  riskScore: number;
  anomalyCount: number;
  eventCount: number;
  lastEventAt: string | null;
  custodyFrom: string | null;
  custodyTo: string | null;
}

export type CustodyAnomaly =
  | { code: "illegal_transition"; seq: string; from: string; to: string }
  | { code: "handoff_holder_mismatch"; seq: string; expectedHolder: string; claimedFrom: string }
  | { code: "seal_serial_changed"; seq: string; registered: string; read: string }
  | { code: "custody_gap"; fromSeq: string; toSeq: string; gapMinutes: number }
  | { code: "printed_without_grant"; seq: string }
  | { code: "opened_before_window"; seq: string; windowOpensAt: string }
  | { code: "key_not_destroyed"; lastPrintSeq: string };

export interface CustodyHop {
  seq: string;
  at: string;
  kind: string;
  fromPersonId?: string;
  toPersonId?: string;
  fromRole?: string;
  toRole?: string;
  state: PackageState;
}

export interface PackageDetail extends PackageSummary {
  projection: {
    state: PackageState;
    holderPersonId?: string;
    holderRole?: string;
    sealSerial?: string;
    hops: CustodyHop[];
    anomalies: CustodyAnomaly[];
    accessGranted: boolean;
    printed: boolean;
    keyDestroyed: boolean;
    lastEventAt?: string;
  };
  timeline: TimelineEvent[];
}

/** One event, with everything the ledger holds about it. */
export interface TimelineEvent {
  seq: string;
  id: string;
  kind: string;
  occurredAt: string;
  receivedAt: string;
  clockSkewMs: number;
  actorPersonId: string | null;
  actorName: string | null;
  actorRole: string | null;
  actorDeviceId: string;
  deviceKind: string | null;
  cosignDeviceId: string | null;
  lat: number | null;
  lon: number | null;
  geoAccuracyM: number | null;
  payload: unknown;
  bodyHash: string;
  prevHash: string;
  hash: string;
}

export interface Device {
  id: string;
  kind: string;
  pubkey: string;
  centreId: string | null;
  enrolledAt: string;
  revokedAt: string | null;
}

export interface Exam {
  id: string;
  name: string;
  mode: string;
  authority: string;
  startsAt: string;
  drandRound: number;
  sidesPerCopy: number;
  suspended: boolean;
  centreCount: number;
  packageCount: number;
}

export interface Centre {
  id: string;
  examId: string;
  code: string;
  lat: number;
  lon: number;
  geofenceM: number;
  capacity: number;
  printers: number;
  hasGenset: boolean;
  accredited: boolean;
}

export interface Person {
  id: string;
  displayName: string;
  role: string;
}

export interface ChainVerification {
  checked: number;
  fromSeq?: string;
  toSeq?: string;
  intact: boolean;
  breaks: { seq: string; reason: string; expected: string; actual: string }[];
}

export interface Anchor {
  day: string;
  merkle_root: string;
  first_seq: string;
  last_seq: string;
  tree_size: number;
  notarised: boolean;
  published_at: string;
}

/**
 * A row straight out of `led.event`, unprojected.
 *
 * The activity feed is the right surface for an operator, but the witness page
 * needs the raw signed body — it has to read `payload.sessionId` and
 * `payload.templateSlot` to decide which assertion a photograph belongs to, and
 * a human-readable projection cannot answer that.
 */
export interface RawEvent {
  seq: string;
  id: string;
  kind: string;
  body: {
    v: number;
    id: string;
    kind: string;
    examId: string;
    centreId?: string;
    packageId?: string;
    occurredAt: string;
    actorDeviceId: string;
    payload: Record<string, unknown>;
  };
  occurred_at: string;
  received_at: string;
  clock_skew_ms: string;
  hash: string;
}

export interface AccessAttempt {
  seq: string;
  id: string;
  packageId: string;
  centreCode: string | null;
  stage: string;
  outcome: "granted" | "denied";
  denyReasons: string[];
  checksPassed: string[];
  actorDeviceId: string;
  actorPersonName: string | null;
  sealSerialRead: string | null;
  sessionId: string | null;
  /** The decision event this attempt produced. A photograph of a refusal is
   *  bound to this, since a refused attempt has no biometric assertion to
   *  hang off. */
  eventId: string | null;
  /** When the device says it asked. */
  attemptedAt: string;
  /** When the engine answered. Both are kept; neither is corrected. */
  decidedAt: string;
}

/**
 * Who a template slot belongs to.
 *
 * Reference data, not chain data. The chain says "slot 3 matched"; this says who
 * slot 3 is, and unlike a signed fact it can be corrected when it is wrong.
 * Retired mappings are kept and returned, because an assertion signed last month
 * refers to whoever held the slot then.
 */
export interface FingerprintEnrolment {
  id: string;
  deviceId: string;
  templateSlot: number;
  personId: string;
  personName: string;
  personRole: string;
  role: "superintendent" | "observer";
  fingerLabel: string | null;
  enrolledAt: string;
  enrolledNote: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

// ── endpoints ───────────────────────────────────────────────────────────────

// ── accounts ────────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  username: string;
  displayName: string;
  role: string;
  personId: string | null;
  createdAt: string;
  lastSignIn: string | null;
}

export interface Session {
  token: string;
  expiresAt: string;
  account: Account;
}

export interface AuthConfig {
  signUpOpen: boolean;
  accounts: number;
  roles: string[];
  sessionHours: number;
}

export const api = {
  authConfig: () => get<AuthConfig>("/auth/config"),

  signIn: async (username: string, password: string) => {
    const s = await post<Session>("/auth/signin", { username, password });
    storeToken(s.token);
    return s;
  },

  signUp: async (input: {
    username: string;
    password: string;
    displayName: string;
    role?: string;
  }) => {
    const s = await post<Session>("/auth/signup", input);
    storeToken(s.token);
    return s;
  },

  signOut: async () => {
    try {
      await post<{ ok: boolean }>("/auth/signout");
    } finally {
      storeToken(null);
    }
  },

  /** Resolve the stored token. Null means "not signed in" — not an error. */
  me: async (): Promise<Account | null> => {
    if (!storedToken()) return null;
    try {
      const r = await get<{ account: Account }>("/auth/me");
      return r.account;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        storeToken(null);
        return null;
      }
      throw e;
    }
  },

  health: () => get<Health>("/health"),
  summary: (examId?: string) =>
    get<Summary>(`/summary${examId ? `?examId=${examId}` : ""}`),
  activity: (
    opts: {
      examId?: string;
      packageId?: string;
      limit?: number;
      onlyDecisions?: boolean;
      onlyDenied?: boolean;
      requiresDecision?: boolean;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.examId) q.set("examId", opts.examId);
    if (opts.packageId) q.set("packageId", opts.packageId);
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.onlyDecisions) q.set("onlyDecisions", "true");
    if (opts.onlyDenied) q.set("onlyDenied", "true");
    if (opts.requiresDecision) q.set("requiresDecision", "true");
    return get<{ activity: ActivityEntry[] }>(`/activity?${q}`);
  },

  epoch: () => get<EpochStatus>("/access/epoch"),
  stages: () => get<{ stages: CustodyStage[] }>("/access/stages"),
  keys: (opts: { packageId?: string; activeOnly?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.packageId) q.set("packageId", opts.packageId);
    if (opts.activeOnly) q.set("activeOnly", "true");
    return get<{ epoch: EpochStatus; keys: AccessKey[] }>(`/keys?${q}`);
  },
  issueKey: (packageId: string, stage: string, personId?: string) =>
    post<{ key: AccessKey; created: boolean }>("/keys/issue", {
      packageId,
      stage,
      ...(personId ? { personId } : {}),
    }),
  rotateKeys: () =>
    post<{ epoch: number; issuedCount: number; alreadyCurrent: number }>("/keys/rotate"),
  revokeKey: (id: string, reason: string) =>
    post<{ status: string }>(`/keys/${id}/revoke`, { reason }),
  requestAccess: (input: {
    packageId: string;
    stage: string;
    presentedKey?: string;
    deviceId: string;
    personId?: string;
    sealSerialRead?: string;
    geo?: { lat: number; lon: number; accuracyM: number };
  }) => post<AccessDecisionResult>("/access/request", input),
  packages: (examId?: string) =>
    get<{ packages: PackageSummary[] }>(`/packages${examId ? `?examId=${examId}` : ""}`),
  package: (id: string) => get<PackageDetail>(`/packages/${id}`),
  setDeclaredState: (id: string, state: PackageState) =>
    post<{ status: string }>(`/packages/${id}/declared-state`, { state }),
  devices: () => get<{ devices: Device[] }>("/devices"),
  revokeDevice: (id: string) => post<{ status: string }>(`/devices/${id}/revoke`),
  exams: () => get<{ exams: Exam[] }>("/exams"),
  centres: (examId?: string) =>
    get<{ centres: Centre[] }>(`/centres${examId ? `?examId=${examId}` : ""}`),
  persons: () => get<{ persons: Person[] }>("/persons"),
  /** Who is posted at one centre right now — the only people the engine will accept. */
  roster: (centreId: string) =>
    get<{ roster: RosterEntry[] }>(`/roster?centreId=${encodeURIComponent(centreId)}`),
  verifyChain: (fromSeq = "0", toSeq?: string) => {
    const q = new URLSearchParams({ fromSeq });
    if (toSeq) q.set("toSeq", toSeq);
    return get<ChainVerification>(`/verify/chain?${q}`);
  },
  /** Raw chain slice. Used by the witness page; everything else reads /activity. */
  rawEvents: (afterSeq = "0", limit = 200) =>
    get<{ events: RawEvent[] }>(`/events?afterSeq=${afterSeq}&limit=${limit}`),
  attempts: (opts: { packageId?: string; limit?: number; outcome?: "granted" | "denied" } = {}) => {
    const q = new URLSearchParams();
    if (opts.packageId) q.set("packageId", opts.packageId);
    if (opts.outcome) q.set("outcome", opts.outcome);
    q.set("limit", String(opts.limit ?? 20));
    return get<{ attempts: AccessAttempt[] }>(`/access/attempts?${q}`);
  },
  fingerprints: (opts: { deviceId?: string; liveOnly?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.deviceId) q.set("deviceId", opts.deviceId);
    if (opts.liveOnly) q.set("liveOnly", "true");
    return get<{ enrolments: FingerprintEnrolment[] }>(`/fingerprints?${q}`);
  },
  enrolFingerprint: (input: {
    deviceId: string;
    templateSlot: number;
    personId: string;
    role: "superintendent" | "observer";
    fingerLabel?: string;
    note?: string;
  }) => post<{ id: string }>("/fingerprints", input),
  revokeEnrolment: (id: string, reason: string) =>
    post<{ status: string }>(`/fingerprints/${id}/revoke`, { reason }),
  anchors: () => get<{ anchors: Anchor[] }>("/anchors"),
  buildAnchor: (day?: string) =>
    post<{ day: string; treeSize: number }>("/anchors/build", day ? { day } : {}),
};
