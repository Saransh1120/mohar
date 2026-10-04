# Demo runbook

Two demos. **Part A** is the whole custody story and needs no hardware: a
laptop, a database and an internet connection. **Part B** is the unlock
ceremony on the ESP32 witness station. If the hardware fails on stage, Part A
still runs.

# Part A: the custody story, no hardware

Sealed, handed over, held in a strong room, roster locked, opened by two
officials when the public beacon allows it. Every step is put to the real
engine and the page shows what the engine ruled.

Each page demonstrates its stage on a packet of its own: the Transfers page
makes one to hand over, the Ceremonies page makes one to open. One packet
taken through every stage in order, with the chain checked afterwards, is
`tools/e2e/journey.mjs` (step 9).

Steps 1, 2, 6, 7 and 8, and the granted entry and exit in step 5, were clicked
through against the gateway on a laptop on Oct 3, 2026; the words in capitals
are what the pages showed. Step 4 was clicked through the day before with a
drawn canvas standing in for the camera, not a real one. The refusals in step
5 and the alert in step 3 were not clicked this time: `tools/e2e/doors.mjs`
and `sweeps.mjs` cover them, and the alert was seen on the live deployment on
Oct 2.

## Before anyone is watching

| # | Terminal | Command |
| --- | --- | --- |
| 1 | gateway, ledger, access | `DATABASE_URL=postgres://mohar_app:change_me_in_deployment@localhost:5432/mohar pnpm start` |
| 2 | control room | `pnpm --filter @mohar/control-room dev` |

- Every migration applied, through 015 (`pnpm migrate` as `mohar_migrator`).
- Sign in at `http://localhost:5173` as a control room operator.
- The internet has to be reachable: the opening waits for a real drand round.
- For step 4 only: a second operator signed in in a second browser profile,
  and a camera on the machine that plays the phone.
- In the consoles the fingerprint is simulated, and the consoles say so. A
  browser stands in for the courier's phone, the door device and the opening
  station. Everything else is the engine's.

## The script

**1 · A hand-off.** Transfers → *New packet to hand off*. In the hand-off
console press *Dispatch*. `DISPATCH GRANTED`, with sixteen checks listed. Point
at the three that say *not evaluated*, each with its reason: a check that was
not run is never shown as passed.

**2 · A refusal.** The console now reads *Next: receive by the courier*. Change
*Serial typed* to anything else and press *Receive*. `RECEIVE REFUSED`,
*Refused for: packet_serial_mismatch*, and the line reads what was typed
against what is registered. Put the serial back and press *Receive* again:
`RECEIVE GRANTED`, and only now is a key *released to the receiver's phone
only*. The sender never sees it and the server keeps its hash. *Confirm with
key* → `LEG CLOSED`.

Say: the refusal was written down before the answer came back, and three wrong
serials or keys on a leg raise an alert.

**3 · A hand-off that never happens.** Set *Leg 1 due in* to *1 minute*, make
another packet and leave it. Within about a minute and a half the Alerts page
shows `LEG_OVERDUE`, saying how far the leg got and who was last verified with
the packet. If Telegram is configured the same alert arrives there.

**4 · A label that will not scan** (needs the second operator and a camera).
On a fresh packet set *Label scanned* to *damaged, will not scan*, choose a
photograph, *Report the damaged label*, then *Open the camera and call*. On the
Overrides page each operator presses *Open the call*, sees the phone's camera,
ticks both statements, writes what was seen and approves. Show first that an
operator who approves without opening the call is turned away: *there is no
such call on record for this account*. After the second approval, *Dispatch*
with the damaged label is granted and the packet is flagged for inspection
where it arrives.

Say: the ledger set the call up and recorded that it connected and carried
video. It never saw the picture and nothing of it is kept. What was in the
picture is each operator's statement.

**5 · The strong room.** Strong rooms → *New strong room to try*. Set *Second
person* to *nobody: one person alone* and press *Present at the door*: refused,
`two_person_required`. Choose a second person: `ENTRY GRANTED`. Try *Apart: 200
seconds* on another attempt: refused, the two fingers were not within 120
seconds. *Record the exit* closes the visit with how long it lasted.

