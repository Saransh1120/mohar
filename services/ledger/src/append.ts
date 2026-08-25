import type { PoolClient } from "pg";
import {
  SignedEvent,
  COSIGN_REQUIRED_KINDS,
  SERVICE_ONLY_KINDS,
  type EventBody,
  type LedgerRecord,
} from "@mohar/contracts";
import {
  bodyHash,
  chainHashFromHashes,
  verifyBodySignature,
  GENESIS_HASH,
} from "@mohar/crypto-core";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

/**
 * ── The one principle this module exists to enforce ──────────────────────────
 *
 * The ledger NEVER refuses to record something that actually happened.
 *
 * It rejects only what it cannot *authenticate*: an unknown device, a bad
 * signature, a malformed body. It does not reject events that violate business
 * policy — an out-of-order handoff, a package opened outside its window, an
 * override of a denial. Those get recorded and flagged.
 *
 * This is deliberate and it is the opposite of the usual instinct. Refusing to
 * record a policy violation does not prevent the violation; it only removes the
 * evidence of it, recreating exactly the invisible gap the whole system exists
 * to eliminate. Policy decisions belong to `access`; the ledger's job is to be
 * an honest witness, including to things that should not have happened.
 */

export type AppendRejection =
  | { code: "schema_invalid"; detail: string }
  | { code: "device_unknown"; deviceId: string }
  | { code: "device_revoked"; deviceId: string; revokedAt: string }
  | { code: "signature_invalid"; which: "device" | "cosign" }
  | { code: "cosign_required"; kind: string }
  | { code: "cosign_same_device"; deviceId: string }
  | { code: "service_only_kind"; kind: string; deviceKind: string };

export type AppendOutcome =
  | { status: "appended"; record: LedgerRecord; flags: PolicyFlag[] }
  | { status: "duplicate"; record: LedgerRecord }
  | { status: "rejected"; rejection: AppendRejection };

/** Advisory observations attached to an accepted event. Never a reason to refuse. */
export interface PolicyFlag {
  code:
    | "clock_skew_excessive"
    | "occurred_in_future"
    | "geo_missing"
    | "geo_accuracy_poor"
    | "backdated_beyond_window";
  detail: string;
}

const MAX_TOLERATED_SKEW_MS = 5 * 60 * 1000;
const MAX_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000; // offline queues can be days old
const POOR_ACCURACY_M = 100;

interface DeviceRow {
  id: string;
  kind: string;
  pubkey: Buffer;
  revoked_at: Date | null;
}

/**
 * Append one signed event.
 *
 * Must be called inside a transaction. Takes a transaction-scoped advisory lock
 * so that concurrent appends serialise: the hash chain has exactly one tail, and
 * two writers reading the same `prev_hash` would fork it. The lock is released
 * automatically at commit or rollback.
 */
export async function appendEvent(
  tx: PoolClient,
  input: unknown,
): Promise<AppendOutcome> {
  const parsed = SignedEvent.safeParse(input);
  if (!parsed.success) {
    return {
      status: "rejected",
      rejection: { code: "schema_invalid", detail: parsed.error.message },
    };
  }
  const signed = parsed.data as {
    body: EventBody;
    deviceSig: string;
    cosignDeviceId?: string;
    cosignSig?: string;
  };
  const { body } = signed;

  // ── idempotency ──
  // A field app replaying its offline queue after a flaky sync must not create a
  // second copy. Returning the existing record (not an error) keeps the client's
  // retry loop simple, which matters when the client is a phone with no signal.
  const existing = await findByEventId(tx, body.id);
  if (existing) return { status: "duplicate", record: existing };

  // ── authenticate the emitting device ──
  const device = await loadDevice(tx, body.actorDeviceId);
  if (!device) {
    return {
      status: "rejected",
      rejection: { code: "device_unknown", deviceId: body.actorDeviceId },
    };
  }
  if (device.revoked_at) {
    return {
      status: "rejected",
      rejection: {
        code: "device_revoked",
        deviceId: device.id,
        revokedAt: device.revoked_at.toISOString(),
      },
    };
  }

  if (SERVICE_ONLY_KINDS.has(body.kind) && device.kind !== "service") {
    return {
      status: "rejected",
      rejection: {
        code: "service_only_kind",
        kind: body.kind,
        deviceKind: device.kind,
      },
    };
  }

  if (!verifyBodySignature(body, signed.deviceSig, bytesToHex(device.pubkey))) {
    return { status: "rejected", rejection: { code: "signature_invalid", which: "device" } };
  }

  // ── the second signature, where two people are required ──
  if (COSIGN_REQUIRED_KINDS.has(body.kind)) {
    if (!signed.cosignDeviceId || !signed.cosignSig) {
      return { status: "rejected", rejection: { code: "cosign_required", kind: body.kind } };
    }
    // Two signatures from one device is one person tapping twice. The whole
    // point of a two-person rule is that it is two people.
    if (signed.cosignDeviceId === body.actorDeviceId) {
      return {
        status: "rejected",
        rejection: { code: "cosign_same_device", deviceId: body.actorDeviceId },
      };
    }
    const cosigner = await loadDevice(tx, signed.cosignDeviceId);
    if (!cosigner) {
      return {
        status: "rejected",
        rejection: { code: "device_unknown", deviceId: signed.cosignDeviceId },
      };
    }
    if (cosigner.revoked_at) {
      return {
        status: "rejected",
        rejection: {
          code: "device_revoked",
          deviceId: cosigner.id,
          revokedAt: cosigner.revoked_at.toISOString(),
        },
      };
    }
    if (!verifyBodySignature(body, signed.cosignSig, bytesToHex(cosigner.pubkey))) {
      return {
        status: "rejected",
        rejection: { code: "signature_invalid", which: "cosign" },
      };
    }
  }

  // ── observations (recorded, never grounds for refusal) ──
  const receivedAt = new Date();
  const occurredAt = new Date(body.occurredAt);
  const skewMs = occurredAt.getTime() - receivedAt.getTime();
  const flags = collectFlags(body, skewMs);

  // ── chain ──
  // One tail, one writer. hashtext() of a fixed string gives a stable lock key.
  await tx.query("select pg_advisory_xact_lock(hashtext('led.event.chain'))");
  const prevHash = await loadChainTail(tx);

  const bh = bodyHash(body);
  const h = chainHashFromHashes(prevHash, bh);

  const inserted = await tx.query<{ seq: string; received_at: Date }>(
    `insert into led.event (
       id, exam_id, package_id, centre_id, kind,
       occurred_at, received_at, clock_skew_ms,
       actor_person, actor_device,
       lat, lon, geo_accuracy_m,
       body, device_sig, cosign_device, cosign_sig,
       body_hash, prev_hash, hash
     ) values (
       $1,$2,$3,$4,$5,
       $6,$7,$8,
       $9,$10,
       $11,$12,$13,
       $14,$15,$16,$17,
       $18,$19,$20
     ) returning seq, received_at`,
    [
      body.id,
      body.examId,
      body.packageId ?? null,
      body.centreId ?? null,
      body.kind,
      occurredAt,
      receivedAt,
      skewMs,
      body.actorPersonId ?? null,
      body.actorDeviceId,
      body.geo?.lat ?? null,
      body.geo?.lon ?? null,
      body.geo?.accuracyM ?? null,
      body,
      Buffer.from(hexToBytes(signed.deviceSig)),
      signed.cosignDeviceId ?? null,
      signed.cosignSig ? Buffer.from(hexToBytes(signed.cosignSig)) : null,
      Buffer.from(bh),
      Buffer.from(prevHash),
      Buffer.from(h),
    ],
  );

  const row = inserted.rows[0]!;
  return {
    status: "appended",
    flags,
    record: {
      seq: row.seq,
      body,
      deviceSig: signed.deviceSig,
      ...(signed.cosignDeviceId ? { cosignDeviceId: signed.cosignDeviceId } : {}),
      ...(signed.cosignSig ? { cosignSig: signed.cosignSig } : {}),
      receivedAt: row.received_at.toISOString(),
      clockSkewMs: skewMs,
      bodyHash: bytesToHex(bh),
      prevHash: bytesToHex(prevHash),
      hash: bytesToHex(h),
    },
  };
}

