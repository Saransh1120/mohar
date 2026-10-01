import type { Pool, PoolClient } from "pg";
import { createTransport } from "nodemailer";

/**
 * ── Telling someone ──────────────────────────────────────────────────────────
 *
 * The watchdog and the hand-off engine write alerts into led.alert. This sends
 * each one out by the channels that are configured - Telegram, email - and
 * records every attempt in led.alert_delivery.
 *
 * It reads led.alert rather than being called by whatever raised the alert, so
 * it does not matter which part of the system raised it or whether the ledger
 * was restarted in between: an alert with no delivery on record is an alert
 * still to send.
 *
 * It runs inside the ledger process until `services/notify` exists, for the
 * same reason the watchdog does.
 *
 * A message carries what the alert carries: what happened, the packet, the
 * place, and the consequence. It does not rank the alert. Nothing here adds a
 * word like "critical" on the way out.
 */

export interface AlertForNotice {
  id: string;
  kind: string;
  raisedAt: Date;
  consequence: string;
  requiresDecision: boolean;
  packetSerial: string | null;
  centreCode: string | null;
  legNo: number | null;
  fromPlace: string | null;
  toPlace: string | null;
}

export interface Notice {
  subject: string;
  text: string;
}

const TITLES: Record<string, string> = {
  LEG_OVERDUE: "Hand-off not completed in time",
  PACKET_UNOPENED_OVERDUE: "Packet not opened by its scheduled time",
  TRANSFER_ATTEMPTS_EXHAUSTED: "Three wrong serial or key entries on one leg",
  DWELL_EXCEEDED: "Strong room visit ran far past its expected time",
  FOOTFALL_MISMATCH: "More people counted into a strong room than the door admitted",
  SEAM_DECODE_FAILED: "A seam label would not scan",
  SEAM_MANUAL_OVERRIDE: "Hand-off approved without a scan of the label",
  SEAL_MISMATCH: "Label at the opening is not the one that was sealed",
  SEAL_LOCK_TAMPER: "Seal-lock enclosure opened",
  SEAL_LOCK_NOT_CLOSED: "Seal lock did not confirm closure",
  CEREMONY_INCOMPLETE: "Opening not finished by its scheduled time",
  CEREMONY_SERIAL_ATTEMPTS_EXHAUSTED: "Three wrong serials typed at an opening",
};

