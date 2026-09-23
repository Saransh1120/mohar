import { z } from "zod";

/** Roles that can appear as an actor on a custody event. */
export const PersonRole = z.enum([
  "superintendent",
  /** The board observer deputed from headquarters. Holds one field share. */
  "observer",
  /** State police escort officer. Holds one field share. */
  "police_escort",
  "custodian",
  "courier",
  /** Seals packets and applies the seam label at the press. */
  "press_operator",
  "district_officer",
  /** Runs the district biometric enrolment ceremony, always in a pair. */
  "enrolling_officer",
  /** The control room operator at board HQ, and the authority the mandatory
   *  part of the opening key belongs to. One role, because the person and the
   *  authority are never separated in a decision. */
  "control_room",
]);
export type PersonRole = z.infer<typeof PersonRole>;

/** Device classes. See adr/0003 — no MDM; identity comes from platform attestation. */
export const DeviceKind = z.enum([
  "field", // Android phone, Keystore-attested
  "centre_pc", // the centre's own Windows PC, TPM-bound
  "monitor", // ESP32 room monitor
  "service", // a backend service signing its own derived events
]);
export type DeviceKind = z.infer<typeof DeviceKind>;

/**
 * Package lifecycle. Transitions are enforced server-side; an event carrying an
 * unexpected predecessor state is refused rather than reconciled, because
 * silently accepting out-of-order custody is exactly how a gap gets papered over.
 */
export const PackageState = z.enum([
  "sealed",
  "in_transit",
  "at_custodian",
  "at_centre",
  "opened",
  "returned",
  "compromised",
]);
export type PackageState = z.infer<typeof PackageState>;

export const PACKAGE_STATE_TRANSITIONS: Readonly<
  Record<PackageState, readonly PackageState[]>
> = Object.freeze({
  sealed: ["in_transit", "compromised"],
  in_transit: ["at_custodian", "at_centre", "compromised"],
  at_custodian: ["in_transit", "at_centre", "compromised"],
  at_centre: ["opened", "compromised"],
  opened: ["returned", "compromised"],
  returned: ["compromised"],
  // Terminal. Once a package is presumed compromised nothing un-compromises it;
  // only a human decision recorded outside the package lifecycle can clear it.
  compromised: [],
});

export const canTransition = (from: PackageState, to: PackageState): boolean =>
  PACKAGE_STATE_TRANSITIONS[from].includes(to);

/**
 * Why an access request was refused.
 *
 * These are a closed set on purpose. Denials are the highest-value signal the
 * system produces (docs/05-unlock-protocol.md), and free-text reasons cannot be
 * aggregated across a state-wide sweep.
 */
export const DenyReason = z.enum([
  // ── custody key ──
  "key_not_presented",
  "key_unknown",
  "key_wrong_stage",
  "key_wrong_package",
  "key_expired",
  "key_not_yet_valid",
  "key_revoked",
  // ── device ──
  "device_unknown",
  "device_revoked",
  "device_not_bound_to_centre",
  "device_attestation_invalid",
  /** A device's records skipped a sequence number. Something was written that
   *  never arrived, which is a gap in the account rather than a transport hiccup. */
  "device_seq_gap",
  // ── person ──
  "person_not_on_roster",
  "person_role_not_permitted",
  /** Two field shares offered by officials from the same institution. The
   *  2-of-3 split exists to force two institutions, not merely two people. */
  "same_institution_pair",
  "roster_not_locked",
  // ── assertion freshness ──
  "assertion_stale",
  "assertion_nonce_mismatch",
  // ── place ──
  "outside_geofence",
  "geo_missing",
  "geo_accuracy_insufficient",
  // ── time ──
  "outside_custody_window",
  "clock_skew_excessive",
  "leg_not_scheduled",
  "leg_window_closed",
  /** The control room's part is time-locked to a drand round that has not been
   *  published yet. Nobody can shorten this wait, including the control room. */
  "control_part_still_locked",
  // ── the physical packet ──
  "seal_serial_mismatch",
  "seal_serial_not_read",
  "seal_photo_missing",
  /** The receiver typed a packet serial that is not this packet's. */
  "packet_serial_mismatch",
  "seal_lock_open",
  // The seam seal. Absent and mismatched are deliberately separate: a token that
  // could not be read is ambiguous and routes to a witnessed manual ceremony,
  // while a token that read cleanly and did not match is evidence. Collapsing
  // them would make a rain-damaged label indistinguishable from a forged one.
  "seam_token_absent",
  "seam_token_mismatch",
  "seam_decode_failed",
  // ── transfer key ──
  "transfer_key_not_presented",
  "transfer_key_mismatch",
  "transfer_key_expired",
  // ── package and exam ──
  "package_state_unexpected",
  "package_already_opened",
  "package_compromised",
  "exam_suspended",
  "duplicate_session",
  // ── hardware, evaluated only at the unlock stage ──
  "biometric_primary_missing",
  "biometric_secondary_missing",
  "two_person_window_not_met",
  "occupancy_contradicts_two_person",
  "witness_frame_missing",
]);
export type DenyReason = z.infer<typeof DenyReason>;

/** Operating mode. Digital mode is only permitted where the throughput check passes. */
export const ExamMode = z.enum(["digital", "escorted"]);
export type ExamMode = z.infer<typeof ExamMode>;