function collectFlags(body: EventBody, skewMs: number): PolicyFlag[] {
  const flags: PolicyFlag[] = [];

  if (skewMs > MAX_TOLERATED_SKEW_MS) {
    flags.push({
      code: "occurred_in_future",
      detail: `device clock is ${Math.round(skewMs / 1000)}s ahead of the server`,
    });
  } else if (-skewMs > MAX_TOLERATED_SKEW_MS && -skewMs <= MAX_BACKDATE_MS) {
    // Normal for an offline queue draining after hours without signal.
    flags.push({
      code: "clock_skew_excessive",
      detail: `event is ${Math.round(-skewMs / 1000)}s old; expected for an offline sync`,
    });
  } else if (-skewMs > MAX_BACKDATE_MS) {
    flags.push({
      code: "backdated_beyond_window",
      detail: `event claims to be ${Math.round(-skewMs / 86_400_000)} days old`,
    });
  }

  if (!body.geo) {
    flags.push({ code: "geo_missing", detail: "no position fix accompanied this event" });
  } else if (body.geo.accuracyM > POOR_ACCURACY_M) {
    flags.push({
      code: "geo_accuracy_poor",
      detail: `fix accurate only to ${Math.round(body.geo.accuracyM)}m`,
    });
  }

  return flags;
}

async function loadDevice(tx: PoolClient, id: string): Promise<DeviceRow | null> {
  const r = await tx.query<DeviceRow>(
    "select id, kind, pubkey, revoked_at from ref.device where id = $1",
    [id],
  );
  return r.rows[0] ?? null;
}

async function loadChainTail(tx: PoolClient): Promise<Uint8Array> {
  const r = await tx.query<{ hash: Buffer }>(
    "select hash from led.event order by seq desc limit 1",
  );
  const tail = r.rows[0];
  return tail ? new Uint8Array(tail.hash) : GENESIS_HASH;
}

async function findByEventId(
  tx: PoolClient,
  id: string,
): Promise<LedgerRecord | null> {
  const r = await tx.query(
    `select seq, body, device_sig, cosign_device, cosign_sig,
            received_at, clock_skew_ms, body_hash, prev_hash, hash
       from led.event where id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    seq: row.seq,
    body: row.body as EventBody,
    deviceSig: bytesToHex(new Uint8Array(row.device_sig)),
    ...(row.cosign_device ? { cosignDeviceId: row.cosign_device as string } : {}),
    ...(row.cosign_sig
      ? { cosignSig: bytesToHex(new Uint8Array(row.cosign_sig)) }
      : {}),
    receivedAt: (row.received_at as Date).toISOString(),
    clockSkewMs: Number(row.clock_skew_ms),
    bodyHash: bytesToHex(new Uint8Array(row.body_hash)),
    prevHash: bytesToHex(new Uint8Array(row.prev_hash)),
    hash: bytesToHex(new Uint8Array(row.hash)),
  };
}
