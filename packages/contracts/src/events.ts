import { z } from "zod";
import {
  Uuid,
  Sha256Hex,
  Timestamp,
  GeoPoint,
  ShortText,
  LongText,
  Ed25519SignatureHex,
} from "./primitives.js";
import { DenyReason, PackageState, PersonRole } from "./enums.js";

/**
 * ── The signed body ──────────────────────────────────────────────────────────
 *
 * An event body is what a device signs. It deliberately does NOT contain `seq`,
 * `prevHash`, `hash`, or `receivedAt`: those are assigned by the ledger when the
 * event is accepted, and a device cannot know them at signing time (the chain is
 * global and the device may be offline for hours).
 *
 * CANONICALISATION RULE — optional fields must be **omitted**, never set to
 * `null`. RFC 8785 serialises `{"a":null}` and `{}` to different bytes, so a
 * client that helpfully fills absent values with `null` will produce a body that
 * fails signature verification. `exactOptionalPropertyTypes` in tsconfig makes
 * this a compile error on our own clients; the schemas below reject it at the
 * boundary for everyone else.
 */

export const EVENT_SCHEMA_VERSION = 1 as const;

export const EventKind = z.enum([
  // ── package lifecycle ──
  "PACKAGE_SEALED",
  "SEAL_APPLIED",
  "HANDOFF",
  "SCAN_OBSERVED",
  // ── access decisions ──
  "ACCESS_REQUESTED",
  "ACCESS_GRANTED",
  "ACCESS_DENIED",
  "ACCESS_FRAME",
  "OVERRIDE_USED",
  "SEAL_MISMATCH",
  // ── room telemetry (ESP32) ──
  "MONITOR_HEARTBEAT",
  "MONITOR_SILENT",
  "ROOM_ENTRY",
  // ── witness station (ESP32-S3: fingerprint + camera) ──
  "WITNESS_ASSERTED",
  "WITNESS_CEREMONY",
  "WITNESS_FRAME",
  // ── key custody ──
  "SHARE_RELEASED",
  "FALLBACK_INVOKED",
  // ── printing ──
  "PRINT_STARTED",
  "PRINT_COMPLETED",
  "KEY_DESTROYED",
  // ── catch-all ──
  "EXCEPTION_RAISED",
]);
export type EventKind = z.infer<typeof EventKind>;

/** Kinds that are never accepted from a field device — only a service may emit them. */
export const SERVICE_ONLY_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "PACKAGE_SEALED",
  "ACCESS_GRANTED",
  "ACCESS_DENIED",
  "MONITOR_SILENT",
  "SHARE_RELEASED",
  "FALLBACK_INVOKED",
]);

// ── payloads ────────────────────────────────────────────────────────────────

export const PackageSealedPayload = z.object({
  copies: z.number().int().positive().max(10_000),
  ciphertextSha256: Sha256Hex,
  /** drand quicknet round the timelock share is bound to. See docs/11. */
  drandRound: z.number().int().positive(),
  /** One commitment per Shamir share, so share release can be audited later. */
  shareCommitments: z.array(Sha256Hex).length(4),
});

export const SealAppliedPayload = z.object({
  sealSerial: ShortText,
  photoSha256: Sha256Hex,
});

export const HandoffPayload = z.object({
  fromPersonId: Uuid,
  toPersonId: Uuid,
  fromRole: PersonRole,
  toRole: PersonRole,
  sealSerial: ShortText,
  photoSha256: Sha256Hex,
  toState: PackageState,
});

export const ScanObservedPayload = z.object({
  scanType: z.enum(["qr", "nfc"]),
  /** Exactly what was read, before any lookup. Retained even when it resolves to
   *  nothing: scans of unknown identifiers are themselves intelligence. */
  rawIdentifier: ShortText,
});

export const AccessRequestedPayload = z.object({
  sessionId: Uuid,
  sealSerialRead: ShortText.optional(),
  photoSha256: Sha256Hex.optional(),
});

export const AccessGrantedPayload = z.object({
  sessionId: Uuid,
  receiptSha256: Sha256Hex,
  checksPassed: z.array(ShortText).min(1),
});

