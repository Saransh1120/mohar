import test from "node:test";
import assert from "node:assert/strict";
import {
  alertNotice,
  channelsFromEnv,
  telegramChannel,
  type AlertForNotice,
} from "./notify.js";

/**
 * ── What an operator is told, and how it is sent ─────────────────────────────
 *
 * The wording against hand-built alerts, and the Telegram channel against a
 * stand-in for `fetch`. Delivery against a real database - each alert sent
 * once, a failed send retried and both attempts kept - is exercised by
 * tools/e2e/transfer.mjs.
 */

function alert(over: Partial<AlertForNotice> = {}): AlertForNotice {
  return {
    id: "dddddddd-0000-4000-8000-000000000001",
    kind: "LEG_OVERDUE",
    raisedAt: new Date("2026-09-27T09:00:12.000Z"),
    consequence: "B. Meena (courier) dispatched this packet and nobody has accepted it.",
    requiresDecision: true,
    packetSerial: "PKT-JPR-0091",
    centreCode: "JPR-014",
    legNo: 2,
    fromPlace: "Route vehicle",
    toPlace: "District strong room, Jaipur",
    ...over,
  };
}

test("a notice names the packet, the centre, the leg and when it was raised", () => {
  const { subject, text } = alertNotice(alert());
  assert.equal(subject, "Mohar alert: Hand-off not completed in time");
  assert.match(text, /\(LEG_OVERDUE\)/);
  assert.match(text, /Packet PKT-JPR-0091 · centre JPR-014 · leg 2: Route vehicle to District strong room, Jaipur/);
  assert.match(text, /Raised 2026-09-27 09:00:12 UTC/);
  assert.match(text, /Alert dddddddd/);
});

test("the consequence goes out word for word", () => {
  const a = alert();
  assert.ok(alertNotice(a).text.includes(a.consequence));
});

test("an alert about a packet with no leg leaves the leg out", () => {
  const { subject, text } = alertNotice(
    alert({ kind: "PACKET_UNOPENED_OVERDUE", legNo: null, fromPlace: null, toPlace: null }),
  );
  assert.equal(subject, "Mohar alert: Packet not opened by its scheduled time");
  assert.equal(text.includes("leg"), false);
});

test("a kind with no title of its own is still readable", () => {
  const { subject } = alertNotice(alert({ kind: "DWELL_EXCEEDED" }));
  assert.equal(subject, "Mohar alert: dwell exceeded");
});

test("only an alert that needs a decision says so", () => {
  assert.match(alertNotice(alert()).text, /needs a decision/);
  assert.equal(alertNotice(alert({ requiresDecision: false })).text.includes("decision"), false);
});

test("a notice carries no severity word", () => {
  for (const a of [alert(), alert({ kind: "PACKET_UNOPENED_OVERDUE" }), alert({ kind: "X_Y" })]) {
    const { subject, text } = alertNotice(a);
    const all = `${subject} ${text}`.toLowerCase();
    for (const word of ["critical", "severity", "high priority", "medium", "urgent"]) {
      assert.equal(all.includes(word), false, `mentions "${word}"`);
    }
  }
});

test("telegram posts the text to the chat it was given", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const channel = telegramChannel("123:abc", "-100200", async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return new Response("{}", { status: 200 });
  });
  await channel.send({ subject: "s", text: "the text" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.telegram.org/bot123:abc/sendMessage");
  assert.deepEqual(calls[0]!.body, { chat_id: "-100200", text: "the text" });
});

test("a refusal from telegram is an error that carries what telegram said", async () => {
  const channel = telegramChannel("123:abc", "-1", async () =>
    new Response('{"ok":false,"description":"Bad Request: chat not found"}', { status: 400 }),
  );
  await assert.rejects(channel.send({ subject: "s", text: "t" }), /400.*chat not found/);
});

test("no settings means no channels, and that is not an error", () => {
  assert.deepEqual(channelsFromEnv({}), { channels: [], skipped: [] });
});

test("a half-configured channel is left off and named", () => {
  const { channels, skipped } = channelsFromEnv({ TELEGRAM_BOT_TOKEN: "123:abc" });
  assert.equal(channels.length, 0);
  assert.match(skipped[0]!, /TELEGRAM_CHAT_ID/);
});

test("each fully configured channel is built", () => {
  const { channels, skipped } = channelsFromEnv({
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_CHAT_ID: "-1",
    SMTP_URL: "smtp://localhost:2525",
    ALERT_EMAIL_FROM: "mohar@board.example",
    ALERT_EMAIL_TO: "control-room@board.example",
  });
  assert.deepEqual(channels.map((c) => c.name), ["telegram", "email"]);
  assert.deepEqual(skipped, []);
});