**6 · The roster is locked.** Ceremonies → set *Exam starts in* to *20 minutes:
opens in 5* → *New packet due to open*. Then Rosters: the station is filled in,
type why the roster is being locked inside the last day, and press *Lock the
roster and issue the keys*. `LOCKED LATE · 1 KEY ISSUED`, with the drand round
the control room's part is locked to. Do this within the five minutes: once
the opening time has passed there is no future round to lock a key to and the
engine says so.

Say: the key was made and taken apart in that one request. Nothing readable is
kept, so nobody can open the packet early, including whoever runs the server.

**7 · The opening.** Back on Ceremonies: *Scan the packet and ask to begin* →
`SCAN AND AUTHORISATION PASSED`. *Identify official 1*, choose the observer or
the police escort at the reader, *Identify official 2*. The check
`different_institution` names both institutions. *Confirm the packet serial*.

Now press *Try to open it now* before the time. `THE CONTROL ROOM'S PART IS
STILL LOCKED`: *drand has not published round N yet. Nobody can shorten this
wait.* That refusal is the strongest control in the system and it is not
ours.

When the countdown ends the button becomes *Fetch the round and assemble the
key*. `GRANTED — THE PACKET MAY BE OPENED`, and the check `key_commitment`
reads *the key the station assembled hashes to the commitment made when it was
split*. Choose a photograph and *Record the opening* → `PACKET OPENED`.

**8 · What the chain says.** Activity → choose the opening run in the exam
filter. `CONTROL_ENVELOPE_ISSUED`, `SHARES_REWRAPPED`, `OPEN_CEREMONY`,
`PACKET_OPENED`, each signed by the ledger's service key. Choose the hand-off
run: `HANDOVER_INITIATED`, `HANDOVER_REFUSED` with the wrong serial in it,
`HANDOVER_COMPLETED`. Then Integrity → *Verify now*, and `/verify` for the
public check of one record.

**9 · One packet, start to finish.**

```bash
E2E_OWNER_URL=postgres://mohar_migrator:dev_only_password@localhost:5432/mohar node tools/e2e/journey.mjs
```

Sealed with a signed label, roster locked, four hand-offs with a refusal and a
damaged-label override, two strong room visits, opened on the real round, a
leg nobody completed. Then it reads the chain back: every signature, every
hash, no secret in any event. 38 checks; it takes about a minute because it
waits for drand. Everything it writes is rolled back.

## Part A's own limits

- The fingerprint in every console is simulated. The engines check a slot and
  a score as a reader would send them; no reader is attached.
- A browser stands in for the phone, the door and the opening station, with a
  key the browser holds. A device in the field would hold its key in its own
  hardware, and nothing here has attested that.
- The Transfers page seals its packet through `POST /demo/journey`, which
  records the label's commitment without a signed sealing event. The signed
  sealing is `tools/label-print`, and `journey.mjs` uses it.
- The demonstration strong room is attached to no centre, so its entries and
  exits are in the page's own record and not on the chain. A room registered
  with a centre puts them on the chain.
- The override's call has a relay only if one is set up (`TURN_URLS`,
  `TURN_SECRET`, `infra/docker/compose.turn.yml`), and none has been run yet.
  Without it, two networks that both block direct connections will not
  connect; try the call on the venue's network beforehand. With
  `OVERRIDE_CALL_REQUIRED=0` an approval is the operator's word again and each
  decision says so.
- The opening on stage is locked minutes ahead, not a day ahead, so it is
  recorded as a late lock with the reason typed.

## Part A with real phones

Everything above uses the console as the phone. To put real phones in the
hand-off, on the deployed site (a phone cannot reach `localhost`):

1. Control room → Transfers → *New packet to hand off* → *Hand this over from
   real phones*. Three enrolment codes and the packet's two label codes appear.
