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
  // ── hand-off legs ──
  "HANDOVER_INITIATED",
  "HANDOVER_COMPLETED",
  "HANDOVER_REFUSED",
  "LEG_OVERDUE",
  "STORED",
  "RELEASED",
  // ── strong room ──
  "STRONGROOM_ENTRY",
  "STRONGROOM_EXIT",
  "DWELL_EXCEEDED",
  "FOOTFALL_MISMATCH",
  // ── opening ceremony ──
  "SHARES_REWRAPPED",
  "CONTROL_ENVELOPE_ISSUED",
  "OPEN_CEREMONY",
  "PACKET_OPENED",
  "CEREMONY_INCOMPLETE",
  "PACKET_UNOPENED_OVERDUE",
  // ── the seam label ──
  "SEAM_DECODE_FAILED",
  "SEAM_MANUAL_OVERRIDE",
  "UNAUTHORIZED_SCAN",
  // ── device and enclosure integrity ──
  "DEVICE_SEQ_GAP",
  "ENCLOSURE_OPENED",
  "SEAL_LOCK_OPENED",
  "SEAL_LOCK_CLOSED",
  "ENROLMENT_COMPLETED",
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
  // Decided by a service after weighing checks, or raised by the watchdog when
  // nothing happened at all. A device may report what it observed; it may not
  // report the conclusion drawn from what it observed.
  "HANDOVER_COMPLETED",
  "HANDOVER_REFUSED",
  "LEG_OVERDUE",
  "DWELL_EXCEEDED",
  "FOOTFALL_MISMATCH",
  "SHARES_REWRAPPED",
  "CONTROL_ENVELOPE_ISSUED",
  "CEREMONY_INCOMPLETE",
  "PACKET_UNOPENED_OVERDUE",
  "DEVICE_SEQ_GAP",
  "UNAUTHORIZED_SCAN",
]);

// ── payloads ────────────────────────────────────────────────────────────────

