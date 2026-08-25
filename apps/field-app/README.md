# field-app

Android custody scanner. Offline-first, runs on ordinary consumer phones — no
MDM, no purchased hardware, no privileged permissions.

Device identity comes from an **Android Keystore keypair with hardware-backed
attestation**, which proves the private key lives in secure hardware on one
specific handset. That replaces the SIM binding the design originally called for:
IMEI, IMSI and SIM serial need `READ_PRIVILEGED_PHONE_STATE`, unavailable to
Play Store apps, and commercial MDM is a paid product. See
`docs/adr/0003-device-identity-without-mdm.md`.

Handles QR/NFC handoff scanning, biometric custodian login, mandatory seal
photography, dual-signature capture, and a local signed queue that reconciles on
sync. Must work on a cheap phone with no signal.

See `docs/05-unlock-protocol.md`.
