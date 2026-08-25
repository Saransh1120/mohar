import { z } from "zod";

/** Roles that can appear as an actor on a custody event. */
export const PersonRole = z.enum([
  "superintendent",
  "observer",
  "custodian",
  "courier",
  "district_officer",
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
  "device_unknown",
  "device_revoked",
  "device_attestation_invalid",
  "person_not_on_roster",
  "person_role_not_permitted",
  "assertion_stale",
  "assertion_nonce_mismatch",
  "outside_geofence",
  "geo_accuracy_insufficient",
  "geo_missing",
  "outside_custody_window",
  "clock_skew_excessive",
  "seal_serial_mismatch",
  "seal_photo_missing",
  "package_state_unexpected",
  "package_already_opened",
  "package_compromised",
  "exam_suspended",
  "duplicate_session",
]);
export type DenyReason = z.infer<typeof DenyReason>;

/** Operating mode. Digital mode is only permitted where the throughput check passes. */
export const ExamMode = z.enum(["digital", "escorted"]);
export type ExamMode = z.infer<typeof ExamMode>;
