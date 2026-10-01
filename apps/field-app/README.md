# Field app

Installable phone PWA served at `/field/` by Netlify and at `http://localhost:5174/field/`
in development. It requires a seal photograph, reads a QR from the camera image,
signs `SCAN_OBSERVED` with a non-extractable WebCrypto Ed25519 key, and stores the
photo plus signed event in IndexedDB before network transfer. Reconnect retries
the same event ID, and ledger rejections remain visible in the queue. The photo
hash is inside the signed event. Export photos before clearing browser data.

This is a browser field client. WebCrypto keys do not give Android hardware
attestation, and this app does not perform fingerprint login, NFC reading or
dual-signature handoff. Those remain for a native Android implementation. No
claim of hardware-backed phone identity should be made for this PWA.
