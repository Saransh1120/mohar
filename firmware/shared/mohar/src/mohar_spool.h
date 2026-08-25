#pragma once
#include <Arduino.h>
#include <FS.h>

#include <vector>

/**
 * ── Write to SD before transmitting ──────────────────────────────────────────
 *
 * The rule from `docs/06-hardware-spec.md`, implemented literally: a record is
 * durable on the card before any radio is touched. Cutting the power or jamming
 * the Wi-Fi therefore delays the record; it does not erase it.
 *
 * Nothing is ever deleted. One append-only file per UTC day, plus a cursor
 * naming the first record that has not yet been accepted by the ledger. The
 * card ends up holding the device's own copy of everything it ever said, which
 * is what makes a heartbeat gap investigable after the fact rather than merely
 * noticeable at the time.
 *
 * If the card is missing or unwritable the device does NOT silently carry on as
 * though nothing were different. It falls back to a small RAM ring and says so
 * in the ledger, because "we sent it but kept no record" is precisely the state
 * this design exists to prevent — and a device running degraded must be
 * distinguishable in the record from one running properly.
 *
 * The RAM ring is a real downgrade, not an equivalent: it holds a few dozen
 * records, it does not survive a reboot, and a long network outage will overrun
 * it. Overruns are counted and reported rather than hidden.
 */

namespace mohar {

class Spool {
 public:
  /** `dir` is created if absent, e.g. "/mohar". */
  bool begin(fs::FS &fs, const char *dir);

  /**
   * Run without a card, buffering in RAM.
   *
   * For bench work and for a centre where the card has failed. `degraded()`
   * stays true so the firmware can report the condition to the ledger on every
   * boot instead of quietly losing the durability guarantee.
   */
  void beginRam(uint16_t capacity);

  /** Durably append one record. `isoDate` is the first 10 chars of the timestamp. */
  bool append(const char *isoDate, const String &line);

  /** Read the oldest un-acknowledged record. Empty string when the spool is drained. */
  String peek();

  /** Mark the record returned by the last `peek()` as dealt with. */
  void commit();

  /** Records written but not yet accepted by the ledger. */
  uint32_t pending() const { return pending_; }

  bool healthy() const { return healthy_; }

  /** True when there is no card and records are only in RAM. */
  bool degraded() const { return ram_; }

  /** Records lost to RAM-ring overrun since boot. Always reported, never hidden. */
  uint32_t dropped() const { return dropped_; }

 private:
  void loadCursor();
  void saveCursor();
  void recount();

  bool ram_ = false;
  uint16_t ramCap_ = 0;
  uint32_t dropped_ = 0;
  std::vector<String> ramQueue_;

  fs::FS *fs_ = nullptr;
  String dir_;
  String cursorFile_;
  String curDay_;      // day file the cursor points into
  uint32_t curOff_ = 0;
  uint32_t lastLen_ = 0;  // bytes consumed by the last peek(), including '\n'
  uint32_t pending_ = 0;
  bool healthy_ = false;
};

}  // namespace mohar
