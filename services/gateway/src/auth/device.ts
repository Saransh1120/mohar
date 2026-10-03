import {
  REQUEST_SIGNATURE_HEADERS as H,
  verifyBodySignature,
  verifyRequestSignature,
} from "@mohar/crypto-core";
import type { Upstream } from "../upstream.js";

/**
 * ── Which device is asking ───────────────────────────────────────────────────
 *
 * Two ways a device proves itself, both with the Ed25519 key it was enrolled
 * with:
 *
 *  - a **signed request**: four headers over the method, path, time, a nonce
 *    and the body's hash (`request-signature.ts` in crypto-core);
 *  - a **signed event**: the body is the event and carries its own signature,
 *    which is what the room monitor and the field app already send.
 *
 * The device's public key comes from the ledger's register, read through
 * `GET /devices/:id` and kept for a few seconds. A revoked device is refused
 * here within that time, and by the ledger immediately for anything that
 * reaches the chain.
 *
 * Like the engines behind it, a refusal says what was found rather than only
 * that it failed: the skew in seconds, which header was missing, when the
 * device was revoked.
 */

export interface DeviceRecord {
  id: string;
  kind: string;
  /** Ed25519 public key, 64 hex. */
  pubkey: string;
  revokedAt: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DeviceDirectory {
  private readonly cache = new Map<string, { device: DeviceRecord | null; until: number }>();

  constructor(
    private readonly upstream: Upstream,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async lookup(id: string): Promise<DeviceRecord | null> {
    // The id goes into a URL. Anything that is not a uuid is not a device.
    if (!UUID.test(id)) return null;
    const key = id.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return hit.device;

    const res = await this.upstream.getJson(`/devices/${key}`);
    if (res.status !== 200 && res.status !== 404) {
      throw new Error(`the ledger answered ${res.status} to a device lookup`);
    }
    const d = res.status === 200 ? (res.json as Record<string, unknown> | null) : null;
    const device: DeviceRecord | null =
      d && typeof d["id"] === "string" && typeof d["pubkey"] === "string"
        ? {
            id: d["id"],
            kind: typeof d["kind"] === "string" ? d["kind"] : "unknown",
            pubkey: d["pubkey"],
            revokedAt: typeof d["revokedAt"] === "string" ? d["revokedAt"] : null,
          }
        : null;
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(key, { device, until: this.now() + this.ttlMs });
    return device;
  }

  forget(id: string): void {
    this.cache.delete(id.toLowerCase());
  }
}

/** Nonces already used, kept for as long as their request could still be inside the skew bound. */
export class NonceWindow {
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True the first time a (device, nonce) pair is offered; false on a replay. */
  claim(deviceId: string, nonce: string, keepMs: number): boolean {
    const now = this.now();
    if (this.seen.size > 50_000) {
      for (const [k, until] of this.seen) if (until <= now) this.seen.delete(k);
    }
    const key = `${deviceId.toLowerCase()}:${nonce}`;
    const until = this.seen.get(key);
    if (until !== undefined && until > now) return false;
    this.seen.set(key, now + keepMs);
    return true;
  }
}

export type DeviceRefusal =
  | "signature_headers_incomplete"
  | "timestamp_unreadable"
  | "clock_skew"
  | "nonce_malformed"
  | "device_unknown"
  | "device_revoked"
  | "signature_invalid"
  | "nonce_replayed"
  | "event_unreadable";

export type DeviceVerdict =
  | { ok: true; device: DeviceRecord }
  | { ok: false; reasons: DeviceRefusal[]; detail: Record<string, unknown> };

type Headers = Record<string, string | string[] | undefined>;

/** Whether the request carries any of the four signature headers at all. */
export function hasSignatureHeaders(headers: Headers): boolean {
  return Object.values(H).some((name) => headers[name] !== undefined);
}

/**
 * Check a signed request. Every check that can be made is made, so a refusal
 * names all of what was wrong: a revoked device with a stale clock is two
 * findings, and the second would otherwise only surface after the first was
 * fixed.
 */
export async function verifySignedRequest(
  input: { method: string; rawUrl: string; headers: Headers; body: Buffer },
  directory: DeviceDirectory,
  nonces: NonceWindow,
  skewMs: number,
  now: number,
): Promise<DeviceVerdict> {
  const one = (name: string) => {
    const v = input.headers[name];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  const deviceId = one(H.device);
  const timestamp = one(H.timestamp);
  const nonce = one(H.nonce);
  const signature = one(H.signature);

  const missing = [
    [H.device, deviceId],
    [H.timestamp, timestamp],
    [H.nonce, nonce],
    [H.signature, signature],
  ]
    .filter(([, v]) => v === null)
    .map(([name]) => name);
  if (!deviceId || !timestamp || !nonce || !signature) {
    return { ok: false, reasons: ["signature_headers_incomplete"], detail: { missing } };
  }

  const reasons: DeviceRefusal[] = [];
  const detail: Record<string, unknown> = { deviceId };

  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) {
    reasons.push("timestamp_unreadable");
  } else {
    const skewSeconds = Math.round((at - now) / 1000);
    if (Math.abs(at - now) > skewMs) {
      reasons.push("clock_skew");
      detail["skewSeconds"] = skewSeconds;
      detail["limitSeconds"] = Math.round(skewMs / 1000);
    }
  }

  if (!/^[0-9a-f]{32}$/.test(nonce)) reasons.push("nonce_malformed");

  const device = await directory.lookup(deviceId);
  if (!device) {
    reasons.push("device_unknown");
  } else {
    if (device.revokedAt) {
      reasons.push("device_revoked");
      detail["revokedAt"] = device.revokedAt;
    }
    const valid = verifyRequestSignature(
      { method: input.method, path: input.rawUrl, timestamp, nonce, body: input.body },
      signature,
      device.pubkey,
    );
    if (!valid) reasons.push("signature_invalid");
  }

  if (reasons.length > 0 || !device) return { ok: false, reasons, detail };

  // Claimed last, and only by a request that verified: a nonce is spent by the
  // device that owns it, never by someone guessing at its id.
  if (!nonces.claim(device.id, nonce, skewMs * 2)) {
    return { ok: false, reasons: ["nonce_replayed"], detail };
  }
  return { ok: true, device };
}

interface MaybeSigned {
  body?: { actorDeviceId?: unknown };
  deviceSig?: unknown;
}

/** How many events of a batch are looked at for one that verifies. */
const BATCH_LOOK = 20;

/**
 * Check a signed event, or a batch of them.
 *
 * The ledger authenticates every event again when it appends it, and decides
 * each event of a batch on its own. What is settled here is only whether the
 * sender holds an enrolled device's key at all: a batch is let through on the
 * first event that verifies, and counted against that device.
 */
export async function verifySignedEvent(
  body: Buffer,
  directory: DeviceDirectory,
): Promise<DeviceVerdict> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { ok: false, reasons: ["event_unreadable"], detail: { found: "a body that is not JSON" } };
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed.slice(0, BATCH_LOOK) : [parsed];
  if (items.length === 0) {
    return { ok: false, reasons: ["event_unreadable"], detail: { found: "an empty batch" } };
  }

  const reasons = new Set<DeviceRefusal>();
  const detail: Record<string, unknown> = {};
  for (const item of items) {
    const ev = item as MaybeSigned | null;
    const deviceId = ev?.body?.actorDeviceId;
    const sig = ev?.deviceSig;
    if (typeof deviceId !== "string" || typeof sig !== "string") {
      reasons.add("event_unreadable");
      detail["found"] = "a body with no actorDeviceId or no deviceSig";
      continue;
    }
    detail["deviceId"] = deviceId;
    const device = await directory.lookup(deviceId);
    if (!device) {
      reasons.add("device_unknown");
      continue;
    }
    if (device.revokedAt) {
      reasons.add("device_revoked");
      detail["revokedAt"] = device.revokedAt;
      continue;
    }
    if (!verifyBodySignature(ev?.body, sig, device.pubkey)) {
      reasons.add("signature_invalid");
      continue;
    }
    return { ok: true, device };
  }
  return { ok: false, reasons: [...reasons], detail };
}
