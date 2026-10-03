import type { Pool, PoolClient } from "pg";

/**
 * ── The video call an override is approved over ──────────────────────────────
 *
 * The officer at the packet holds a phone up to it. Each of the two control
 * room operators opens a call to that phone from the Overrides page, sees the
 * packet and both officers, and only then decides. This module is the two
 * things the ledger does about that call: it carries the set-up messages
 * between the two ends, and it judges, from what it recorded, whether an
 * operator approving a request had a call with the phone that made it.
 *
 * ── What the ledger can and cannot know ──
 *
 * The picture and sound go from the phone to the operator's browser directly
 * (WebRTC, peer to peer). The ledger never carries them and cannot see them.
 * What it has is:
 *
 *   - what it handled itself: that the phone's offer was carried to this
 *     operator and this operator's answer carried back;
 *   - what each end said, authenticated as that end: the operator's browser
 *     that it connected and decoded video frames, the phone that it connected
 *     to this operator.
 *
 * So the record shows that a call was set up between these two and that both
 * ends report it carried video. It does not show what was in the picture. That
 * is still the operator's statement, and the decision still records it as one.
 *
 * ── The set-up messages ──
 *
 * Held in memory, one mailbox per end, for the life of the process. They are
 * connection descriptions with a lifetime of seconds, not evidence; the rows in
 * led.override_call are the evidence. One ledger process is assumed, as it is
 * for the gateway's limits: two would each hold half a conversation.
 */

/** An approval counts a call that connected this recently. */
export const CALL_FRESH_MS = 15 * 60_000;

export type CallEvent = "joined" | "offered" | "answered" | "connected" | "ended" | "approval_refused";

export interface CallRow {
  party: "operator" | "field";
  accountId: string | null;
  deviceId: string | null;
  event: CallEvent;
  detail: { framesDecoded?: number; [k: string]: unknown };
  recordedAt: Date;
}

export type CallCheckName = "call_set_up" | "operator_saw_video" | "field_confirmed";

export interface CallCheck {
  check: CallCheckName;
  passed: boolean;
  evidence: string;
}

export interface CallStanding {
  /** True when every check passed: this operator had a call with the phone. */
  onRecord: boolean;
  checks: CallCheck[];
}

/**
 * Whether this operator had a live call with the requesting phone, from the
 * rows. Pure, so the rule can be tested without a database.
 */
export function judgeCall(rows: readonly CallRow[], accountId: string, now: Date): CallStanding {
  const mine = rows.filter((r) => r.accountId === accountId);
  const fresh = (r: CallRow) => now.getTime() - r.recordedAt.getTime() <= CALL_FRESH_MS;
  const age = (r: CallRow) => `${Math.max(0, Math.round((now.getTime() - r.recordedAt.getTime()) / 1000))}s ago`;
  const latest = (party: CallRow["party"], event: CallEvent) =>
    mine.filter((r) => r.party === party && r.event === event).at(-1);

  const offered = latest("field", "offered");
  const answered = latest("operator", "answered");
  const setUp = Boolean(offered && answered && answered.recordedAt >= offered.recordedAt);

  const seen = mine
    .filter((r) => r.party === "operator" && r.event === "connected" && (r.detail.framesDecoded ?? 0) > 0)
    .at(-1);
  const stale = latest("operator", "connected");

  const confirmed = latest("field", "connected");

  const checks: CallCheck[] = [
    {
      check: "call_set_up",
      passed: setUp,
      evidence: setUp
        ? "the ledger carried the phone's offer to this operator and the operator's answer back"
        : !offered
          ? "the requesting phone never offered this operator a call"
          : "this operator did not answer the phone's offer",
    },
    {
      check: "operator_saw_video",
      passed: Boolean(seen && fresh(seen)),
      evidence: seen
        ? fresh(seen)
          ? `this operator's browser reported the call connected and ${seen.detail.framesDecoded} video frames decoded, ${age(seen)}`
          : `this operator's browser last reported video ${age(seen)}; an approval is given over a call that is live now`
        : stale
          ? "this operator's browser reported the call connected but decoded no video"
          : "this operator's browser never reported the call connected",
    },
    {
      check: "field_confirmed",
      passed: Boolean(confirmed && fresh(confirmed)),
      evidence: confirmed
        ? fresh(confirmed)
          ? `the requesting phone reported its call to this operator connected, ${age(confirmed)}`
          : `the requesting phone last reported a call to this operator ${age(confirmed)}`
        : "the requesting phone never reported a call to this operator connected",
    },
  ];
  return { onRecord: checks.every((c) => c.passed), checks };
}

export async function loadCallRows(tx: PoolClient | Pool, requestId: string): Promise<CallRow[]> {
  const { rows } = await tx.query<{
    party: "operator" | "field";
    account_id: string | null;
    device_id: string | null;
    event: CallEvent;
    detail: CallRow["detail"];
    recorded_at: Date;
  }>(
    `select party, account_id, device_id, event, detail, recorded_at
       from led.override_call where request_id = $1::uuid order by recorded_at, id`,
    [requestId],
  );
  return rows.map((r) => ({
    party: r.party,
    accountId: r.account_id,
    deviceId: r.device_id,
    event: r.event,
    detail: r.detail,
    recordedAt: r.recorded_at,
  }));
}

