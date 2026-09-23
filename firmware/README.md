# Firmware

Three boards, all built in the **Arduino IDE** (see `arduino-ide/`). `shared/mohar`
holds the common library; `sync-arduino.py` copies it into
`arduino-ide/libraries/Mohar`, so edit `shared/mohar` and run the script.

| Sketch | Board | What it does |
| --- | --- | --- |
| `arduino-ide/WitnessNode` | ESP32 DEVKIT V1 | Two fingerprints within 120 s, signs the assertion, reports over Wi-Fi or USB |
| `arduino-ide/RoomMonitor` | ESP32 | Door reed switch, presence, footfall, 30 s heartbeat |
| `arduino-ide/BenchCheck` | any | Bench diagnostics for the sensors on a board |
| `arduino-ide/WitnessNodeSetClock` | ESP32 | One-shot DS3231 clock set |

## Config headers hold secrets — they are not in git

Each sketch reads a config header that carries **that board's own Ed25519 private
key**, the centre's Wi-Fi credentials and the ledger's address on that LAN. Those
files are git-ignored. Only the `*.example.h` templates are tracked.

To build a sketch:

```bash
cp firmware/arduino-ide/WitnessNode/node_config.example.h \
   firmware/arduino-ide/WitnessNode/node_config.h
```

then fill in every `CHANGE_ME` with the values from the provisioning tool:

```bash
node tools/provision-device/index.mjs --kind witness --centre JPR-001
```

It generates the keypair locally, enrols the public half with the ledger, and
prints the private half **once**, already formatted as C defines.

### The boards provisioned before this change need new keys

The old headers were committed, so their private keys are in git history and must
be treated as public. Revoke each of those devices
(`POST /devices/:id/revoke`) and provision a new identity for the board. Rewriting
history would not help: anyone who cloned the repository already has the old key.
