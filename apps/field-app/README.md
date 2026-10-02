# Field app

Installable phone PWA served at `/field/` by Netlify and at `http://localhost:5174/field/`
in development (`pnpm --filter @mohar/field-app dev`, with `pnpm start` running).
It requires a seal photograph, reads a QR from the camera image,
signs `SCAN_OBSERVED` with a non-extractable WebCrypto Ed25519 key, and stores the
photo plus signed event in IndexedDB before network transfer. Reconnect retries
the same event ID. A record the ledger or the gateway will never accept (the
signature does not verify, the phone is unknown or revoked) is kept in the queue
with the reason and counted apart from the ones still waiting to be sent. The
photo hash is inside the signed event. Export photos before clearing browser data.

Enrolment is done by a control-room operator at the phone. The operator types
their own username and password into the app; it signs in, checks that the
centre belongs to the exam and the person is on the register, enrols the
phone's public key with `POST /devices`, and signs out. The session is not
stored on the phone. Field actions use the phone's Ed25519 key. A damaged-label
request includes the retained photo hash and a device-signed request to
`/legs/:id/override`. It waits for the two control-room decisions before a
hand-off may proceed. The photo bytes remain on the phone for export; the
server receives the hash, not the file.

This is a browser field client. WebCrypto keys do not give Android hardware
attestation, and this app does not perform fingerprint login, NFC reading or
dual-signature handoff. Those remain for a native Android implementation. No
claim of hardware-backed phone identity should be made for this PWA.

What was and was not run is in `RUNNING.md`. In short: every flow above was
clicked through in a desktop browser against the gateway and the ledger, and
none of it on a phone.
