#!/usr/bin/env python3
"""
Generate the Arduino IDE tree from the PlatformIO sources.

    python firmware/sync-arduino.py

The PlatformIO projects stay the source of truth for code. This script projects
them into the layout the Arduino IDE insists on — one folder per sketch, with
shared code as an installed library — so there is one copy of the firmware and
not two that drift.

Config headers are NEVER overwritten. They hold your device keys and Wi-Fi
credentials, and losing those to a re-sync would mean re-provisioning a board
that is already enrolled.
"""

import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "arduino-ide"

SHARED = HERE / "shared" / "mohar" / "src"
MONITOR = HERE / "room-monitor" / "src"
WITNESS = HERE / "witness-station" / "src"
NODE = HERE / "witness-node" / "src"

LIBRARY_PROPERTIES = """name=Mohar
version=0.1.0
author=Mohar
maintainer=Mohar
sentence=Canonical event bodies, Ed25519 signing, SD spool and ledger transport for Mohar devices.
paragraph=Shared by the room monitor and the witness station so the two cannot drift apart on the one thing that must be identical: the bytes they sign.
category=Communication
url=https://github.com/
architectures=esp32
"""

# sketch folder -> (source .cpp to become the .ino, extra files to copy in)
SKETCHES = {
    "WitnessNode": (NODE / "main.cpp", [NODE / "node_config.h"]),
    "WitnessNodeSetClock": (NODE / "set_clock.cpp", [NODE / "node_config.h"]),
    "RoomMonitor": (MONITOR / "main.cpp", [MONITOR / "monitor_config.h"]),
    "WitnessStation": (
        WITNESS / "main.cpp",
        [WITNESS / "station_config.h", WITNESS / "camera_pins.h"],
    ),
    "WitnessEnrol": (
        WITNESS / "enrol.cpp",
        [WITNESS / "station_config.h", WITNESS / "camera_pins.h"],
    ),
    "WitnessSetClock": (
        WITNESS / "set_clock.cpp",
        [WITNESS / "station_config.h", WITNESS / "camera_pins.h"],
    ),
}

# Config headers carry provisioning. Copy once, then leave alone forever.
PRESERVE = {"monitor_config.h", "station_config.h", "node_config.h"}


def copy_shared() -> None:
    lib = OUT / "libraries" / "Mohar" / "src"
    lib.mkdir(parents=True, exist_ok=True)
    (OUT / "libraries" / "Mohar" / "library.properties").write_text(
        LIBRARY_PROPERTIES, encoding="utf-8"
    )
    for f in sorted(SHARED.glob("*.*")):
        shutil.copy2(f, lib / f.name)
        print(f"  lib   {f.name}")


def copy_sketches() -> None:
    for name, (main_src, extras) in SKETCHES.items():
        folder = OUT / name
        folder.mkdir(parents=True, exist_ok=True)

        ino = folder / f"{name}.ino"
        shutil.copy2(main_src, ino)
        print(f"  sketch {name}/{ino.name}  <- {main_src.name}")

        for extra in extras:
            dest = folder / extra.name
            if extra.name in PRESERVE and dest.exists():
                print(f"         {extra.name}  (kept — holds your device key)")
                continue
            shutil.copy2(extra, dest)
            print(f"         {extra.name}")


if __name__ == "__main__":
    print(f"writing {OUT}")
    copy_shared()
    copy_sketches()
    print("\nInstall the library by copying arduino-ide/libraries/Mohar into your")
    print("Arduino libraries folder, then open a sketch folder in the IDE.")
    print("See firmware/arduino-ide/README.md.")
