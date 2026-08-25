# The unlock-ceremony demo

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
   records it in the activity feed as `station_online`) → *Connect*.
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
- The browser's signing key is in local storage, not the TPM. `adr/0003`
  records that attestation verification does not exist yet.
- The station has no card fitted, so records buffer in RAM and do not survive a
  power cut. The device says so in the ledger on every boot.
- The electronic seal lock is not built, so check 20 reports "not evaluated" on
  every unlock rather than quietly passing.
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