export const AccessDeniedPayload = z.object({
  sessionId: Uuid,
  /** Every failing check, not just the first. A single request that trips four
   *  checks is a materially different signal from one that trips a clock skew. */
  reasons: z.array(DenyReason).min(1),
});

/**
 * A photograph of whoever was at the terminal when a request was refused.
 *
 * Bound to the decision event rather than to a biometric assertion, because the
 * case this exists for is precisely the one where no valid assertion happened —
 * someone presenting a key that is wrong, stale, or was never issued. The
 * ceremony has `WITNESS_FRAME`; this is its counterpart on the refusal path.
 *
 * Only the digest is committed. The image stays wherever the operator keeps it,
 * and the chain proves it is the frame taken at that refusal without becoming a
 * photo archive of everyone who ever mistyped a key.
 */
export const AccessFramePayload = z.object({
  /**
   * The attempt this frame was taken for.
   *
   * Bound to the attempt, not to a decision event, because there is no decision
   * event: `/access/request` records the attempt and returns, and appending an
   * `ACCESS_DENIED` to the chain would need a signing identity the service
   * deliberately does not have. Binding to an id that is always null produced a
   * frame that could never be committed, which is worse than binding to the row
   * that actually exists.
   */
  attemptId: Uuid.optional(),
  /** The decision event, once the engine has a device identity to sign one. */
  decisionEventId: Uuid.optional(),
  /**
   * The station's own refusal, when the finger never got as far as a request.
   *
   * `EXCEPTION_RAISED` with a `biometric_*` code is the reader saying no — an
   * unenrolled finger, or a match too weak to count. There is no attempt to
   * point at because no access request was ever made, but it is still a refused
   * unlock and still the moment worth having a face for.
   */
  exceptionEventId: Uuid.optional(),
  frameSha256: Sha256Hex,
  frameBytes: z.number().int().positive(),
  width: z.number().int().positive().max(10_000),
  height: z.number().int().positive().max(10_000),
}).refine(
  (p) => Boolean(p.attemptId ?? p.decisionEventId ?? p.exceptionEventId),
  {
    // A frame bound to nothing is a photograph of a person with no record of
    // why it was taken. Refusing it here is cheaper than discovering later that
    // the chain holds faces nobody can account for.
    message: "a frame must name the attempt, decision or exception it was taken for",
  },
);

export const OverrideUsedPayload = z.object({
  sessionId: Uuid,
  deniedReasons: z.array(DenyReason).min(1),
  justification: LongText,
  photoSha256: Sha256Hex,
});

export const SealMismatchPayload = z.object({
  expectedSerial: ShortText,
  observedSerial: ShortText,
  photoSha256: Sha256Hex,
});

export const MonitorHeartbeatPayload = z.object({
  monitorId: Uuid,
  /** Monotonic counter from the ESP32. Gaps are visible rather than silent. */
  sequence: z.number().int().nonnegative(),
  batteryMv: z.number().int().nonnegative().max(20_000).optional(),
  bufferedRecords: z.number().int().nonnegative(),
});

export const MonitorSilentPayload = z.object({
  monitorId: Uuid,
  lastHeartbeatAt: Timestamp,
  missedCount: z.number().int().positive(),
});

export const RoomEntryPayload = z.object({
  monitorId: Uuid,
  sequence: z.number().int().nonnegative(),
  doorOpen: z.boolean(),
  /** From the paired ToF sensors. Reported as a floor, never as exact: two
   *  people abreast through a wide door count as one. See docs/06 Part B. */
  enteredAtLeast: z.number().int().nonnegative(),
  exitedAtLeast: z.number().int().nonnegative(),
  /** mmWave presence — true means someone is in the room, including stationary. */
  presence: z.boolean(),
  lightOn: z.boolean(),
});

/**
 * One biometric assertion at the unlock ceremony, with the frame captured at
 * that instant committed by hash.
 *
 * What is *not* here is the point. There is no fingerprint image and no
 * template: the R307 enrols and matches entirely on its own flash and returns a
 * slot id and a score, so the chain records "slot 3 matched, score 187" and a
 * breach of this database cannot leak a biometric that was never in it.
 *
 * `frameSha256` follows the same pattern as the custody key — commit the hash,
 * hold the artefact elsewhere. The JPEG lives on the station's SD card and
 * uploads when bandwidth allows. Losing it later does not break the chain; it
 * only means that one commitment can no longer be checked against anything.
 */
