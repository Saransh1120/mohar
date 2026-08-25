# sealkeys

Sealed package service. Encrypts each centre bundle with XChaCha20-Poly1305 and
splits the content key 3-of-4 by Shamir.

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