function utc(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** The words that go out. Pure, so what an operator is told can be tested. */
export function alertNotice(a: AlertForNotice): Notice {
  const title = TITLES[a.kind] ?? a.kind.toLowerCase().replace(/_/g, " ");
  const subject = `Mohar alert: ${title}`;

  const where: string[] = [];
  where.push(a.packetSerial ? `Packet ${a.packetSerial}` : "No packet named");
  if (a.centreCode) where.push(`centre ${a.centreCode}`);
  if (a.legNo !== null && a.fromPlace && a.toPlace) {
    where.push(`leg ${a.legNo}: ${a.fromPlace} to ${a.toPlace}`);
  }

  const lines = [
    `${subject} (${a.kind})`,
    where.join(" · "),
    `Raised ${utc(a.raisedAt)}`,
    "",
    a.consequence,
  ];
  if (a.requiresDecision) {
    lines.push("", "This needs a decision in the control room, recorded on the Alerts page.");
  }
  lines.push("", `Alert ${a.id.slice(0, 8)}`);
  return { subject, text: lines.join("\n") };
}

export interface Channel {
  name: string;
  /** Resolves when the far end has accepted the message; throws otherwise. */
  send(notice: Notice): Promise<void>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A Telegram bot posting into one chat. The Bot API is free and needs no library. */
export function telegramChannel(
  botToken: string,
  chatId: string,
  fetchImpl: FetchLike = fetch,
  // A board that runs its own Bot API server points this at it.
  apiBase = "https://api.telegram.org",
): Channel {
  const base = apiBase.replace(/\/+$/, "");
  return {
    name: "telegram",
    async send(notice) {
      const res = await fetchImpl(`${base}/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: notice.text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // Telegram explains itself in the body ("chat not found", "bot was
        // blocked by the user"), and that sentence is what the record needs.
        const body = await res.text().catch(() => "");
        throw new Error(`telegram answered ${res.status}: ${body.slice(0, 300)}`);
      }
    },
  };
}

/** Plain-text email through whatever SMTP server the board already runs. */
export function emailChannel(smtpUrl: string, from: string, to: string): Channel {
  const transport = createTransport(smtpUrl, {
    connectionTimeout: 10_000,
    socketTimeout: 10_000,
  });
  return {
    name: "email",
    async send(notice) {
      await transport.sendMail({ from, to, subject: notice.subject, text: notice.text });
    },
  };
}

export interface ChannelSetup {
  channels: Channel[];
  /** Half-configured channels, named so the log can say why one is missing. */
  skipped: string[];
}

/** Build the channels the environment describes. Unset means off, not an error. */
export function channelsFromEnv(env: NodeJS.ProcessEnv): ChannelSetup {
  const channels: Channel[] = [];
  const skipped: string[] = [];

  const token = env["TELEGRAM_BOT_TOKEN"];
  const chat = env["TELEGRAM_CHAT_ID"];
  if (token && chat) {
    channels.push(telegramChannel(token, chat, fetch, env["TELEGRAM_API_URL"] || undefined));
  }
  else if (token || chat) skipped.push("telegram needs both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");

  const smtp = env["SMTP_URL"];
  const from = env["ALERT_EMAIL_FROM"];
  const to = env["ALERT_EMAIL_TO"];
  if (smtp && from && to) channels.push(emailChannel(smtp, from, to));
  else if (smtp || from || to) {
    skipped.push("email needs SMTP_URL, ALERT_EMAIL_FROM and ALERT_EMAIL_TO");
  }

  return { channels, skipped };
}

/** After this many failed sends on one channel, that channel stops retrying the alert. */
export const MAX_ATTEMPTS = 5;

/**
 * Alerts older than this are not sent. A channel configured today must not
 * announce last month's alerts as though they had just happened.
 */
export const NOTIFY_WINDOW_MS = 24 * 3600_000;

export interface Delivery {
  alertId: string;
  kind: string;
  channel: string;
  outcome: "sent" | "failed";
  detail?: string;
}

interface PendingRow {
  id: string;
  kind: string;
  raised_at: Date;
  consequence: string;
  requires_decision: boolean;
  seal_serial: string | null;
  centre_code: string | null;
  leg_no: number | null;
  from_place: string | null;
  to_place: string | null;
}

async function pendingFor(client: PoolClient, channel: string, now: Date): Promise<PendingRow[]> {
  const { rows } = await client.query<PendingRow>(
    `select a.id, a.kind, a.raised_at, a.consequence, a.requires_decision,
            p.seal_serial, c.code as centre_code, r.leg_no, r.from_place, r.to_place
       from led.alert a
       left join ref.package p on p.id = a.package_id
       left join ref.centre c on c.id = coalesce(a.centre_id, p.centre_id)
       left join ref.route_leg r on r.id = a.leg_id
      where a.raised_at > $1::timestamptz - make_interval(secs => $2)
        and not exists (
          select 1 from led.alert_delivery d
           where d.alert_id = a.id and d.channel = $3 and d.outcome = 'sent')
        and (select count(*) from led.alert_delivery d
              where d.alert_id = a.id and d.channel = $3 and d.outcome = 'failed') < $4
      order by a.raised_at
      limit 50`,
    [now, NOTIFY_WINDOW_MS / 1000, channel, MAX_ATTEMPTS],
  );
  return rows;
}

/**
 * Send every alert that a channel has not yet been told about, and record each
 * attempt.
 *
 * Holds a session advisory lock for the duration, so two ledger processes do
 * not both send the same alert. It is a try-lock: a second process skips this
 * round rather than queueing behind sends that may be waiting on a network.
 * Each attempt is its own committed row, so a crash half-way through loses
 * nothing that was already sent.
 */
export async function deliverPending(
  pool: Pool,
  channels: Channel[],
  now: Date = new Date(),
): Promise<Delivery[]> {
  if (channels.length === 0) return [];
  const client = await pool.connect();
  const out: Delivery[] = [];
  let locked = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext('notify:deliver')) as locked",
    );
    locked = rows[0]?.locked ?? false;
    if (!locked) return out;

    for (const channel of channels) {
      for (const row of await pendingFor(client, channel.name, now)) {
        const notice = alertNotice({
          id: row.id,
          kind: row.kind,
          raisedAt: row.raised_at,
          consequence: row.consequence,
          requiresDecision: row.requires_decision,
          packetSerial: row.seal_serial,
          centreCode: row.centre_code,
          legNo: row.leg_no,
          fromPlace: row.from_place,
          toPlace: row.to_place,
        });
        let outcome: "sent" | "failed" = "sent";
        let detail: string | undefined;
        try {
          await channel.send(notice);
        } catch (err) {
          outcome = "failed";
          detail = (err as Error).message.slice(0, 500);
        }
        await client.query(
          `insert into led.alert_delivery (alert_id, channel, outcome, detail)
           values ($1::uuid, $2, $3, $4)`,
          [row.id, channel.name, outcome, detail ?? null],
        );
        out.push({
          alertId: row.id,
          kind: row.kind,
          channel: channel.name,
          outcome,
          ...(detail ? { detail } : {}),
        });
      }
    }
    return out;
  } finally {
    if (locked) {
      await client.query("select pg_advisory_unlock(hashtext('notify:deliver'))").catch(() => {});
    }
    client.release();
  }
}

interface Log {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/** Deliver now, then every `intervalMs`. Returns a function that stops it. */
export function startNotifier(
  pool: Pool,
  log: Log,
  channels: Channel[],
  intervalMs: number,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const d of await deliverPending(pool, channels)) {
        if (d.outcome === "sent") log.info(d, `${d.kind} sent by ${d.channel}`);
        else log.warn(d, `${d.kind} could not be sent by ${d.channel}`);
      }
    } catch (err) {
      log.error({ err }, "notifier round failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
