#!/usr/bin/env node
/**
 * Turns the absence of a heartbeat into a signed event.
 *
 *   MONITOR_HEARTBEAT_SECONDS=30 MISSED=3 \
 *   WATCHDOG_DEVICE_ID=... WATCHDOG_PRIVKEY=... \
 *   node tools/monitor-watchdog/index.mjs
 *
 * Without this, the firmware's heartbeat rule is only half implemented. The
 * device promises that unplugging it is "not a way to go dark, it is a way to
 * raise an alarm" — but nothing raises the alarm unless something is watching
 * for the gap. `MONITOR_SILENT` is in `SERVICE_ONLY_KINDS`, so a monitor cannot
 * report its own silence and a service has to do it. That asymmetry is the
 * point: a device that could declare itself silent could also decline to.
 *
 * Provision the signing identity first:
 *   node tools/provision-device/index.mjs --kind service
 *
 * Emitting the event is deliberately idempotent per outage: one MONITOR_SILENT
 * per gap, not one every poll. A control room drowning in repeats stops reading
 * them, which is the same as not having raised the alarm at all.
 */

import { createPrivateKey, sign } from "node:crypto";
import { randomUUID } from "node:crypto";

const LEDGER = process.env["LEDGER_URL"] ?? "http://localhost:8081";
const HEARTBEAT_S = Number(process.env["MONITOR_HEARTBEAT_SECONDS"] ?? 30);
const MISSED = Number(process.env["MONITOR_MISSED_HEARTBEATS_ALARM"] ?? 3);
const POLL_MS = Number(process.env["WATCHDOG_POLL_MS"] ?? 10000);

const DEVICE_ID = process.env["WATCHDOG_DEVICE_ID"];
const PRIVKEY_HEX = process.env["WATCHDOG_PRIVKEY"];

if (!DEVICE_ID || !PRIVKEY_HEX) {
  console.error(
    "WATCHDOG_DEVICE_ID and WATCHDOG_PRIVKEY are required.\n" +
      "Provision one with: node tools/provision-device/index.mjs --kind service",
  );
  process.exit(1);
}

const SILENCE_MS = HEARTBEAT_S * MISSED * 1000;

// ── signing ─────────────────────────────────────────────────────────────────

/** Wrap a raw 32-byte Ed25519 seed in the fixed PKCS#8 prefix Node expects. */
const signingKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(PRIVKEY_HEX, "hex"),
  ]),
  format: "der",
  type: "pkcs8",
});

/**
 * RFC 8785, restricted to the value types this tool produces.
 *
 * Every value here is a string, a boolean, or a safe integer, and for those
 * `JSON.stringify` over recursively key-sorted objects is byte-identical to JCS.
 * Anything else would need the real canonicaliser, so it is rejected rather than
 * serialised on a guess — a signature over the wrong bytes fails silently at the
 * far end and is very hard to diagnose from there.
 */
function canonical(value) {
  if (value === null) throw new Error("null in a signed body: omit the field instead");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`non-integer number ${value} needs the real JCS canonicaliser`);
  }
  return JSON.stringify(value);
}

function signBody(body) {
  return sign(null, Buffer.from(canonical(body), "utf8"), signingKey).toString("hex");
}

// ── ledger ──────────────────────────────────────────────────────────────────

async function fetchEvents(afterSeq) {
  const res = await fetch(`${LEDGER}/events?afterSeq=${afterSeq}&limit=1000`);
  if (!res.ok) throw new Error(`GET /events → ${res.status}`);
  const { events } = await res.json();
  return events;
}

async function emit(body) {
  const res = await fetch(`${LEDGER}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, deviceSig: signBody(body) }),
  });
  const out = await res.json();
  if (res.status >= 400) {
    console.error(`MONITOR_SILENT rejected (${res.status}):`, JSON.stringify(out));
    return false;
  }
  return true;
}

// ── state ───────────────────────────────────────────────────────────────────

/** monitorId → { lastAt, examId, centreId, sequence, alarmed } */
const monitors = new Map();
let cursor = "0";

function observe(event) {
  if (event.kind === "MONITOR_HEARTBEAT") {
    const p = event.body.payload;
    const prev = monitors.get(p.monitorId);
    monitors.set(p.monitorId, {
      lastAt: new Date(event.occurred_at).getTime(),
      lastAtIso: new Date(event.occurred_at).toISOString(),
      examId: event.body.examId,
      centreId: event.body.centreId,
      sequence: p.sequence,
      // A heartbeat clears the alarm. The next gap gets its own event, so the
      // chain shows one MONITOR_SILENT per outage rather than a level.
      alarmed: false,
      // A jump in the device's own counter means records existed and did not
      // arrive — a different fact from records never having been made.
      gap: prev && p.sequence > prev.sequence + 1 ? p.sequence - prev.sequence - 1 : 0,
    });
  }
}

async function catchUp() {
  for (;;) {
    const events = await fetchEvents(cursor);
    if (events.length === 0) break;
    for (const e of events) observe(e);
    cursor = events[events.length - 1].seq;
    if (events.length < 1000) break;
  }
}

async function sweep() {
  const now = Date.now();
  for (const [monitorId, m] of monitors) {
    const silentFor = now - m.lastAt;
    if (silentFor < SILENCE_MS || m.alarmed) continue;

    const missedCount = Math.floor(silentFor / (HEARTBEAT_S * 1000));
    const body = {
      v: 1,
      id: randomUUID(),
      examId: m.examId,
      ...(m.centreId ? { centreId: m.centreId } : {}),
      kind: "MONITOR_SILENT",
      occurredAt: new Date().toISOString(),
      actorDeviceId: DEVICE_ID,
      payload: { monitorId, lastHeartbeatAt: m.lastAtIso, missedCount },
    };

    if (await emit(body)) {
      m.alarmed = true;
      console.log(
        `MONITOR_SILENT ${monitorId} — ${missedCount} missed, last contact ${m.lastAtIso}`,
      );
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────

console.log(
  `watching ${LEDGER}; a monitor is silent after ${MISSED} missed ` +
    `${HEARTBEAT_S}s heartbeats (${SILENCE_MS / 1000}s)`,
);

await catchUp();
console.log(`${monitors.size} monitor(s) known`);

setInterval(async () => {
  try {
    await catchUp();
    await sweep();
  } catch (err) {
    // Keep running. A watchdog that exits on a transient error is a watchdog
    // that is not watching, and nothing would notice that either.
    console.error(`poll failed: ${err.message}`);
  }
}, POLL_MS);
