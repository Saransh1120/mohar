# notify

Sends each alert out by the channels that are configured, Telegram and email,
and records every attempt in `led.alert_delivery`. It reads `led.alert` rather
than being called by whatever raised the alert, so an alert with no delivery on
record is an alert still to send, whoever raised it and whenever.

Alerts carry what happened, the packet, the place and a consequence. They are
not ranked, and nothing here adds a word like "critical" on the way out.

## Two ways to run it

**Inside the ledger**, which is the default: the ledger imports this package
and runs the loop itself. Nothing extra to start.

**As its own process:**

```bash
DATABASE_URL=postgres://mohar_app:...@host/mohar \
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
  pnpm --filter @mohar/notify start
```

and give the ledger `NOTIFIER=external` so that it does not also send. The bot
token and the mail password are then in this process and not in the one that
takes requests. It connects as `mohar_app`; it needs SELECT on `led.alert` and
INSERT on `led.alert_delivery`.

If both do run, a session advisory lock gives each round to one of them and
nothing is sent twice.

It exits at once if no channel is configured: a notifier with nothing to send
by would look like alerts being delivered when none are.

## Settings

`NOTIFY_MS` (5000), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`TELEGRAM_API_URL`, `SMTP_URL`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`.

See `RUNNING.md` for what has and has not been seen to deliver.
