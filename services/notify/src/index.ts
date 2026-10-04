import pg from "pg";
import { pino } from "pino";
import { channelsFromEnv, startNotifier } from "./notify.js";

/**
 * ── The notifier as its own process ──────────────────────────────────────────
 *
 * It needs nothing from the ledger but the database: it reads `led.alert`,
 * sends each alert that has no delivery on record, and writes every attempt to
 * `led.alert_delivery`. So it can stop, restart or move to another machine
 * without the ledger noticing, and an alert raised while it was down is sent
 * when it comes back.
 *
 * Run it as `mohar_app`, like the ledger: it needs SELECT on led.alert and
 * INSERT on led.alert_delivery and no more. Give the ledger `NOTIFIER=external`
 * so that it does not also send. If both do run, a session advisory lock keeps
 * each round to one of them and nothing is sent twice.
 *
 * It holds the Telegram token and the mail password. Run apart from the
 * ledger, those are no longer in the process that takes requests.
 */

const log = pino({ name: "notify" });

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  log.error("DATABASE_URL is required");
  process.exit(1);
}

const intervalMs = Number(process.env["NOTIFY_MS"] ?? 5_000);
if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  log.error({ NOTIFY_MS: process.env["NOTIFY_MS"] }, "NOTIFY_MS must be a positive number of milliseconds");
  process.exit(1);
}

const { channels, skipped } = channelsFromEnv(process.env);
for (const reason of skipped) log.warn({ reason }, "notification channel not started");
if (channels.length === 0) {
  // Unlike the ledger, this process has no other job. With nothing to send by,
  // running it would look like alerts being delivered when none are.
  log.error("no notification channel is configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or SMTP_URL, ALERT_EMAIL_FROM and ALERT_EMAIL_TO");
  process.exit(1);
}

// Hosted Postgres refuses a plaintext connection; localhost does not listen for TLS.
const host = (() => {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return "";
  }
})();
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 3,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ...(host === "localhost" || host === "127.0.0.1" ? {} : { ssl: { rejectUnauthorized: false } }),
});

const stop = startNotifier(pool, log, channels, intervalMs);
log.info({ intervalMs, channels: channels.map((c) => c.name) }, "notifier sending alerts");

// The interval is unref'd so that the ledger can exit with it running; here it
// is the only thing keeping the process alive, so something has to.
const alive = setInterval(() => {}, 60_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "shutting down");
    stop();
    clearInterval(alive);
    void pool.end();
  });
}
