# centre-client

Runs on **the exam centre's own Windows PC** — nothing is purchased and nothing
is sealed. Ships as a single static Go binary with a local web UI so there is no
runtime to install on a school machine.

Binds its device identity to the TPM 2.0 already present in any Windows 11 (and
most post-2016 Windows 10) machine. Recovers the timelock share from the public
drand beacon, collects two WebAuthn platform-authenticator assertions
(superintendent and observer, via Windows Hello or their phones), combines the
Shamir shares in memory, meters exactly N copies to the spooler, and zeroises.

The plaintext PDF is never written to disk. It does exist in RAM during the print
window, and an operator with admin rights can dump it — that limit is stated
plainly in `docs/03-crypto-design.md`. Every copy is watermarked, so extraction
remains attributable even when it succeeds.

See `docs/06-hardware-spec.md` for the throughput ceiling this client enforces.
