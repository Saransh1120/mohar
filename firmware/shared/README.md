# shared/mohar

The library both devices build against, pulled in by `lib_extra_dirs = ../shared`.

It exists so the two firmwares cannot drift apart on the one thing that has to be
identical: the bytes they sign. If the room monitor and the witness station
canonicalised bodies differently, one of them would start producing signatures
the ledger cannot verify, and the failure would show up as silence rather than as
an error.

| File | What it owns |
| --- | --- |
| `mohar_crypto` | SHA-256, Ed25519, UUIDv4, hex |
| `mohar_event` | Canonical body construction and signing |
| `mohar_spool` | Append-only SD spool — write before transmit |
| `mohar_net` | `POST /events`, honouring 201 / 200 / 422 |
| `mohar_time` | DS3231 to RFC 3339 UTC with millisecond precision |

`mohar_event.h` carries the canonicalisation rules in full. The short version:
keys in ascending order, optional fields omitted rather than nulled, integers
only, and `geo` never sent — these devices are bolted to a wall and inventing a
position fix inside a signed body would be a lie.

`JsonWriter` enforces the ordering rule at runtime rather than trusting the
author to keep it. An out-of-order key aborts the build of that body instead of
producing one that fails verification later, in the field, with no serial console
attached.
