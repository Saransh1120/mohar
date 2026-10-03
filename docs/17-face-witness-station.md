# 17 — The face station

## What it is

A second kind of witness station. `docs/06` specifies an ESP32 with an R307
fingerprint reader: two officials present two fingers inside one window, and the
station signs `WITNESS_ASSERTED` for each and `WITNESS_CEREMONY` for the window.
The face station does the same job with the camera already attached to the
centre PC, for a room where no reader has been fitted.

It is not a new protocol. It emits the same three event kinds with the same
payloads, against the same slot space, and the access engine evaluates
`biometric_primary`, `biometric_secondary`, `two_person_copresence` and
`witness_capture` exactly as before. Nothing in `services/ledger` changed to
make this work, which is the point: if the ceremony had needed a new check or a
relaxed one, the check was never doing any work.

## Where it lives

| Piece | Path |
| --- | --- |
| Recogniser, enrolment store, matching | `apps/control-room/src/lib/face.ts` |
| Panel: enrol, open a window, assert | `apps/control-room/src/components/FaceStationPanel.tsx` |
| Mounted on the ceremony page | `apps/control-room/src/pages/Witness.tsx` |
| Model weights, served from this origin | `apps/control-room/public/face-models/` |

The recogniser is `face-api.js` — MIT, no account, no key, no hosted inference,
so it sits inside `adr/0004`. Its three nets (tiny face detector, 68-point
landmarks, 128-float recognition embedding) are vendored under `public/` and
loaded with a dynamic `import`, so a control room that never opens the ceremony
page never downloads the 6.8 MB.

## What actually happens

**Enrolment.** The operator picks a person off the roster and a role, takes
three samples, and registers the slot. Superintendent is slot 1, observer is
slot 2 — the same two slots the R307 would use, so a centre that later fits a
reader keeps its mapping. The slot → person row goes to the ledger through the
existing `POST /fingerprints`; the biometric does not. Three 128-float
descriptors stay in this browser's `localStorage` and are never sent anywhere.

The order is deliberate: the server is asked first, and the descriptors are
saved locally only if it accepts the slot. A slot that the registry refuses
(already enrolled, unknown person) must not end up matching a face here to a
person the chain resolves differently.

**The window.** Opening one starts a 120-second scan at roughly one reading per
second. Each reading is the single largest face in the frame, compared against
every enrolled descriptor by Euclidean distance:

- under **0.5** — accepted. The station captures the frame, hashes the JPEG,
  and signs `WITNESS_ASSERTED` carrying the slot, the role, a match score and
  `frameSha256`. The image itself stays in IndexedDB, as on every other path.
- 0.5 to 0.6 — reported on screen as "closest was *X* at 0.54, which does not
  count". Not asserted.
- a face that matches nobody for six consecutive readings — signed as
  `EXCEPTION_RAISED` with code `biometric_no_match`. Somebody unrecognised
  standing at the camera during an unlock is a finding, not noise.
- the same slot matching again after it has already asserted — counted as a
  repeat and refused as an assertion, because one person twice is one person.

**The outcome.** When the window closes the station signs `WITNESS_CEREMONY`
with the outcome read off what happened: `two_person_confirmed` for two distinct
slots, `same_finger_twice` where only one slot ever matched but presented more
than once, `window_expired` otherwise. The page then puts the unlock to the
access engine, naming the superintendent's slot's person as the actor — and the
engine rules. A refusal here is a real refusal and is written to the chain like
any other.

0.5 rather than face-api's documented 0.6 because the two errors do not cost the
same. A refused official presents their face again; an accepted stranger opens
an examination paper.

## What is weaker than the fingerprint station

These are not caveats on an otherwise equivalent mechanism. They are the reason
the face station is the fallback and the R307 is the specification.

**One device instead of two.** On the fingerprint path the station matches and
the centre PC photographs, so faking a ceremony needs both. Here the same
browser matches the face, takes the photograph and signs both events. Whoever
controls this machine controls the whole ceremony. `lib/witness.ts` already
records that the centre PC key lives unattested in `localStorage`; this makes
that gap load-bearing rather than incidental.

**No liveness test.** No blink, no depth, no challenge-response. A printed
photograph or a phone screen held at the right distance will match. The R307 is
not immune to a lifted print either, but it is meaningfully harder.

**Descriptors on a laptop.** 128 floats per enrolled official, unencrypted, in
a browser profile. Not reversible into a photograph, which is worth something,
and not in the ledger, which is the same stance the fingerprint path takes with
templates. It is still biometric data about a named person sitting on somebody's
machine. "Forget the faces" destroys them; the slot mappings stay in the
registry and have to be retired there.

**A second-rate score.** `matchScore` is documented as reader confidence,
roughly 0–255. The R307 returns one directly. The face station maps distance
onto that range so the two read the same way round — higher is closer — but it
is not the same quantity and the panel prints the raw distance beside it so
nobody compares the two numbers as though they meant the same thing.

## What would fix each of these

A camera on a second device — a phone as a field device, or an ESP32-CAM — would
restore the two-device split for the photograph. Liveness needs either an active
challenge (turn your head, and check the landmarks actually moved) or hardware
the Rs 1,200 budget does not cover. Neither is built. Until they are, the face
station is a way to run the ceremony where no reader exists, not a replacement
for one, and the ledger records which kind of station asserted so a later reader
can tell them apart: the enrolment note says so, and the assertion carries a
frame the R307 never could.
