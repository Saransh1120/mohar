# seal-lock

ESP32-C6 firmware for the electronic package seal. Latch control, continuous tamper loop, monotonic replay counter, pinned authority public key. Tamper events write to flash before any radio transmission.

**Not built.** No firmware here yet, and no event kinds for it in
`packages/contracts`. Because of that, check 20 (`seal_lock_intact`) in the
access engine records "not evaluated" on every unlock rather than quietly
counting as passed.

What it would need, in order, is listed in `docs/12-hardware-build-guide.md`
Part G. Design rationale: `docs/06-hardware-spec.md`.
