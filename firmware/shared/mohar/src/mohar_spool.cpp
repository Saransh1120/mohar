#include "mohar_spool.h"

namespace mohar {

static String dayPath(const String &dir, const String &day) {
  return dir + "/" + day + ".ndjson";
}

void Spool::beginRam(uint16_t capacity) {
  ram_ = true;
  ramCap_ = capacity;
  healthy_ = true;
  ramQueue_.clear();
  ramQueue_.reserve(capacity);
  pending_ = 0;
}

bool Spool::begin(fs::FS &fs, const char *dir) {
  ram_ = false;
  fs_ = &fs;
  dir_ = dir;
  cursorFile_ = dir_ + "/cursor.txt";
  if (!fs_->exists(dir_)) fs_->mkdir(dir_);

  File probe = fs_->open(dir_ + "/.probe", FILE_WRITE);
  if (!probe) {
    healthy_ = false;
    return false;
  }
  probe.close();
  fs_->remove(dir_ + "/.probe");

  healthy_ = true;
  loadCursor();
  recount();
  return true;
}

void Spool::loadCursor() {
  File f = fs_->open(cursorFile_, FILE_READ);
  if (!f) return;
  String s = f.readStringUntil('\n');
  f.close();
  int sep = s.indexOf(' ');
  if (sep <= 0) return;
  curDay_ = s.substring(0, sep);
  curOff_ = static_cast<uint32_t>(s.substring(sep + 1).toInt());
}

void Spool::saveCursor() {
  File f = fs_->open(cursorFile_, FILE_WRITE);
  if (!f) return;
  f.printf("%s %u\n", curDay_.c_str(), curOff_);
  f.close();
}

void Spool::recount() {
  // A count, not a scan of every byte: one newline per record.
  pending_ = 0;
  if (curDay_.length() == 0) return;
  File f = fs_->open(dayPath(dir_, curDay_), FILE_READ);
  if (!f) return;
  f.seek(curOff_);
  while (f.available()) {
    if (f.read() == '\n') pending_++;
  }
  f.close();
}

bool Spool::append(const char *isoDate, const String &line) {
  if (!healthy_) return false;

  if (ram_) {
    // Drop the oldest, not the newest. A stale heartbeat is worth less than the
    // event that just happened, and the count of what was lost goes out with
    // the next record rather than disappearing.
    if (ramQueue_.size() >= ramCap_) {
      ramQueue_.erase(ramQueue_.begin());
      dropped_++;
      Serial.printf("[mohar] RAM buffer full — dropped the oldest record (%u lost)\n",
                    dropped_);
    } else {
      pending_++;
    }
    ramQueue_.push_back(line);
    return true;
  }
  String day(isoDate);
  day = day.substring(0, 10);

  File f = fs_->open(dayPath(dir_, day), FILE_APPEND);
  if (!f) {
    healthy_ = false;
    return false;
  }
  f.print(line);
  f.print('\n');
  // flush() before close() so the record survives a power cut between the two;
  // "durable, then transmit" is only true if the bytes are actually committed.
  f.flush();
  f.close();

  if (curDay_.length() == 0) {
    curDay_ = day;
    curOff_ = 0;
    saveCursor();
  }
  pending_++;
  return true;
}

String Spool::peek() {
  lastLen_ = 0;
  if (ram_) return ramQueue_.empty() ? String() : ramQueue_.front();
  if (!healthy_ || curDay_.length() == 0) return String();

  File f = fs_->open(dayPath(dir_, curDay_), FILE_READ);
  if (!f) return String();

  if (curOff_ >= f.size()) {
    f.close();
    // The cursor's day is fully drained. Advance to the next day that has a
    // file; days are named so that lexical order is chronological order.
    File root = fs_->open(dir_);
    String next;
    for (File e = root.openNextFile(); e; e = root.openNextFile()) {
      String name(e.name());
      int slash = name.lastIndexOf('/');
      if (slash >= 0) name = name.substring(slash + 1);
      if (!name.endsWith(".ndjson")) continue;
      String day = name.substring(0, name.length() - 7);
      if (day > curDay_ && (next.length() == 0 || day < next)) next = day;
    }
    root.close();
    if (next.length() == 0) return String();
    curDay_ = next;
    curOff_ = 0;
    saveCursor();
    return peek();
  }

  f.seek(curOff_);
  String line = f.readStringUntil('\n');
  f.close();
  if (line.length() == 0) return String();
  lastLen_ = line.length() + 1;  // the newline we consumed
  return line;
}

void Spool::commit() {
  if (ram_) {
    if (!ramQueue_.empty()) {
      ramQueue_.erase(ramQueue_.begin());
      if (pending_ > 0) pending_--;
    }
    return;
  }
  if (lastLen_ == 0) return;
  curOff_ += lastLen_;
  lastLen_ = 0;
  if (pending_ > 0) pending_--;
  saveCursor();
}

}  // namespace mohar