export const PackageSealedPayload = z.object({
  copies: z.number().int().positive().max(10_000),
  ciphertextSha256: Sha256Hex,
  /** drand quicknet round the timelock share is bound to. See docs/11. */
  drandRound: z.number().int().positive(),
  /** One commitment per Shamir share, so share release can be audited later. */
  shareCommitments: z.array(Sha256Hex).length(4),
  /**
   * sha256(seamToken ‖ packageId) for the QR printed across the opening flap.
   *
   * Optional because packages sealed before the seam label existed have no such
   * commitment and their events must keep validating — an optional field that is
   * omitted, never null, so the canonical bytes of an old event are unchanged.
   * A package without this commitment reports the seam check as not evaluated
   * rather than passing it. See `docs/13`.
   */
  seamCommitment: Sha256Hex.optional(),
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
  /**
   * The seam token as read from the flap QR, hex.
   *
   * Hostile input: it arrives from a camera pointed at a surface anyone could
   * have printed, so it is shape-checked here and never interpolated anywhere.
   * Absent means the code could not be read — which is the expected state for a
   * package that was opened in transit, and also for one left out in the rain.
   * The engine distinguishes those two; this field does not.
   */
  seamTokenRead: z.string().regex(/^[0-9a-f]{64}$/).optional(),
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

// ── hand-off legs ───────────────────────────────────────────────────

/**
 * One planned leg of the journey, named the same way on both sides of it.
 *
 * `legId` is the join between a dispatch and an acceptance that may be hours
 * apart and recorded by two different devices, so it is carried on every event
 * in the leg rather than reconstructed from timestamps afterwards.
 */
export const HandoverInitiatedPayload = z.object({
  legId: Uuid,
  legNo: z.number().int().positive(),
  fromPersonId: Uuid,
  fromRole: PersonRole,
  toRole: PersonRole,
  seamId: ShortText,
  /** Slot and score from the reader; never an image and never a template. */
  biometricSlot: z.number().int().nonnegative(),
  biometricScore: z.number().int().nonnegative(),
  /** The transfer key itself never appears in an event. Only that one was
   *  issued, and when it stops being usable. */
  transferKeyIssuedAt: Timestamp,
  transferKeyExpiresAt: Timestamp,
  expectedBy: Timestamp,
});

export const HandoverCompletedPayload = z.object({
  legId: Uuid,
  legNo: z.number().int().positive(),
  fromPersonId: Uuid,
  toPersonId: Uuid,
  fromRole: PersonRole,
  toRole: PersonRole,
  seamId: ShortText,
  packetSerial: ShortText,
  biometricSlot: z.number().int().nonnegative(),
  biometricScore: z.number().int().nonnegative(),
  toState: PackageState,
  /** How late the leg closed against its plan. Negative is early. Recorded even
   *  when it is zero, because "on time" only means something if lateness is kept. */
  lateBySeconds: z.number().int(),
});

/**
 * A refused acceptance, with every check that was run.
 *
 * The refusal is the product here. A leg that cannot complete is a leg someone
 * has to explain, and the explanation has to be reconstructable from this
 * record alone months later — hence the reasons and the evidence, not a boolean.
 */
export const HandoverRefusedPayload = z.object({
  legId: Uuid,
  legNo: z.number().int().positive(),
  attemptedByPersonId: Uuid.optional(),
  seamId: ShortText.optional(),
  packetSerialTyped: ShortText.optional(),
  denyReasons: z.array(DenyReason).min(1),
  /** One line per check: what was looked at and what was seen. */
  evidence: z.array(ShortText).min(1),
  /** How many acceptance attempts this leg has now refused. Three raises an alert. */
  attemptNo: z.number().int().positive(),
});

export const LegOverduePayload = z.object({
  legId: Uuid,
  legNo: z.number().int().positive(),
  expectedBy: Timestamp,
  overdueBySeconds: z.number().int().positive(),
  lastEventKind: ShortText,
  lastSeenPersonId: Uuid.optional(),
});

export const StoredPayload = z.object({
  roomId: Uuid,
  custodianPersonId: Uuid,
  sealSerial: ShortText,
});

export const ReleasedPayload = z.object({
  roomId: Uuid,
  custodianPersonId: Uuid,
  toLegId: Uuid,
});

// ── strong room ─────────────────────────────────────────────────────

/**
 * The door, not the packet.
 *
 * Every entry and exit is recorded even when nothing is touched, because a room
 * whose visits are recorded only when something is moved cannot answer "who was
 * in there at 03:00" — which is the question an enquiry actually asks.
 */
export const StrongroomEntryPayload = z.object({
  visitId: Uuid,
  roomId: Uuid,
  personIds: z.array(Uuid).length(2),
  /** Seconds between the two biometric confirmations. The window is 120 s. */
  secondsBetweenConfirmations: z.number().int().nonnegative(),
  biometricSlots: z.array(z.number().int().nonnegative()).length(2),
  faceMatched: z.array(z.boolean()).length(2),
  expectedMinutes: z.number().int().positive(),
});

export const StrongroomExitPayload = z.object({
  visitId: Uuid,
  roomId: Uuid,
  personIds: z.array(Uuid).min(1),
  dwellSeconds: z.number().int().nonnegative(),
  packagesTouched: z.number().int().nonnegative(),
});

export const DwellExceededPayload = z.object({
  visitId: Uuid,
  roomId: Uuid,
  dwellSeconds: z.number().int().positive(),
  expectedSeconds: z.number().int().positive(),
});

export const FootfallMismatchPayload = z.object({
  visitId: Uuid,
  roomId: Uuid,
  authorisedEntrants: z.number().int().nonnegative(),
  countedAtLeast: z.number().int().nonnegative(),
  monitorId: Uuid,
});

// ── opening ceremony ────────────────────────────────────────────────

export const SharesRewrappedPayload = z.object({
  centreId: Uuid,
  examSession: ShortText,
  /** Role to the device the share is now readable by. No share material here. */
  rewrapped: z
    .array(z.object({ role: PersonRole, personId: Uuid, deviceId: Uuid }))
    .min(1),
  rosterLockedAt: Timestamp,
});

export const ControlEnvelopeIssuedPayload = z.object({
  packageId: Uuid,
  /** The drand round the envelope opens at. Anyone can check when that is. */
  drandRound: z.number().int().positive(),
  drandChainHash: Sha256Hex,
  scheduledOpenAt: Timestamp,
  ciphertextSha256: Sha256Hex,
  stationDeviceId: Uuid,
});

export const OpenCeremonyPayload = z.object({
  ceremonyId: Uuid,
  packageId: Uuid,
  /** `live-authorized` reached the server; `envelope-authorized` opened from the
   *  cached timelock envelope with no network. The mode is itself evidence. */
  mode: z.enum(["live-authorized", "envelope-authorized"]),
  officials: z
    .array(
      z.object({
        personId: Uuid,
        role: PersonRole,
        institution: ShortText,
        biometricSlot: z.number().int().nonnegative(),
        biometricScore: z.number().int().nonnegative(),
        faceMatched: z.boolean(),
      }),
    )
    .length(2),
  secondsBetweenOfficials: z.number().int().nonnegative(),
  controlPartUsed: z.boolean(),
  drandRound: z.number().int().positive(),
});

export const PacketOpenedPayload = z.object({
  ceremonyId: Uuid,
  packageId: Uuid,
  packetSerial: ShortText,
  openedByPersonId: Uuid,
  photoSha256: Sha256Hex,
  candidateWitnesses: z.number().int().nonnegative(),
  /** Seconds before or after the scheduled start. Early is not forbidden; it is
   *  recorded, and a pattern of early openings is what gets looked at. */
  offsetFromScheduledSeconds: z.number().int(),
});

export const CeremonyIncompletePayload = z.object({
  ceremonyId: Uuid,
  packageId: Uuid,
  reachedStep: z.enum(["scan", "authorize", "identify", "confirm", "release"]),
  officialsConfirmed: z.number().int().nonnegative().max(3),
  deadline: Timestamp,
});

export const PacketUnopenedOverduePayload = z.object({
  packageId: Uuid,
  scheduledOpenAt: Timestamp,
  overdueBySeconds: z.number().int().positive(),
  centreId: Uuid,
});

// ── the seam label ─────────────────────────────────────────────────

export const SeamDecodeFailedPayload = z.object({
  seamIdTyped: ShortText.optional(),
  packageId: Uuid.optional(),
  /** How long the app tried before giving up. The procedure says 10 s. */
  attemptedSeconds: z.number().int().positive(),
  whichCodes: z.enum(["A", "B", "both"]),
  photoSha256: Sha256Hex,
});

export const SeamManualOverridePayload = z.object({
  packageId: Uuid,
  seamIdTyped: ShortText,
  approverPersonId: Uuid,
  /** The control room approves over live video, both field officers present. */
  approvalChannel: z.enum(["live-video"]),
  fieldPersonIds: z.array(Uuid).length(2),
  photoSha256: Sha256Hex,
  justification: LongText,
});

/**
 * A seam URL opened by something that is not an enrolled device.
 *
 * The scanner is told nothing — the landing page says only that the package is
 * under custody. This event is the whole point of that page.
 */
export const UnauthorizedScanPayload = z.object({
  seamId: ShortText,
  /** Which half was presented. Both halves from an unattested device is worse
   *  than one, and the difference has to survive into the record. */
  whichCodes: z.enum(["A", "B", "both"]),
  userAgent: ShortText.optional(),
  /** Coarse, from the request. Never a precise location for an unknown party. */
  approxRegion: ShortText.optional(),
  priorHitsOnThisSeam: z.number().int().nonnegative(),
});

// ── device and enclosure integrity ────────────────────────────────────

export const DeviceSeqGapPayload = z.object({
  deviceId: Uuid,
  lastSeenSeq: z.number().int().nonnegative(),
  receivedSeq: z.number().int().positive(),
  missingCount: z.number().int().positive(),
});

export const EnclosureOpenedPayload = z.object({
  deviceId: Uuid,
  sequence: z.number().int().nonnegative(),
  /** True the moment the tamper switch releases. The board reports it before it
   *  can be silenced, and the record stands even if the board never reports again. */
  tamperSwitchOpen: z.boolean(),
});

export const SealLockOpenedPayload = z.object({
  deviceId: Uuid,
  packageId: Uuid,
  /** The signed decision the board verified before it energised the solenoid. */
  decisionEventId: Uuid,
  reedSwitchClosed: z.boolean(),
});

export const SealLockClosedPayload = z.object({
  deviceId: Uuid,
  packageId: Uuid,
  openSeconds: z.number().int().nonnegative(),
  reedSwitchClosed: z.boolean(),
});

export const EnrolmentCompletedPayload = z.object({
  personId: Uuid,
  stationId: Uuid,
  slot: z.number().int().nonnegative(),
  /** Both enrolling officers, because an enrolment done by one person is how a
   *  finger gets onto the roster without anyone else seeing it happen. */
  enrollingOfficerIds: z.array(Uuid).length(2),
  matchScore: z.number().int().nonnegative(),
});

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
  HANDOVER_INITIATED: HandoverInitiatedPayload,
  HANDOVER_COMPLETED: HandoverCompletedPayload,
  HANDOVER_REFUSED: HandoverRefusedPayload,
  LEG_OVERDUE: LegOverduePayload,
  STORED: StoredPayload,
  RELEASED: ReleasedPayload,
  STRONGROOM_ENTRY: StrongroomEntryPayload,
  STRONGROOM_EXIT: StrongroomExitPayload,
  DWELL_EXCEEDED: DwellExceededPayload,
  FOOTFALL_MISMATCH: FootfallMismatchPayload,
  SHARES_REWRAPPED: SharesRewrappedPayload,
  CONTROL_ENVELOPE_ISSUED: ControlEnvelopeIssuedPayload,
  OPEN_CEREMONY: OpenCeremonyPayload,
  PACKET_OPENED: PacketOpenedPayload,
  CEREMONY_INCOMPLETE: CeremonyIncompletePayload,
  PACKET_UNOPENED_OVERDUE: PacketUnopenedOverduePayload,
  SEAM_DECODE_FAILED: SeamDecodeFailedPayload,
  SEAM_MANUAL_OVERRIDE: SeamManualOverridePayload,
  UNAUTHORIZED_SCAN: UnauthorizedScanPayload,
  DEVICE_SEQ_GAP: DeviceSeqGapPayload,
  ENCLOSURE_OPENED: EnclosureOpenedPayload,
  SEAL_LOCK_OPENED: SealLockOpenedPayload,
  SEAL_LOCK_CLOSED: SealLockClosedPayload,
  ENROLMENT_COMPLETED: EnrolmentCompletedPayload,
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
