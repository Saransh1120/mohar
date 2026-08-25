import { z } from "zod";

/**
 * Shared scalar shapes. Everything the ledger signs is built from these, so the
 * constraints here are load-bearing: a value that passes validation must be
 * byte-stable under RFC 8785 canonicalisation, or signatures will not verify
 * after a database round-trip.
 */

export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

/** Lowercase hex, even length. We never accept mixed case: it would canonicalise
 *  to a different byte string and break signature verification. */
export const Hex = (bytes?: number) =>
  z
    .string()
    .regex(/^[0-9a-f]*$/, "must be lowercase hex")
    .refine(
      (s) => s.length % 2 === 0,
      "hex string must have an even number of characters",
    )
    .refine(
      (s) => bytes === undefined || s.length === bytes * 2,
      (s) => ({ message: `expected ${bytes} bytes (${bytes! * 2} hex chars), got ${s.length / 2}` }),
    );

export const Sha256Hex = Hex(32);
export const Ed25519PublicKeyHex = Hex(32);
export const Ed25519SignatureHex = Hex(64);

/**
 * Strict RFC 3339 UTC with millisecond precision, always `Z`.
 *
 * We pin the format rather than accepting anything Date can parse because the
 * timestamp is inside the signed body. `2026-08-19T04:30:00Z` and
 * `2026-08-19T04:30:00.000Z` denote the same instant but are different bytes,
 * and only one of them can be the one the device signed.
 */
export const Timestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "must be RFC 3339 UTC with exactly 3 fractional digits, e.g. 2026-08-19T04:30:00.000Z",
  )
  .refine((s) => !Number.isNaN(Date.parse(s)), "not a real instant");
export type Timestamp = z.infer<typeof Timestamp>;

export const toTimestamp = (d: Date): Timestamp => d.toISOString();

/**
 * A position fix. `accuracyM` is the reported horizontal accuracy radius; the
 * access policy rejects fixes too imprecise to place a device inside a geofence,
 * so it is required rather than optional.
 */
export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().max(100_000),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

/** Free-text captured from a human. Bounded so a signed body cannot be unbounded. */
export const ShortText = z.string().min(1).max(280);
export const LongText = z.string().min(1).max(4_000);