export const WitnessAssertedPayload = z.object({
  stationId: Uuid,
  sessionId: Uuid,
  sequence: z.number().int().nonnegative(),
  role: z.enum(["superintendent", "observer"]),
  /** Slot on the reader's own flash. The slot→person mapping lives in `ref.person`. */
  templateSlot: z.number().int().min(1).max(127),
  /** Reader confidence, roughly 0–255. Recorded as evidence, not as a verdict. */
  matchScore: z.number().int().nonnegative().max(1000),
  frameSha256: Sha256Hex,
  /** Zero means no frame was captured — stated, rather than left to inference. */
  frameBytes: z.number().int().nonnegative(),
});

/**
 * The outcome of one two-person window.
 *
 * `same_finger_twice` is recorded rather than discarded, for the same reason the
 * ledger refuses a co-signature from the signing device: one person tapping
 * twice is an attempt at a two-person act by one person, and that attempt is
 * worth more in the record than its absence.
 */
export const WitnessCeremonyPayload = z.object({
  stationId: Uuid,
  sessionId: Uuid,
  sequence: z.number().int().nonnegative(),
  assertionCount: z.number().int().nonnegative(),
  distinctSlots: z.boolean(),
  windowSeconds: z.number().int().positive(),
  outcome: z.enum(["two_person_confirmed", "same_finger_twice", "window_expired"]),
});

/**
 * The photograph of the unlock ceremony, committed by hash.
 *
 * Captured by the centre PC's own camera rather than by the station, because a
 * classic ESP32 has no camera interface. That split is a real weakening and is
 * named here rather than hidden: the assertion and the frame are signed by two
 * different devices, so a compromised centre PC can pair a genuine fingerprint
 * match with a substituted photograph. What survives is that both halves are
 * committed to an append-only chain at the time, so the substitution has to be
 * decided on in the moment and cannot be arranged afterwards.
 *
 * `assertionEventId` binds this frame to one specific WITNESS_ASSERTED record
 * rather than merely to the session, so "which official is this a photograph
 * of" has an answer that does not depend on timestamp ordering.
 *
 * The image itself never enters the ledger. Same pattern as the custody key:
 * commit the hash, hold the artefact elsewhere. Losing the image later does not
 * break the chain — it only means that one commitment can no longer be checked.
 */
export const WitnessFramePayload = z.object({
  sessionId: Uuid,
  assertionEventId: Uuid,
  frameSha256: Sha256Hex,
  frameBytes: z.number().int().positive(),
  width: z.number().int().positive().max(10_000),
  height: z.number().int().positive().max(10_000),
});

export const ShareReleasedPayload = z.object({
  shareIndex: z.number().int().min(1).max(4),
  holder: z.enum(["authority", "timelock", "superintendent", "observer"]),
  commitment: Sha256Hex,
});

export const FallbackInvokedPayload = z.object({
  reason: LongText,
  /** Two distinct control-room operators. Enforced as distinct at the boundary. */
  authorisedBy: z.array(Uuid).length(2),
  channel: z.enum(["phone_readout", "in_app", "webhook"]),
});

export const PrintStartedPayload = z.object({
  copiesRequested: z.number().int().positive().max(10_000),
});

export const PrintCompletedPayload = z.object({
  copiesPrinted: z.number().int().nonnegative().max(10_000),
  copiesSpoiled: z.number().int().nonnegative().max(10_000),
  firstSerial: ShortText,
  lastSerial: ShortText,
});

export const KeyDestroyedPayload = z.object({
  method: z.enum(["zeroised_after_print", "zeroised_on_window_expiry", "zeroised_on_abort"]),
});

export const ExceptionRaisedPayload = z.object({
  code: ShortText,
  detail: LongText,
});