export async function recordCall(
  tx: PoolClient | Pool,
  row: {
    requestId: string;
    party: "operator" | "field";
    accountId: string | null;
    deviceId: string | null;
    event: CallEvent;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `insert into led.override_call (request_id, party, account_id, device_id, event, detail)
     values ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::jsonb)`,
    [row.requestId, row.party, row.accountId, row.deviceId, row.event, JSON.stringify(row.detail ?? {})],
  );
}

// ── carrying the set-up messages ────────────────────────────────────────────

export type SignalKind = "operator-joined" | "device-joined" | "offer" | "answer" | "bye";

export interface Signal {
  seq: number;
  kind: SignalKind;
  /** `device`, or the operator's account id. */
  from: string;
  fromName?: string;
  sdp?: string;
}

interface Room {
  seq: number;
  lastActive: number;
  devicePresent: boolean;
  operators: Map<string, string>;
  inbox: Map<string, Signal[]>;
}

const ROOM_IDLE_MS = 60 * 60_000;
const INBOX_LIMIT = 64;
/** A connection description with every candidate in it is a few kilobytes. */
export const SDP_LIMIT = 24_000;

const DEVICE = "device";

export class CallRooms {
  private readonly rooms = new Map<string, Room>();

  private room(requestId: string, now: number): Room {
    for (const [id, r] of this.rooms) if (now - r.lastActive > ROOM_IDLE_MS) this.rooms.delete(id);
    let room = this.rooms.get(requestId);
    if (!room) {
      room = { seq: 0, lastActive: now, devicePresent: false, operators: new Map(), inbox: new Map() };
      this.rooms.set(requestId, room);
    }
    room.lastActive = now;
    return room;
  }

  private post(room: Room, to: string, signal: Omit<Signal, "seq">): void {
    const box = room.inbox.get(to) ?? [];
    box.push({ ...signal, seq: ++room.seq });
    // Oldest dropped first: a set-up message nobody collected is out of date.
    while (box.length > INBOX_LIMIT) box.shift();
    room.inbox.set(to, box);
  }

  /** An operator opens the call. The phone, if it is there, is told to offer. */
  operatorJoins(requestId: string, accountId: string, name: string, now = Date.now()): { devicePresent: boolean } {
    const room = this.room(requestId, now);
    room.operators.set(accountId, name);
    room.inbox.delete(accountId);
    if (room.devicePresent) this.post(room, DEVICE, { kind: "operator-joined", from: accountId, fromName: name });
    return { devicePresent: room.devicePresent };
  }

  /** The phone opens the call. It is told of every operator already waiting. */
  deviceJoins(requestId: string, now = Date.now()): { operators: { accountId: string; name: string }[] } {
    const room = this.room(requestId, now);
    room.devicePresent = true;
    room.inbox.delete(DEVICE);
    for (const [accountId, name] of room.operators) {
      this.post(room, DEVICE, { kind: "operator-joined", from: accountId, fromName: name });
      this.post(room, accountId, { kind: "device-joined", from: DEVICE });
    }
    return { operators: [...room.operators].map(([accountId, name]) => ({ accountId, name })) };
  }

  /** False when that operator has not opened the call: there is nobody to offer to. */
  offer(requestId: string, toAccountId: string, sdp: string, now = Date.now()): boolean {
    const room = this.room(requestId, now);
    if (!room.operators.has(toAccountId)) return false;
    this.post(room, toAccountId, { kind: "offer", from: DEVICE, sdp });
    return true;
  }

  /** False when the phone has not offered this operator anything to answer. */
  answer(requestId: string, fromAccountId: string, sdp: string, now = Date.now()): boolean {
    const room = this.room(requestId, now);
    if (!room.devicePresent || !room.operators.has(fromAccountId)) return false;
    this.post(room, DEVICE, { kind: "answer", from: fromAccountId, sdp });
    return true;
  }

  leave(requestId: string, who: string, now = Date.now()): void {
    const room = this.room(requestId, now);
    if (who === DEVICE) {
      room.devicePresent = false;
      for (const accountId of room.operators.keys()) this.post(room, accountId, { kind: "bye", from: DEVICE });
    } else if (room.operators.delete(who)) {
      if (room.devicePresent) this.post(room, DEVICE, { kind: "bye", from: who });
    }
  }

  /** Messages for one end after a sequence number. Reading does not remove them. */
  inbox(requestId: string, who: string, after: number, now = Date.now()): Signal[] {
    const room = this.room(requestId, now);
    return (room.inbox.get(who) ?? []).filter((s) => s.seq > after);
  }
}

export const DEVICE_PARTY = DEVICE;
