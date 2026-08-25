# Arduino IDE

Generated from the PlatformIO sources by `python firmware/sync-arduino.py`.
Re-run it after any firmware change. It never overwrites `monitor_config.h` or
`station_config.h` — those hold your device keys, and losing them means
re-provisioning a board that is already enrolled.

Four sketches, because the Arduino IDE has one sketch per folder where
PlatformIO had one project with several build environments:

| Sketch | When you use it |
| --- | --- |
| `WitnessSetClock` | Once per board, to set the DS3231 |
| `WitnessEnrol` | Once per person, to enrol fingerprints |
| `WitnessStation` | The station itself |
| `RoomMonitor` | The room monitor |

---

## 1. Install the ESP32 board package

**Tools → Board → Boards Manager**, search `esp32`, install
**esp32 by Espressif Systems** (version 3.x).

If it does not appear, add the package URL under
**File → Preferences → Additional boards manager URLs**:

```
https://espressif.github.io/arduino-esp32/package_esp32_index.json
```

## 2. Install the libraries

**Tools → Manage Libraries**, then install by exact name:

| Library | Used by | Note |
| --- | --- | --- |
| `Crypto` by Rhys Weatherley | both | Ed25519 signing |
| `RTClib` by Adafruit | both | Pulls in Adafruit BusIO |
| `Adafruit Fingerprint Sensor Library` | witness | |
| `Adafruit SSD1306` | witness | |
| `Adafruit GFX Library` | witness | |
| `Adafruit VL53L0X` | monitor | |
| `ld2410` by ncmreynolds | monitor | mmWave presence |

Say **Install all** when the IDE offers to pull dependencies.

## 3. Install the Mohar library

Copy the whole `libraries/Mohar` folder from here into your Arduino libraries
folder, then **restart the IDE** — it only scans for libraries at startup.

| Platform | Path |
| --- | --- |
| Windows | `Documents\Arduino\libraries\Mohar` |
| macOS | `~/Documents/Arduino/libraries/Mohar` |
| Linux | `~/Arduino/libraries/Mohar` |

**On Windows, check where `Documents` actually is before copying.** OneDrive
folder redirection moves it, so the real sketchbook can sit somewhere like
`C:\Users\<you>\OneDrive\Desktop\Documents\Arduino` while a stale
`C:\Users\<you>\Documents\Arduino` also exists and looks right. Installing into
the wrong one produces `fatal error: mohar_crypto.h: No such file or directory`
no matter how many times the IDE is restarted, because the IDE never looks
there.

The sketchbook is whichever folder already holds the libraries you installed
through Library Manager. Ask Windows directly:

```powershell
(Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders").Personal
```

On Windows, from the repo root:

```bash
cp -r firmware/arduino-ide/libraries/Mohar "$USERPROFILE/Documents/Arduino/libraries/"
```

Check it took: **File → Examples** should now list Mohar under
"Custom libraries", and `#include <mohar_event.h>` should compile.

---

## 4. Board settings — these matter

The Arduino IDE will happily build with the wrong ones and give you a board that
reboots at the moment of capture. Set them by hand under **Tools**.

### Witness station — ESP32-S3

| Setting | Value |
| --- | --- |
| Board | **ESP32S3 Dev Module** |
| USB CDC On Boot | **Enabled** |
| Flash Size | **8MB** (or 16MB, match your board) |
| PSRAM | **OPI PSRAM** |
| Partition Scheme | **Huge APP (3MB No OTA/1MB SPIFFS)** |
| Upload Speed | 921600 |

**PSRAM is not optional.** With it set to Disabled the sketch compiles, boots,
and dies the first time the camera allocates a frame buffer. The firmware checks
`psramFound()` and refuses to start rather than letting that look like flaky
hardware — if the serial console says "no PSRAM detected", this setting is why.

**Huge APP is not optional either.** The camera driver, Wi-Fi stack and crypto
together overflow the default partition scheme, and the error the IDE prints for
that ("text section exceeds available space") does not mention partitions.

### Room monitor — ESP32-WROOM-32

| Setting | Value |
| --- | --- |
| Board | **ESP32 Dev Module** |
| Partition Scheme | Default |
| Upload Speed | 921600 |

Defaults are fine for the rest.

---

## 5. Serial monitor

115200 baud. On the S3 with USB CDC enabled, the port disappears and reappears
after each upload — wait for it to come back before opening the monitor, and
re-select it under **Tools → Port** if the IDE loses track.

---

## Differences from the PlatformIO tree

- Sketches are `.ino` rather than `main.cpp`. The Arduino IDE prepends its own
  prototypes, which is why `setup()` and `loop()` need no forward declarations.
- `WitnessEnrol` and `WitnessSetClock` carry a copy of `station_config.h` because
  each sketch folder must be self-contained. Only the **pin** defines matter in
  those two — they never sign anything, so the key fields can stay at their
  placeholder values.
- Library versions are whatever Library Manager gives you, rather than pinned.
  If a build breaks after an update, that is the first thing to check.
