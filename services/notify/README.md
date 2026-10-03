# notify

Alert fan-out to the control room, the authority and the observer. Not built as
a service: `src/` is empty. What exists runs inside the ledger process
(`services/ledger/src/domain/notify.ts`): every row in `led.alert` is sent by
Telegram and by email when those channels are configured, and each attempt is
recorded in `led.alert_delivery`. Alerts carry what happened and a consequence;
they are not ranked.

See `docs/02-architecture.md`.
