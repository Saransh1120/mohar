# ledger-client

How a command-line tool presents an operator's session to the gateway.

`openSession(base)` reads the environment: `MOHAR_SESSION_TOKEN` for a session
already held, or `MOHAR_OPERATOR` and `MOHAR_OPERATOR_PASSWORD` to sign in for
the run and out again when closed. With neither it sends no credential, which
is right for a ledger reached directly on loopback.

Used by `tools/seed`, `tools/label-print`, `tools/demo-setup` and
`tools/provision-device`. The typed client with an offline queue that this
package was first sketched as has not been written; the field app keeps its own.