2. On the sender's phone, point the camera at the press operator's code. The
   field app opens with the exam, centre, person and packet filled in. An
   operator types their own username and password on the phone and presses
   *Enrol this phone*. If the phone has a screen lock it asks for a
   fingerprint, face or PIN, and the device line then reads *phone unlock
   registered*. Do the same on the receiver's phone with the courier's code.
3. Sender's phone: *Load legs for package above*, choose leg 1, use *QR A
   image* and *QR B image* to photograph the two label codes off the laptop
   screen, then *Dispatch*. The phone asks for the unlock again. Expect
   `dispatch: granted`, with `webauthn_user_verified: passed` and
   `device_enrolled: passed` among the checks.
4. Receiver's phone: load the legs, photograph both codes, type a wrong serial
   and press *Receive* (expect `refused`, `packet_serial_mismatch`), then the
   right serial (expect `granted` and *Transfer key held in memory*), then
   *Confirm with key held in memory*. Expect the leg to read completed.
5. Also worth seeing once: cancel the unlock prompt (the step does not go);
   switch the app to Hindi while the key is held (it survives); aeroplane mode,
   record a scan, and watch it upload when the link returns.

Do not open the label codes with the phone's ordinary camera app: that lands
on the public page and raises `UNAUTHORIZED_SCAN`, which is the label working.

**None of this has been run on a phone.** The codes were checked by decoding
them in a browser, and the field app was seen to fill its boxes from one. Write
down the phone, its browser, and what each step showed.

---

# Part B: the unlock ceremony on the witness station

Four things run, then a five-minute script.

## Before anyone is watching

| # | Terminal | Command |
| --- | --- | --- |
| 1 | ledger | `DATABASE_URL=postgres://mohar_app:change_me_in_deployment@localhost:5432/mohar pnpm --filter @mohar/ledger start` |
| 2 | control room | `pnpm --filter @mohar/control-room dev` |
| 3 | watchdog | `tools\monitor-watchdog\run.cmd` |
| 4 | station | flash `firmware/arduino-ide/WitnessNode`, leave the serial monitor open |

Restart the ledger after any change to `packages/contracts` — it validates
against its compiled schema and rejects new event kinds until it is restarted.

**Open `http://localhost:5173`, not the LAN address.** Browsers grant camera
access on `localhost` or HTTPS only, and an HTTPS page cannot call the station
over plain HTTP.

### Fifteen minutes before

