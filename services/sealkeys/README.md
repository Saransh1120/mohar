# sealkeys

Sealed package service. Encrypts each centre bundle with XChaCha20-Poly1305 and
splits the opening key as the control room's part XOR a Shamir 2-of-3 across
three officials. Not built: `src/` is empty. The split and the time lock exist
in `packages/crypto-core`, and sealing a packet's seam label is
`POST /packages/:id/seal` in the ledger.

The paragraph below describes the earlier 3-share-holder design and is kept
until this service is written against `docs/03-crypto-design.md`.

Each share is protected differently and every method is free: one Argon2id
passphrase-wrapped for the exam authority, one under `tlock` bound to a public
drand beacon round at exam start, and two under WebAuthn platform authenticators
held by the centre superintendent and the independent observer. No cloud HSM, no
purchased security keys.

Never holds a reconstructable key at rest. The timelock share does not exist
anywhere until the beacon publishes, so opening early requires all three
remaining holders to collude across three organisations.

See `docs/03-crypto-design.md`, including the honest note on what is lost by not
having an HSM.
