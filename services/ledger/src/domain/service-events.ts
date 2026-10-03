import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { EventBody, EventKind } from "@mohar/contracts";
import { generateKeypair, publicKeyHexOf, signBody, type Keypair } from "@mohar/crypto-core";
import { appendEvent } from "../append.js";

/**
 * ── What the engines rule, on the chain ──────────────────────────────────────
 *
 * The hand-off, strong room, opening and watchdog engines each write their own
 * append-only table. Those rows are the record of the attempt and they are
 * written first. This module adds the second thing: a signed event in
 * `led.event`, so that what an engine ruled is in the same hash chain as what
 * the devices reported, and is covered by the same daily Merkle root.
 *
 * The ledger signs these as a device of kind `service`. `appendEvent` already
 * refuses the conclusion kinds (HANDOVER_COMPLETED, LEG_OVERDUE, ...) from any
 * other kind of device, so a phone cannot report its own hand-off as complete.
 *
 * ── The key ──
 *
 * `LEDGER_SERVICE_KEY` (64 hex, an Ed25519 private key) keeps one identity
 * across restarts. Without it a key is generated for the life of the process
 * and never written anywhere: each boot is then a new service device, which is
 * visible in `ref.device` and costs nothing in what the chain proves.
 *
 * ── When an event cannot be written ──
 *
 * The engine's own row stands. An event that the contract cannot express (a
 * room attached to no centre has no exam to file under; a leg whose packet has
 * no label has no seam id) is reported back as not recorded, with the reason,
 * and the caller logs it. It never rolls back the attempt it describes.
 */

type BodyOf<K extends EventKind> = Extract<EventBody, { kind: K }>;

export interface ServiceEvent<K extends EventKind> {
  kind: K;
  examId: string;
  packageId?: string | null | undefined;
  centreId?: string | null | undefined;
  /** Only a person registered in ref.person; the column is a foreign key. */
  actorPersonId?: string | null | undefined;
  occurredAt?: Date | undefined;
  payload: BodyOf<K>["payload"];
}

export type ChainEventOutcome =
  | { recorded: true; eventId: string; seq: string; kind: EventKind }
  | { recorded: false; kind: EventKind; reason: string };

export function notRecorded(kind: EventKind, reason: string): ChainEventOutcome {
  return { recorded: false, kind, reason };
}

type KeyState = { key: Keypair } | { error: string };
let keyState: KeyState | undefined;

function serviceKey(): KeyState {
  if (keyState) return keyState;
  const fromEnv = process.env["LEDGER_SERVICE_KEY"]?.trim();
  if (!fromEnv) {
    keyState = { key: generateKeypair() };
  } else if (!/^[0-9a-f]{64}$/.test(fromEnv)) {
    keyState = { error: "LEDGER_SERVICE_KEY is set but is not 64 lowercase hex characters" };
  } else {
    keyState = { key: { privateKeyHex: fromEnv, publicKeyHex: publicKeyHexOf(fromEnv) } };
  }
  return keyState;
}

/** The public half, for anyone checking a service signature by hand. */
export function servicePublicKeyHex(): string | null {
  const state = serviceKey();
  return "key" in state ? state.key.publicKeyHex : null;
}

/**
 * The service's row in ref.device, made on first use.
 *
 * Looked up through the caller's transaction every time rather than remembered:
 * a remembered id from a transaction that later rolled back would name a device
 * that does not exist.
 */
async function serviceDeviceId(tx: PoolClient, publicKeyHex: string): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `with made as (
       insert into ref.device (kind, pubkey) values ('service', $1)
       on conflict (pubkey) do nothing
       returning id
     )
     select id from made
     union all
     select id from ref.device where pubkey = $1
     limit 1`,
    [Buffer.from(publicKeyHex, "hex")],
  );
  return rows[0]?.id ?? null;
}

/** Drop absent fields. A signed body carries no nulls and no undefineds. */
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined && v !== null) out[k] = compact(v);
    }
    return out;
  }
  return value;
}

/**
 * Sign one event as the ledger service and append it inside the caller's
 * transaction. Call it after the engine's own row is written.
 */
export async function appendServiceEvent<K extends EventKind>(
  tx: PoolClient,
  event: ServiceEvent<K>,
): Promise<ChainEventOutcome> {
  const state = serviceKey();
  if ("error" in state) return notRecorded(event.kind, state.error);

  // A failure here must not undo the attempt the event describes.
  await tx.query("savepoint service_event");
  try {
    const deviceId = await serviceDeviceId(tx, state.key.publicKeyHex);
    if (!deviceId) {
      await tx.query("release savepoint service_event");
      return notRecorded(event.kind, "the service device could not be registered");
    }

    const body = compact({
      v: 1,
      id: randomUUID(),
      examId: event.examId,
      packageId: event.packageId,
      centreId: event.centreId,
      occurredAt: (event.occurredAt ?? new Date()).toISOString(),
      actorDeviceId: deviceId,
      actorPersonId: event.actorPersonId,
      kind: event.kind,
      payload: event.payload,
    }) as { id: string };

    const outcome = await appendEvent(tx, {
      body,
      deviceSig: signBody(body, state.key.privateKeyHex),
    });
    await tx.query("release savepoint service_event");

    if (outcome.status === "rejected") {
      const r = outcome.rejection;
      return notRecorded(event.kind, "detail" in r ? `${r.code}: ${r.detail}` : r.code);
    }
    return { recorded: true, eventId: body.id, seq: outcome.record.seq, kind: event.kind };
  } catch (err) {
    await tx.query("rollback to savepoint service_event");
    return notRecorded(event.kind, err instanceof Error ? err.message : String(err));
  }
}

/** One line per check, short enough for a signed payload. */
export function checkLines(
  checks: readonly { check: string; passed: boolean | undefined; evidence: string }[],
): string[] {
  return checks.map((c) => {
    const verdict = c.passed === undefined ? "not evaluated" : c.passed ? "passed" : "failed";
    return `${c.check}: ${verdict}. ${c.evidence}`.slice(0, 280);
  });
}