1. **Ceremony page** → *Pair this browser* → *Sound on* → *Start camera*.
2. **Slots page** → enter the station's address (it prints it at boot and
   records it in the activity feed as `station_online`) and the station token
   (the `STATION_TOKEN` in that board's `node_config.h`) → *Connect*. The
   station answers no request without the token, and grants a browser access
   only from the `CONTROL_ROOM_ORIGIN` it was flashed with, so the page must be
   open at exactly that address. Over USB neither is needed.
3. Enrol two fingers from that page: one in a slot **below 10**, one in a slot
   **10 or above**. The page walks whoever is at the reader through it.
4. Register both slots against two people on the roster. Give the second one
   the capacity **observer**.
5. Run the whole ceremony once, end to end, and check it lands granted. Then
   run `tools/demo-setup` again for a fresh package so the live run is a first
   open rather than a repeat.

A completed ceremony from that rehearsal stays in the chain. If the hardware
fails on stage, open the Activity page and walk through the one that worked —
never let a loose jumper wire cost you the presentation.

---

## The script

**1 · What the ledger is.** Overview page. Point at the chain tip. Every row is
signed by an enrolled device and hash-chained to the one before it; nothing can
be edited, only appended.

**2 · A finger that should not open anything.** Present an unenrolled finger at
the reader. The laptop plays one long low tone, and the Fingerprint reader panel
records *Refused — no enrolled template matched*. Say: the refusal is recorded,
not discarded. A run of these at 08:40 is either a worn hand or somebody who
should not be at the reader, and neither is visible if only successes are shown.

**3 · The superintendent.** Present the first enrolled finger. The camera fires
— **only** now, never on a timer — and commits the frame's SHA-256. The panel
shows the name resolved from the slot, and *1 of 2, window open*.

Say: the ledger holds "slot 3 matched, score 187". It has never held a
fingerprint image or a template. A breach of this database cannot leak a
biometric that was never in it.

**4 · The same finger twice.** Present the *same* finger again. Refused,
`same_finger_twice`. One person tapping twice is not two people.

**5 · The observer.** Present the second finger. Two-note chime,
`two_person_confirmed`, second frame committed.

**6 · The decision.** Enter the seal serial and the custody key, press *Request
unlock decision*. Twenty-one checks, all evaluated, none short-circuited. Three
rising notes.

Then show the checks: distance, epochs, slots, scores. Say: every check records
what it observed, not a verdict. "187" and "41 s apart" can be re-examined
later; "passed" cannot.

**7 · Refusal is the product.** Clear the custody key and ask again. Refused for
`key_not_presented`, three flat low tones. The two-person rule being satisfied
is one of twenty-one checks, not permission. The attempt is written to the chain
*before* the answer comes back, so a client that crashes on a denial has still
left evidence.

**8 · Going dark is not an option.** Pull the station's power. Within ninety
seconds `MONITOR_SILENT` appears. Unplugging the device is not a way to go dark;
it is a way to raise an alarm.

---

## Say the limits before you are asked

They are all in the source already, and a judge who finds one you did not
mention will assume there are others you are hiding.

- An optical reader is spoofable with a lifted print. These records establish
  that a body was present, not that the right body was. Optical in the
  prototype, capacitive in deployment, and the camera frame is the cross-check.
- The finger and the photograph are witnessed by two different devices, so a
  compromised centre PC could pair a real match with a substituted frame. What
  it cannot do is arrange that afterwards — both halves are committed at the
  time.
- The browser's signing key is a non-extractable key held by the browser, not
  the TPM. Script on the page cannot read it out, but anyone at this unlocked
  machine can still have the browser sign. An Android attestation is checked
  at enrolment when a device presents one, but nothing here produces one, so
  every device in this demo rests on the operator who enrolled it (`adr/0003`).
- Two authorised officials who collude at a legitimate opening pass every
  check. Mohar does not stop them; it narrows the enquiry to two named people
  and a signed time.
- A leak at the press before the packet is sealed is outside the chain, which
  begins at `SEAL_APPLIED`.
- A careful attacker can read a seam label's QR code offline without opening
  the packet. Detection covers careless scans.
- Nobody has checked with a lawyer whether this record is accepted as evidence
  under the Bharatiya Sakshya Adhiniyam 2023. It is a custody record
  investigators can work from, and no more is claimed.
- The station has no card fitted, so records buffer in RAM and do not survive a
  power cut. The device says so in the ledger on every boot.
- The seal lock's sketch is written and has not been flashed to a board, so no
  lock has reported for any packet and check 20 says "not evaluated" on every
  unlock rather than quietly passing.
- And the one that matters most: at Hazaribagh the principal was *authorised*
  to be in that room. Biometrics and occupancy sensing are detective controls
  against unauthorised entry and close to useless against authorised betrayal.
  The story is the ledger.

---

## When it will not grant

The refusals are almost always correct. Read them rather than working around
them.

| Reason | What it means |
| --- | --- |
| `key_unknown` | Something other than a custody key is in the field — a device id, usually |
| `outside_custody_window` | A seeded package. Its window closed; run `tools/demo-setup` |
| `package_already_opened` | Same — seeded packages are finished, and two were seeded to demonstrate refusal |
| `device_not_bound_to_centre` | The package belongs to a different centre than the station |
| `person_not_on_roster` | The matched slot is not registered, or that person is not on this centre's roster |
| `seal_serial_mismatch` | Stop. Runbook: do not print, escalate. The paper is presumed compromised |

```bash
node tools/demo-setup/index.mjs --lat <lat> --lon <lon>
```

Read the coordinates off the Ceremony page's *Locate* button. It builds a
centre, package, roster and custody key with an open window and prints a config
block for the station. It weakens no check: the geofence radius is untouched and
the key expires with the epoch like any other.
