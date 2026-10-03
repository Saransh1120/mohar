# Access service

The policy and custody-key routes live here. Start this service with the app
database connection, then point the ledger at it:

```sh
DATABASE_URL=postgres://... ACCESS_PORT=8082 pnpm --filter @mohar/access start
DATABASE_URL=postgres://... ACCESS_URL=http://127.0.0.1:8082 pnpm --filter @mohar/ledger start
```

The access process binds `127.0.0.1` unless `ACCESS_HOST` is set. Its HTTP
routes have no separate authentication layer, so keep it private and expose
them only through the ledger and gateway. If `ACCESS_URL` is absent, the ledger
registers the same package's routes in-process for existing deployments.

The engine evaluates the currently supported policy evidence and records a
decision. Android hardware attestation and a solenoid command issued from a
decision are still integration work; see `docs/05-unlock-protocol.md`.
