# Field app

Installable phone PWA served at `/field/` by Netlify and at `http://localhost:5174/field/`
in development (`pnpm --filter @mohar/field-app dev`, with `pnpm start` running).
It requires a seal photograph, reads a QR from the camera image,
signs `SCAN_OBSERVED` with a non-extractable WebCrypto Ed25519 key, and stores the
photo plus signed event in IndexedDB before network transfer. Reconnect retries
the same event ID and signed `deviceSeq`. The sequence counter is reserved in
IndexedDB before signing, so queued events keep their original number. A
record the ledger or the gateway will never accept (the
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

For a hand-off, enter the package ID and load its legs with a device-signed
`GET /legs`. Choose a leg, capture both QR images, and use Dispatch. The
receiver selects the leg, captures both codes, types the packet serial and
uses Receive. A granted receive returns a transfer key once; this page holds
it only in memory, then sends it with both QR halves (or the approved override)
on Confirm and clears it. The engine checks the seam again. Closing or
reloading the page loses the key. An approved damaged-label override ID may be
entered instead of both QR images. Each engine response shows the outcome,
all checks with their exact evidence, and the signed chain event result. A
refused outcome is shown as a ruling and is not retried automatically.

The fingerprint selector supplies simulated slot/score values for testing the
engine, and the screen labels them as simulated. It is not a fingerprint
capture. The phone has no reader integration yet.

The app is in English and Hindi (`src/i18n.ts`). A button in the header
switches, naming the other language in that language; the choice is kept on
the phone and a phone set to Hindi starts in Hindi. Switching rewrites the
fixed lines in place and reloads nothing, so a transfer key held between
Receive and Confirm survives it. What the ledger answers is not translated: a
check's name, its evidence and a deny reason are shown as the engine returned
them, and the hand-off screen says so. The Hindi has not been read by a
courier or an officer who would use it.

A damaged-label request links to `/field/call.html`, where the phone opens its
camera to the control room operators who have to see the packet before they
can approve. See `RUNNING.md` for what that call does and does not record.

This is a browser field client. WebCrypto keys do not give Android hardware
attestation, and this app does not perform fingerprint capture, NFC reading or
dual-signature handoff. Those remain for a native Android implementation. No
claim of hardware-backed phone identity should be made for this PWA.

What was and was not run is in `RUNNING.md`. The earlier enrolment, scan,
offline queue, override request and public verify flows were clicked through
on a desktop browser. The hand-off screens were clicked through against local
`pnpm start` on Oct 3, 2026: two separately enrolled field devices completed
Dispatch → Receive → Confirm on a planned leg; a wrong serial was refused with
its checks and signed refusal event. A phone and its camera are still untested.
