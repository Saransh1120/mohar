/**
 * Typed client for the ledger API.
 *
 * Everything goes through `/api`, which Vite proxies to the ledger service. The
 * UI never talks to Postgres, and nothing in this file constructs a signed
 * event: what the control room does through this client is read, and record
 * intent against reference data.
 *
 * Signing happens in exactly one other place. A browser that has been paired
 * as a `centre_pc` device signs the photographs its own camera takes, with a
 * key the browser holds and script cannot read; that is `lib/witness.ts`, and
 * it says there what the arrangement does and does not protect. The Live Demo
 * page also signs, as devices it enrols for itself and labels as its own.
 */

import { deviceSignatureHeaders, newDeviceKey } from "./deviceKeys";

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

/** The session, as a header. Every call that is not a signed event carries it. */
export function authHeaders(): Record<string, string> {
  const token = storedToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { headers: authHeaders() });
  if (!res.ok) {
    // The gateway says why it refused; that is worth more than a status code.
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, json.error ?? `GET ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * The URL to open an `EventSource` on.
 *
 * `EventSource` cannot send an Authorization header, and the session token
 * does not belong in a URL. So the gateway is asked for a ticket first: random,
 * good for one stream, dead thirty seconds after it was issued. A 404 means
 * there is no gateway in front (the page is talking to the ledger directly),
 * and the stream is opened as it always was.
 */
export async function streamUrl(path: string, params: Record<string, string> = {}): Promise<string> {
  const q = new URLSearchParams(params);
  const res = await fetch(`${BASE}/gateway/stream-ticket`, { method: "POST", headers: authHeaders() });
  if (res.status === 201) {
    const { ticket } = (await res.json()) as { ticket: string };
    q.set("ticket", ticket);
  } else if (res.status !== 404) {
    throw new ApiError(res.status, `stream ticket → ${res.status}`);
  }
  const qs = q.toString();
  return `${BASE}${path}${qs ? `?${qs}` : ""}`;
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

/**
 * A request a device makes: signed with the device's own key, which this
 * browser holds for the devices its consoles stand in for (`deviceKeys.ts`).
 * The gateway takes that signature, not the session, for a door, a hand-off
 * step or a ceremony step, and refuses a body that names any other device.
 *
 * The signature is over the path the gateway receives (no `/api`) and over the
 * exact text sent, so the body is serialised once and that string is both
 * signed and posted.
 */
async function postAsDevice<T>(deviceId: string, path: string, body?: unknown): Promise<T> {
  const text = JSON.stringify(body ?? {});
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...(await deviceSignatureHeaders(deviceId, "POST", path, text)),
    },
    body: text,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? `POST ${path} → ${res.status}`);
  return json;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? `PUT ${path} → ${res.status}`);
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
  /** A seam-seal commitment is on file for this package. */
  seamProtected: boolean;
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

/** What the ledger ruled about a device's key when it was enrolled. */
export interface DeviceAttestation {
  deviceId: string;
  /** `absent`: the device presented nothing, so there was nothing to rule on. */
  outcome: "verified" | "refused" | "absent";
  checks: EngineCheck[];
  facts: {
    kind?: "android-key" | "tpm-quote";
    /** In the ledger's words, where the key is as far as the statement shows. */
    keyHeldIn?: string;
    attestationSecurityLevel?: string;
    keyMintSecurityLevel?: string;
    verifiedBootState?: string;
    deviceLocked?: boolean;
    rootSubject?: string;
  };
  recordedAt: string;
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
  /**
   * The centres this account is limited to. Empty, or absent on a session
   * stored before the limit existed, means no limit.
   */
  centreIds?: string[];
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


// ── hand-offs ───────────────────────────────────────────────────────────────

export type TransferStep = "dispatch" | "receive" | "confirm";

export interface Leg {
  id: string;
  package_id: string;
  leg_no: number;
  from_role: string;
  to_role: string;
  from_place: string;
  to_place: string;
  window_start: string;
  window_end: string;
  expected_by: string;
  seal_serial: string | null;
  package_state: string;
  centre_code: string;
  dispatched: boolean;
  key_issued_at: string | null;
  completed: boolean;
  refused_attempts: number;
  overdue: boolean;
}

/** passed is absent where the step does not evaluate that check at all. */
export interface TransferCheck {
  check: string;
  passed?: boolean;
  evidence: string;
  reason?: string;
}

export interface TransferAttempt {
  id: string;
  attempt_no: number;
  outcome: "granted" | "refused";
  recorded_at: string;
  serial_typed: string | null;
  seam_id_seen: string | null;
  step: TransferStep;
  checks: TransferCheck[];
  person_id: string | null;
  person_name: string | null;
  person_role: string | null;
  device_id: string | null;
}

export interface TransferStepInput {
  deviceId: string;
  personId?: string;
  seamSecretHex?: string;
  seamIdRead?: string;
  packetSerialTyped?: string;
  biometricSlot?: number;
  biometricScore?: number;
  transferKey?: string;
  /** An approved damaged-label override, in place of the scan. */
  overrideId?: string;
  occurredAt?: string;
}

export interface TransferStepResult {
  outcome: "granted" | "refused";
  step: TransferStep;
  denyReasons: string[];
  checks: TransferCheck[];
  attemptNo: number;
  alertRaised: boolean;
  transferKey?: string;
  keyFingerprint?: string;
}

export interface DemoJourney {
  packageId: string;
  /** Absent on a packet this browser made before these were returned. */
  examId?: string;
  centreId?: string;
  serial: string;
  deviceId: string;
  people: Record<"press" | "courier" | "custodian", { id: string; name: string; role: string }>;
  legIds: string[];
  label: { seamId: string; shareAHex: string; shareBHex: string };
}

// ── the strong room door ────────────────────────────────────────────────────

/** One check as an engine recorded it. passed is absent where it was not run. */
export interface EngineCheck {
  check: string;
  passed?: boolean;
  evidence: string;
  reason?: string;
}

export interface DoorEntrant {
  personId: string;
  biometricSlot?: number;
  biometricScore?: number;
  faceMatched?: boolean;
  assertedAt: string;
}

export interface StrongRoom {
  id: string;
  name: string;
  place: string;
  monitor_device_id: string | null;
  centre_code: string | null;
  monitor_last_heard: string | null;
  visits: number;
  refused_attempts: number;
  inside: { visitId: string; enteredAt: string; expectedMinutes: number; persons: DoorEntrant[] }[];
}

export interface Footfall {
  evaluated: boolean;
  countedAtLeast: number | null;
  monitorEvents: number;
  mismatch: boolean;
  detail: string;
}

export interface RoomVisit {
  id: string;
  entered_at: string;
  expected_minutes: number;
  persons: DoorEntrant[];
  exited_at: string | null;
  dwell_seconds: number | null;
  packages_touched: number | null;
  footfall_out: Footfall | null;
  task: string | null;
  limit_seconds: number;
  inside_seconds: number | null;
}

export interface DoorAttempt {
  id: string;
  kind: "entry" | "exit";
  outcome: "granted" | "refused";
  recorded_at: string;
  persons: DoorEntrant[];
  visit_id: string | null;
  checks: EngineCheck[];
  task: string | null;
}

export interface DoorResult {
  outcome: "granted" | "refused";
  denyReasons: string[];
  checks: EngineCheck[];
  visitId?: string;
  dwellSeconds?: number;
  expectedMinutes?: number;
  dwellExceeded?: boolean;
  footfall?: Footfall;
}

export interface DemoStrongRoom {
  roomId: string;
  roomName: string;
  deviceId: string;
  people: { id: string; name: string; role: string; slot: number }[];
}

// ── the damaged-label override ──────────────────────────────────────────────

export interface OverrideStanding {
  status: "pending" | "approved" | "refused" | "unusable";
  approvals: number;
  detail: string;
}

/** What the ledger had on record about an operator's call when they decided. */
export interface CallEvidence {
  /** False where the deployment has turned the call requirement off. */
  required: boolean;
  onRecord: boolean;
  checks: EngineCheck[];
}

export interface OverrideDecision {
  accountId: string;
  accountName: string;
  accountUsername: string;
  decision: "approved" | "refused";
  videoConfirmed: boolean;
  officersPresent: boolean;
  /** Null on a decision made before calls were recorded. */
  callEvidence: CallEvidence | null;
  note: string;
  decidedAt: string;
}

/** One set-up message of an override's call, as the ledger carries it. */
export interface CallSignal {
  seq: number;
  kind: "operator-joined" | "device-joined" | "offer" | "answer" | "bye";
  /** `device`, or an operator's account id. */
  from: string;
  fromName?: string;
  sdp?: string;
}

export interface CallRecord {
  events: {
    party: "operator" | "field";
    accountId: string | null;
    accountName: string | null;
    event: string;
    detail: { framesDecoded?: number; seconds?: number };
    recordedAt: string;
  }[];
  operators: { accountId: string; accountName: string; onRecord: boolean; checks: EngineCheck[] }[];
}

export interface OverrideRequest {
  id: string;
  leg_id: string;
  package_id: string;
  seam_id_typed: string;
  serial_typed: string | null;
  attempted_seconds: number;
  which_codes: "A" | "B" | "both";
  photo_sha256: string;
  evidence: { seamIdMatches?: boolean; serialMatches?: boolean; labelOnRecord?: boolean };
  requested_at: string;
  leg_no: number;
  from_place: string;
  to_place: string;
  seal_serial: string | null;
  centre_code: string;
  person_name: string | null;
  person_role: string | null;
  used: boolean;
  decisions: OverrideDecision[];
  standing: OverrideStanding;
}

export interface OverrideRate {
  key: string;
  label: string;
  legs: number;
  overrides: number;
  per100: number;
  timesBaseline: number | null;
}

export interface OverrideStats {
  baseline: { legs: number; overrides: number; per100: number };
  byCentre: OverrideRate[];
  byRoute: OverrideRate[];
  byOfficer: OverrideRate[];
}

// ── rosters and the opening ─────────────────────────────────────────────────

export type DutyRole = "superintendent" | "observer" | "police_escort";

export interface DutyRoster {
  centre_id: string;
  centre_code: string;
  exam_session: string;
  exam_name: string;
  starts_at: string;
  duty: {
    role: DutyRole;
    personId: string;
    personName: string;
    personRole: string;
    lockedAt: string | null;
  }[];
  issued: {
    packageId: string;
    packetSerial: string | null;
    drandRound: number;
    scheduledOpenAt: string;
    stationDeviceId: string;
    issuedAt: string;
    keyCommitment: string;
    issueNo: number;
  }[];
  /** Every lock and re-issue of this roster, oldest first. */
  issues: RosterIssue[];
  packets: number;
}

export interface RosterIssue {
  issueNo: number;
  kind: "lock" | "reissue";
  issuedAt: string;
  late: boolean;
  /** Seconds before the exam's start that it was done. */
  leadSeconds: number;
  reason: string | null;
  packets: number;
  changes: { role: DutyRole; fromPersonId: string; toPersonId: string }[];
  by: string | null;
  byUsername: string | null;
}

export interface ReissueResult {
  outcome: "reissued" | "refused";
  denyReasons: string[];
  checks: EngineCheck[];
  issueNo: number | null;
  reissuedBy: string | null;
  changes: { role: DutyRole; fromPersonId: string; toPersonId: string }[];
  packets: {
    packageId: string;
    packetSerial: string | null;
    drandRound: number;
    scheduledOpenAt: string;
  }[];
}

export interface ListedAccount extends Account {
  disabledAt: string | null;
  disabledReason: string | null;
}

/** One request the gateway refused: who, what, and what it found. No ranking. */
export interface GatewayRefusal {
  at: string;
  method: string;
  path: string;
  ip: string;
  status: number;
  reason: string;
  detail: Record<string, unknown>;
  caller: string;
}

export interface GatewayStatus {
  startedAt: string;
  upstream: string;
  forwarded: number;
  refusedByReason: Record<string, number>;
  limits: Record<string, { burst: number; perMinute: number }>;
  recentRefusals: GatewayRefusal[];
}

export interface LockResult {
  outcome: "locked" | "refused";
  denyReasons: string[];
  checks: EngineCheck[];
  lockedAt: string | null;
  lockedBy: string | null;
  issueNo: number | null;
  /** True when it was locked inside the last day before the exam. */
  late: boolean;
  packets: {
    packageId: string;
    packetSerial: string | null;
    drandRound: number;
    scheduledOpenAt: string;
  }[];
}

export interface StepDecision {
  outcome: "passed" | "refused";
  checks: EngineCheck[];
  denyReasons: string[];
}

export type CeremonyStepName =
  | "scan"
  | "authorize"
  | "identify"
  | "confirm"
  | "release"
  | "opened"
  | "incomplete";

export interface CeremonyOfficial {
  personId: string;
  role: DutyRole;
  institution: string;
  assertedAt?: string;
}

export interface Ceremony {
  id: string;
  packageId: string;
  centreId: string;
  scheduledOpenAt: string;
  startedAt: string;
  reached: CeremonyStepName | null;
  officials: CeremonyOfficial[];
  steps: {
    step: CeremonyStepName;
    outcome: "passed" | "refused";
    officials: CeremonyOfficial[];
    checks: EngineCheck[];
    recordedAt: string;
  }[];
  packetSerial?: string | null;
  centreCode?: string;
  examName?: string;
  examStartsAt?: string;
}

export interface CeremonyStart {
  ceremonyId: string;
  outcome: "passed" | "refused";
  scan: StepDecision;
  authorize: StepDecision;
  scheduledOpenAt: string;
  drandRound: number | null;
}

/** A share as the server hands it over: ciphertext only the station can read. */
export interface WrappedShareEnvelope {
  wrapped: { ephemeralPublicHex: string; nonceHex: string; ciphertextHex: string };
  holder: DutyRole;
  institution: string;
  index: number;
  commitment: string;
}

export interface OfficialResult {
  outcome: "passed" | "refused";
  denyReasons: string[];
  checks: EngineCheck[];
  identified: number;
  official?: CeremonyOfficial;
  share?: WrappedShareEnvelope;
}

export interface ConfirmResult {
  outcome: "passed" | "refused";
  denyReasons: string[];
  checks: EngineCheck[];
  alertRaised: boolean;
  /** The time-locked envelope, as `@mohar/crypto-core` issued it. */
  envelope?: unknown;
  commitments?: { controlCommitment: string; keyCommitment: string };
}

/** What a station holds to open one packet with the ledger out of reach. */
export interface StationCache {
  packageId: string;
  packetSerial: string | null;
  centreCode: string;
  examStartsAt: string;
  scheduledOpenAt: string;
  issueNo: number;
  drandRound: number;
  seam: { seamId: string; commitmentHex: string } | null;
  commitments: { controlCommitment: string; keyCommitment: string };
  /** The time-locked envelope, as `@mohar/crypto-core` issued it. */
  envelope: unknown;
  officials: {
    personId: string;
    name: string;
    holder: DutyRole;
    institution: string;
    index: number;
    commitment: string;
    slot: number | null;
    wrapped: { ephemeralPublicHex: string; nonceHex: string; ciphertextHex: string };
  }[];
}

/** A station's account of an opening it did on its own. */
export interface OfflineTranscript {
  transcriptId: string;
  packageId: string;
  deviceId: string;
  seamIdRead?: string;
  seamSecretHex?: string;
  officials: {
    personId: string;
    biometricSlot?: number;
    biometricScore?: number;
    assertedAt: string;
  }[];
  packetSerialTyped: string;
  openingKeyHex: string;
  photoSha256?: string;
  startedAt: string;
  releasedAt: string;
}

export interface OfflineRuling {
  ceremonyId: string;
  mode: "envelope-authorized";
  outcome: "accepted" | "disputed";
  duplicate: boolean;
  denyReasons: string[];
  steps: { step: CeremonyStepName; outcome: "passed" | "refused"; checks: EngineCheck[] }[];
}

export interface DemoOpening {
  examId: string;
  examStartsAt: string;
  centreId: string;
  centreCode: string;
  packageId: string;
  serial: string;
  stationDeviceId: string;
  officials: { id: string; name: string; role: DutyRole; slot: number }[];
  label: { seamId: string; shareAHex: string; shareBHex: string };
}

// ── alerts ──────────────────────────────────────────────────────────────────

export interface AlertAck {
  id: string;
  note: string | null;
  ackedAt: string;
  personName: string | null;
  personRole: string | null;
  accountName: string | null;
  accountUsername: string | null;
}

export interface AlertDelivery {
  channel: string;
  outcome: "sent" | "failed";
  attemptedAt: string;
}

/**
 * One raised alert. `evidence` is what was known when it was raised and is
 * never rewritten; `leg_closed_at` is read live, so the page can say what has
 * happened since without touching what was recorded.
 */
export interface Alert {
  id: string;
  kind: string;
  package_id: string | null;
  leg_id: string | null;
  device_id: string | null;
  evidence: Record<string, unknown>;
  requires_decision: boolean;
  consequence: string;
  raised_at: string;
  seal_serial: string | null;
  centre_code: string | null;
  leg_no: number | null;
  from_place: string | null;
  to_place: string | null;
  from_role: string | null;
  to_role: string | null;
  expected_by: string | null;
  leg_closed_at: string | null;
  acks: AlertAck[];
  deliveries: AlertDelivery[];
}

export interface AlertSummary {
  total: number;
  unacknowledged: number;
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

  // Accounts are kept by a control room operator. None of these signs anyone in.
  accounts: () => get<{ accounts: ListedAccount[] }>("/auth/accounts"),
  createAccount: (input: { username: string; password: string; displayName: string; role: string }) =>
    post<{ account: Account }>("/auth/accounts", input),
  disableAccount: (id: string, reason: string) =>
    post<{ status: string }>(`/auth/accounts/${id}/disable`, { reason }),
  /** Limit an account to these centres. An empty list lifts the limit. */
  setAccountCentres: (id: string, centreIds: string[]) =>
    put<{ id: string; centreIds: string[] }>(`/auth/accounts/${id}/centres`, { centreIds }),
  /** What the gateway has refused since it started. A 404 means there is no gateway in front. */
  gatewayStatus: () => get<GatewayStatus>("/gateway/status"),

  health: () => get<Health>("/health"),
  /** Four totals anyone may read. Everything else in `/summary` takes a session. */
  counters: () =>
    get<{ events: number; packages: number; devices: number; centres: number }>("/counters"),
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
    /** The flap code as decoded, 64 lowercase hex. Omit when it would not read —
     *  the engine treats absence as its own outcome, so never send a placeholder. */
    seamTokenRead?: string;
    geo?: { lat: number; lon: number; accuracyM: number };
  }) => post<AccessDecisionResult>("/access/request", input),
  packages: (examId?: string) =>
    get<{ packages: PackageSummary[] }>(`/packages${examId ? `?examId=${examId}` : ""}`),
  package: (id: string) => get<PackageDetail>(`/packages/${id}`),
  setDeclaredState: (id: string, state: PackageState) =>
    post<{ status: string }>(`/packages/${id}/declared-state`, { state }),
  /** Only the commitment is sent. The token stays in the browser and on the label. */
  fitSeamSeal: (id: string, commitment: string) =>
    post<{ status: string }>(`/packages/${id}/seam-seal`, { commitment }),
  testSeamToken: (id: string, token: string) =>
    post<{ result: "match" | "mismatch" | "not_fitted" | "unknown_package" }>(
      `/packages/${id}/seam-test`,
      { token },
    ),
  devices: () => get<{ devices: Device[] }>("/devices"),
  deviceAttestations: () => get<{ attestations: DeviceAttestation[] }>("/devices/attestations"),
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
  legs: (packageId?: string) =>
    get<{ legs: Leg[] }>(`/legs${packageId ? `?packageId=${packageId}` : ""}`),
  legAttempts: (legId: string) =>
    get<{ attempts: TransferAttempt[] }>(`/legs/${legId}/attempts`),
  transferStep: (legId: string, step: TransferStep, input: TransferStepInput) =>
    postAsDevice<TransferStepResult>(input.deviceId, `/legs/${legId}/${step}`, input),
  /**
   * The courier's handheld in this journey is given a key this browser made,
   * so the console can sign each step as that device.
   */
  demoJourney: async (dueInMinutes?: number) => {
    const key = await newDeviceKey();
    const j = await post<DemoJourney>("/demo/journey", {
      devicePubkeyHex: key.publicKeyHex,
      ...(dueInMinutes ? { dueInMinutes } : {}),
    });
    await key.keepAs(j.deviceId);
    return j;
  },
  alerts: (opts: { open?: boolean } = {}) =>
    get<{ alerts: Alert[] }>(`/alerts${opts.open ? "?open=true" : ""}`),
  alertSummary: () => get<AlertSummary>("/alerts/summary"),
  ackAlert: (id: string, note: string) =>
    post<{ id: string; ackedAt: string }>(`/alerts/${id}/ack`, { note }),

  // ── the strong room door ──
  rooms: () => get<{ rooms: StrongRoom[] }>("/rooms"),
  roomVisits: (roomId: string) =>
    get<{ visits: RoomVisit[]; attempts: DoorAttempt[] }>(`/rooms/${roomId}/visits`),
  roomEntry: (
    roomId: string,
    input: { deviceId: string; entrants: DoorEntrant[]; task: string; expectedMinutes: number },
  ) => postAsDevice<DoorResult>(input.deviceId, `/rooms/${roomId}/entry`, input),
  roomExit: (
    roomId: string,
    input: { deviceId: string; visitId: string; packagesTouched: number },
  ) => postAsDevice<DoorResult>(input.deviceId, `/rooms/${roomId}/exit`, input),
  /** The door device is given a key this browser made, so the console signs as the door. */
  demoStrongRoom: async () => {
    const key = await newDeviceKey();
    const d = await post<DemoStrongRoom>("/demo/strongroom", { devicePubkeyHex: key.publicKeyHex });
    await key.keepAs(d.deviceId);
    return d;
  },

  // ── the damaged-label override ──
  overrides: () => get<{ overrides: OverrideRequest[] }>("/overrides"),
  overrideStats: () => get<OverrideStats>("/overrides/stats"),
  requestOverride: (
    legId: string,
    input: {
      deviceId: string;
      personId?: string;
      seamIdTyped: string;
      serialTyped?: string;
      attemptedSeconds: number;
      whichCodes: "A" | "B" | "both";
      photoSha256: string;
    },
  ) =>
    postAsDevice<{ overrideId: string; standing: OverrideStanding }>(
      input.deviceId,
      `/legs/${legId}/override`,
      input,
    ),
  decideOverride: (
    id: string,
    input: {
      decision: "approved" | "refused";
      videoConfirmed: boolean;
      officersPresent: boolean;
      note: string;
    },
  ) => post<{ standing: OverrideStanding; call: CallEvidence }>(`/overrides/${id}/decision`, input),

  /** The video call an override is approved over. See lib/overrideCall. */
  overrideCall: {
    join: (id: string) =>
      post<{ you: string; devicePresent: boolean; iceServers: RTCIceServer[]; relay?: boolean }>(`/overrides/${id}/call/join`, {}),
    inbox: (id: string, after: number) =>
      get<{ signals: CallSignal[] }>(`/overrides/${id}/call/inbox?after=${after}`),
    answer: (id: string, sdp: string) => post<{ carried: boolean }>(`/overrides/${id}/call/answer`, { sdp }),
    state: (
      id: string,
      body: { state: "connected" | "ended"; framesDecoded?: number; width?: number; height?: number; seconds?: number },
    ) => post<{ recorded: boolean }>(`/overrides/${id}/call/state`, body),
    record: (id: string) => get<CallRecord>(`/overrides/${id}/call`),
    ice: () => get<{ iceServers: RTCIceServer[]; relay: boolean; problems: string[] }>("/calls/ice"),
    // The phone's end, signed by the device as every other act of its is.
    deviceJoin: (id: string, deviceId: string) =>
      postAsDevice<{ operators: { accountId: string; name: string }[]; iceServers: RTCIceServer[]; relay?: boolean }>(
        deviceId, `/overrides/${id}/call/device/join`, { deviceId }),
    deviceInbox: (id: string, deviceId: string, after: number) =>
      postAsDevice<{ signals: CallSignal[] }>(deviceId, `/overrides/${id}/call/device/inbox`, { deviceId, after }),
    deviceOffer: (id: string, deviceId: string, to: string, sdp: string) =>
      postAsDevice<{ carried: boolean }>(deviceId, `/overrides/${id}/call/device/offer`, { deviceId, to, sdp }),
    deviceState: (
      id: string,
      deviceId: string,
      body: { operator: string; state: "connected" | "ended"; seconds?: number },
    ) => postAsDevice<{ recorded: boolean }>(deviceId, `/overrides/${id}/call/device/state`, { deviceId, ...body }),
  },

  // ── rosters and the opening ──
  rosters: (centreId?: string) =>
    get<{ rosters: DutyRoster[] }>(`/rosters${centreId ? `?centreId=${centreId}` : ""}`),
  assignRoster: (
    centreId: string,
    session: string,
    assignments: { role: DutyRole; personId: string }[],
  ) => put<{ status: string }>(`/rosters/${centreId}/${session}`, { assignments }),
  lockRoster: (centreId: string, session: string, stationDeviceId: string, lateReason?: string) =>
    post<LockResult>(`/rosters/${centreId}/${session}/lock`, {
      stationDeviceId,
      ...(lateReason?.trim() ? { lateReason: lateReason.trim() } : {}),
    }),
  reissueRoster: (
    centreId: string,
    session: string,
    changes: { role: DutyRole; personId: string }[],
    reason: string,
  ) => post<ReissueResult>(`/rosters/${centreId}/${session}/reissue`, { changes, reason }),
  registerWrapKey: (deviceId: string, x25519PubHex: string) =>
    postAsDevice<{ status: string }>(deviceId, `/stations/${deviceId}/wrap-key`, { x25519PubHex }),
  ceremonies: (packageId?: string) =>
    get<{ ceremonies: Ceremony[] }>(`/ceremonies${packageId ? `?packageId=${packageId}` : ""}`),
  startCeremony: (input: {
    packageId: string;
    deviceId: string;
    seamIdRead?: string;
    seamSecretHex?: string;
  }) => postAsDevice<CeremonyStart>(input.deviceId, "/ceremonies", input),
  // Every step of a ceremony is the station's, signed with the station's key.
  ceremonyOfficial: (
    stationDeviceId: string,
    id: string,
    input: {
      personId: string;
      biometricSlot?: number;
      biometricScore?: number;
      faceMatched?: boolean;
    },
  ) => postAsDevice<OfficialResult>(stationDeviceId, `/ceremonies/${id}/official`, input),
  ceremonyConfirm: (stationDeviceId: string, id: string, packetSerialTyped: string) =>
    postAsDevice<ConfirmResult>(stationDeviceId, `/ceremonies/${id}/confirm`, { packetSerialTyped }),
  ceremonyRelease: (stationDeviceId: string, id: string, openingKeyHex: string) =>
    postAsDevice<{ outcome: "granted" | "refused"; denyReasons: string[]; checks: EngineCheck[] }>(
      stationDeviceId,
      `/ceremonies/${id}/release`,
      { openingKeyHex },
    ),
  ceremonyOpened: (
    stationDeviceId: string,
    id: string,
    photoSha256: string,
    candidateWitnesses: number,
  ) =>
    postAsDevice<{ outcome: "opened" | "refused" }>(stationDeviceId, `/ceremonies/${id}/opened`, {
      photoSha256,
      candidateWitnesses,
    }),
  // Both are the station's own acts, signed with its key.
  stationCache: (stationDeviceId: string, packageId: string) =>
    postAsDevice<StationCache>(stationDeviceId, `/stations/${stationDeviceId}/cache`, { packageId }),
  offlineOpening: (transcript: OfflineTranscript) =>
    postAsDevice<OfflineRuling>(transcript.deviceId, "/ceremonies/offline", transcript),
  demoOpening: (stationDeviceId: string, startsInMinutes: number) =>
    post<DemoOpening>("/demo/opening", { stationDeviceId, startsInMinutes }),
};