/** Kind → payload schema. Exported so services can validate without the union. */
export const PAYLOAD_SCHEMAS = {
  PACKAGE_SEALED: PackageSealedPayload,
  SEAL_APPLIED: SealAppliedPayload,
  HANDOFF: HandoffPayload,
  SCAN_OBSERVED: ScanObservedPayload,
  ACCESS_REQUESTED: AccessRequestedPayload,
  ACCESS_GRANTED: AccessGrantedPayload,
  ACCESS_DENIED: AccessDeniedPayload,
  ACCESS_FRAME: AccessFramePayload,
  OVERRIDE_USED: OverrideUsedPayload,
  SEAL_MISMATCH: SealMismatchPayload,
  MONITOR_HEARTBEAT: MonitorHeartbeatPayload,
  MONITOR_SILENT: MonitorSilentPayload,
  ROOM_ENTRY: RoomEntryPayload,
  WITNESS_ASSERTED: WitnessAssertedPayload,
  WITNESS_CEREMONY: WitnessCeremonyPayload,
  WITNESS_FRAME: WitnessFramePayload,
  SHARE_RELEASED: ShareReleasedPayload,
  FALLBACK_INVOKED: FallbackInvokedPayload,
  PRINT_STARTED: PrintStartedPayload,
  PRINT_COMPLETED: PrintCompletedPayload,
  KEY_DESTROYED: KeyDestroyedPayload,
  EXCEPTION_RAISED: ExceptionRaisedPayload,
} as const satisfies Record<EventKind, z.ZodTypeAny>;

// ── envelope ────────────────────────────────────────────────────────────────

const envelopeShape = {
  /** Schema version, inside the signed bytes so a future change is unambiguous. */
  v: z.literal(EVENT_SCHEMA_VERSION),
  /** Client-generated. Doubles as the idempotency key for offline replay. */
  id: Uuid,
  examId: Uuid,
  packageId: Uuid.optional(),
  centreId: Uuid.optional(),
  /** Device clock at the moment of the act. May be wrong; never silently corrected. */
  occurredAt: Timestamp,
  actorDeviceId: Uuid,
  actorPersonId: Uuid.optional(),
  geo: GeoPoint.optional(),
};

/**
 * The full signed body as a discriminated union, so `body.payload` narrows from
 * `body.kind` with no casts anywhere in the services.
 */
export const EventBody = z.discriminatedUnion(
  "kind",
  Object.entries(PAYLOAD_SCHEMAS).map(([kind, payload]) =>
    z.object({ ...envelopeShape, kind: z.literal(kind as EventKind), payload }).strict(),
  ) as unknown as [
    z.ZodDiscriminatedUnionOption<"kind">,
    ...z.ZodDiscriminatedUnionOption<"kind">[],
  ],
);
export type EventBody = {
  [K in EventKind]: {
    v: typeof EVENT_SCHEMA_VERSION;
    id: string;
    examId: string;
    packageId?: string;
    centreId?: string;
    occurredAt: Timestamp;
    actorDeviceId: string;
    actorPersonId?: string;
    geo?: z.infer<typeof GeoPoint>;
    kind: K;
    payload: z.infer<(typeof PAYLOAD_SCHEMAS)[K]>;
  };
}[EventKind];

/** What a client POSTs: the body plus the device's signature over its canonical form. */
export const SignedEvent = z.object({
  body: EventBody,
  deviceSig: Ed25519SignatureHex,
  /** Present on two-person acts (handoffs, overrides). Verified against the
   *  co-signing person's registered device key. */
  cosignDeviceId: Uuid.optional(),
  cosignSig: Ed25519SignatureHex.optional(),
});
export type SignedEvent = {
  body: EventBody;
  deviceSig: string;
  cosignDeviceId?: string;
  cosignSig?: string;
};

/** Kinds that require a second signature to be accepted. */
export const COSIGN_REQUIRED_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "HANDOFF",
  "OVERRIDE_USED",
  "FALLBACK_INVOKED",
]);

/** What the ledger returns once the event is anchored into the chain. */
export interface LedgerRecord {
  seq: string; // bigint as string; JS numbers lose precision past 2^53
  body: EventBody;
  deviceSig: string;
  cosignDeviceId?: string;
  cosignSig?: string;
  receivedAt: Timestamp;
  /** occurredAt − receivedAt. Recorded, never corrected. Large values are a signal. */
  clockSkewMs: number;
  bodyHash: string;
  prevHash: string;
  hash: string;
}
