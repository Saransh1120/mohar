# ledger

Append-only, hash-chained custody event store. The spine of the system: every handoff, scan, unlock attempt and print event lands here, signed by the originating device. Nightly Merkle roots are RFC 3161 timestamped. Immutability is enforced by Postgres role grants, not application code.

See `docs/04-data-model.md`.
