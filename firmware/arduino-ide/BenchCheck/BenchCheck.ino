/**
 * Mohar bench check — the sketch you flash at every wiring step.
 *
 * It reports what is *actually* attached, one line per subsystem, and it
 * deliberately depends on **nothing from Library Manager**. Wire, Wire's I2C
 * scan, SD_MMC, SPI/SD and esp_camera all ship inside the ESP32 board package,
 * so this compiles the moment the core is installed. That is the point: it
 * proves the toolchain and the Tools-menu settings before any third-party
 * library can be blamed for a failure.
 *
 * Nothing here signs anything or talks to the ledger. It is a multimeter, not a
 * device.
 *
 * Flash it, open the serial monitor at 115200, and press `r` to re-run the
 * checks without re-uploading — useful when you are reseating a connector and
 * want to see the result change.
 */

// ── which board is on the bench ─────────────────────────────────────────────
//
// Taken from whatever you picked in Tools > Board, so it cannot disagree with
// what you are actually compiling for. An ESP32-S3 is assumed to be the witness
// station; anything else is the room monitor. Override by defining one of these
// above this block if you are doing something unusual.
#if !defined(BOARD_WITNESS) && !defined(BOARD_ROOM_MONITOR)
  #if defined(CONFIG_IDF_TARGET_ESP32S3)
    #define BOARD_WITNESS 1
  #else
    #define BOARD_ROOM_MONITOR 1
  #endif
#endif

#include <Arduino.h>
#include <Wire.h>

#if defined(BOARD_WITNESS)
  #include <SD_MMC.h>
  #include <esp_camera.h>
  #include "station_config.h"
  #include "camera_pins.h"
  #define SDA_PIN PIN_I2C_SDA
  #define SCL_PIN PIN_I2C_SCL
#else
  #include <SD.h>
  #include <SPI.h>
  #include "monitor_config.h"
  #define SDA_PIN PIN_I2C_SDA
  #define SCL_PIN PIN_I2C_SCL
#endif

// ── reporting ───────────────────────────────────────────────────────────────

static int g_pass = 0, g_fail = 0;

/**
 * One-line summary state.
 *
 * The full report is for reading at the bench; this is for pasting. A serial
 * console holds more lines than fit on screen and the interesting one is never
 * the last, so every check also files its result here and the run ends with a
 * single line that carries the lot.
 */
struct Summary {
  bool psram = false;
  int i2cCount = -1;
  bool rtc = false;
  bool sdMounted = false;
  bool sdWrite = false;
  bool reedOpen = false;
  int ldrRaw = -1;
  int radarBytes = -1;
  bool radarHeader = false;
  bool xshutOk = false;
  bool tofOuter = false;
  bool tofInner = false;
  bool camera = false;
};
static Summary g_s;

/**
 * An ESP32-CAM is a classic ESP32 too, so the compile-time board check cannot
 * tell it from a plain devkit. PSRAM can: the devkit has none, every ESP32-CAM
 * has 4 MB. Detected at runtime because it decides which pins are safe to touch,
 * and touching the wrong ones here is not harmless — GPIO16 carries the PSRAM
 * chip select on an ESP32-CAM, and opening a UART on it takes the board down.
 */
static bool g_isCam = false;

static void head(const char *title) {
  Serial.println();
  Serial.printf("── %s ", title);
  for (size_t i = strlen(title); i < 60; ++i) Serial.print("─");
  Serial.println();
}

/**
 * Every result carries the observation, not just the verdict.
 *
 * "FAIL  microSD" sends you to the card. "FAIL  microSD — card did not mount on
 * CLK39/CMD38/D0 40" sends you to the pins, which is usually where the problem
 * actually is.
 */
static void result(bool ok, const char *what, const char *detail) {
  Serial.printf("%s  %-22s %s\n", ok ? "PASS" : "FAIL", what, detail);
  ok ? g_pass++ : g_fail++;
}

// ── 1. the chip and the Tools menu ──────────────────────────────────────────

static void checkChip() {
  head("Board and Tools-menu settings");

  Serial.printf("      chip           %s, rev %d, %d core(s) @ %lu MHz\n",
                ESP.getChipModel(), ESP.getChipRevision(), ESP.getChipCores(),
                (unsigned long)getCpuFrequencyMhz());
  Serial.printf("      flash          %lu MB\n",
                (unsigned long)(ESP.getFlashChipSize() / (1024 * 1024)));
  Serial.printf("      sketch space   %lu KB free of %lu KB\n",
                (unsigned long)(ESP.getFreeSketchSpace() / 1024),
                (unsigned long)((ESP.getSketchSize() + ESP.getFreeSketchSpace()) / 1024));
  Serial.printf("      heap           %lu KB free\n",
                (unsigned long)(ESP.getFreeHeap() / 1024));

#if defined(BOARD_WITNESS)
  char msg[96];
  g_s.psram = psramFound();
  if (psramFound()) {
    snprintf(msg, sizeof(msg), "%lu MB detected",
             (unsigned long)(ESP.getPsramSize() / (1024 * 1024)));
    result(true, "PSRAM", msg);
  } else {
    // The single most common S3 setup mistake, and it does not announce itself:
    // the sketch compiles, boots, and dies later when the camera allocates.
    result(false, "PSRAM",
           "not found — set Tools > PSRAM to \"OPI PSRAM\" and re-upload");
  }

  // Huge APP leaves roughly 3 MB for the application. The default scheme leaves
  // about 1.3 MB, which the full station overflows once the camera driver and
  // the Wi-Fi stack are both linked in.
  size_t appSpace = ESP.getSketchSize() + ESP.getFreeSketchSpace();
  if (appSpace > 2500000) {
    result(true, "Partition scheme", "Huge APP or larger");
  } else {
    result(false, "Partition scheme",
           "too small — set Tools > Partition Scheme to \"Huge APP\"");
  }
#endif
}

// ── 2. the I2C bus ──────────────────────────────────────────────────────────

/** Known addresses, so the scan names what it found instead of listing numbers. */
static const char *i2cName(uint8_t addr) {
  switch (addr) {
    case 0x68: return "DS3231 RTC";
    case 0x57: return "AT24C32 EEPROM (on most DS3231 boards)";
    case 0x3C: return "SSD1306 OLED";
    case 0x3D: return "SSD1306 OLED (alt address)";
    case 0x29: return "VL53L0X (factory address)";
    case 0x30: return "VL53L0X (reassigned by the firmware)";
    default:   return "unknown device";
  }
}

static void checkI2C() {
  head("I2C bus");
  Serial.printf("      scanning SDA=GPIO%d SCL=GPIO%d\n", SDA_PIN, SCL_PIN);

  Wire.begin(SDA_PIN, SCL_PIN);
  int found = 0;
  bool sawRtc = false;

  for (uint8_t addr = 1; addr < 127; ++addr) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() != 0) continue;
    Serial.printf("      0x%02X           %s\n", addr, i2cName(addr));
    found++;
    if (addr == 0x68) sawRtc = true;
  }

  g_s.i2cCount = found;
  g_s.rtc = sawRtc;

  if (found == 0) {
    // Two wires and two very common mistakes. Pull-ups are on every breakout
    // worth buying, so a completely silent bus is nearly always wiring.
    result(false, "I2C bus",
           "nothing answered — check SDA/SCL are not swapped and 3V3/GND reach the modules");
  } else {
    char msg[48];
    snprintf(msg, sizeof(msg), "%d device(s) answered", found);
    result(true, "I2C bus", msg);
  }

  result(sawRtc, "DS3231 RTC",
         sawRtc ? "present at 0x68" : "absent — timestamps will not work");
}

// ── 3. the card ─────────────────────────────────────────────────────────────

static void checkCard() {
  head("microSD");

#if defined(BOARD_WITNESS)
  Serial.printf("      SDMMC 1-bit on CLK=%d CMD=%d D0=%d\n", SDMMC_CLK_PIN,
                SDMMC_CMD_PIN, SDMMC_D0_PIN);
  SD_MMC.setPins(SDMMC_CLK_PIN, SDMMC_CMD_PIN, SDMMC_D0_PIN);
  bool mounted = SD_MMC.begin("/sdcard", true);
  fs::FS &card = SD_MMC;
  uint64_t bytes = mounted ? SD_MMC.cardSize() : 0;
#else
  Serial.printf("      SPI on CS=%d\n", PIN_SD_CS);
  bool mounted = SD.begin(PIN_SD_CS);
  fs::FS &card = SD;
  uint64_t bytes = mounted ? SD.cardSize() : 0;
#endif

  g_s.sdMounted = mounted;
  if (!mounted) {
    result(false, "microSD",
           "did not mount — card must be FAT32, not exFAT; reseat it and check the pins");
    return;
  }

  char msg[64];
  snprintf(msg, sizeof(msg), "mounted, %lu MB", (unsigned long)(bytes / (1024 * 1024)));
  result(true, "microSD", msg);

  // A card that mounts read-only is worse than one that does not mount: the
  // firmware would believe it had written the record before transmitting.
  File f = card.open("/mohar_benchcheck.txt", FILE_WRITE);
  if (!f) {
    result(false, "microSD write", "mounted but could not open a file for writing");
    return;
  }
  f.println("mohar bench check");
  f.flush();
  f.close();

  File r = card.open("/mohar_benchcheck.txt", FILE_READ);
  bool readBack = r && r.readStringUntil('\n').startsWith("mohar");
  if (r) r.close();
  card.remove("/mohar_benchcheck.txt");

  g_s.sdWrite = readBack;
  result(readBack, "microSD write",
         readBack ? "wrote and read back a file" : "write succeeded but read back wrong");
}

// ── 4. the camera ───────────────────────────────────────────────────────────

#if defined(BOARD_WITNESS)
static bool g_cameraStarted = false;

static void checkCamera() {
  head("Camera");

  if (!psramFound()) {
    result(false, "OV2640 camera", "skipped — PSRAM is required, fix that first");
    return;
  }

  if (!g_cameraStarted) {
    camera_config_t c = {};
    c.ledc_channel = LEDC_CHANNEL_0;
    c.ledc_timer = LEDC_TIMER_0;
    c.pin_d0 = Y2_GPIO_NUM;  c.pin_d1 = Y3_GPIO_NUM;
    c.pin_d2 = Y4_GPIO_NUM;  c.pin_d3 = Y5_GPIO_NUM;
    c.pin_d4 = Y6_GPIO_NUM;  c.pin_d5 = Y7_GPIO_NUM;
    c.pin_d6 = Y8_GPIO_NUM;  c.pin_d7 = Y9_GPIO_NUM;
    c.pin_xclk = XCLK_GPIO_NUM;   c.pin_pclk = PCLK_GPIO_NUM;
    c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM;
    c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
    c.pin_pwdn = PWDN_GPIO_NUM;   c.pin_reset = RESET_GPIO_NUM;
    c.xclk_freq_hz = 20000000;
    c.pixel_format = PIXFORMAT_JPEG;
    c.frame_size = FRAMESIZE_SVGA;
    c.jpeg_quality = 12;
    c.fb_count = 2;
    c.fb_location = CAMERA_FB_IN_PSRAM;
    c.grab_mode = CAMERA_GRAB_LATEST;

    esp_err_t err = esp_camera_init(&c);
    if (err != ESP_OK) {
      // Expected, and not a fault, on a bare ESP32-S3-DevKitC: the pin map in
      // camera_pins.h is for a board with the sensor already routed. Until the
      // OV2640 is wired and a matching map is written, this line will fail and
      // everything above it is still meaningful.
      char msg[110];
      snprintf(msg, sizeof(msg),
               "init failed (0x%x) — expected if the OV2640 is not wired, or CAMERA_MODEL_* is wrong",
               err);
      result(false, "OV2640 camera", msg);
      return;
    }
    g_cameraStarted = true;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) Serial.printf("      sensor PID     0x%04X\n", s->id.PID);

  // Discard the first frame: after an idle sensor it is usually mis-exposed,
  // and a size read off a bad frame tells you nothing useful.
  camera_fb_t *fb = esp_camera_fb_get();
  if (fb) esp_camera_fb_return(fb);
  fb = esp_camera_fb_get();

  if (!fb) {
    result(false, "Camera capture", "initialised but returned no frame");
    return;
  }
  char msg[64];
  snprintf(msg, sizeof(msg), "%ux%u JPEG, %u bytes", fb->width, fb->height, fb->len);
  esp_camera_fb_return(fb);
  g_s.camera = true;
  result(true, "Camera capture", msg);
}
#endif

// ── 5. room-monitor sensors ─────────────────────────────────────────────────

#if defined(BOARD_ROOM_MONITOR)

/**
 * The reed switch has no "absent" state — an unwired pin with the pull-up on
 * simply reads high, which is indistinguishable from a door standing open. So
 * this reports the level as an observation and tells you how to falsify it,
 * rather than claiming a pass.
 */
static void checkReed() {
  head("Reed switch");
  pinMode(PIN_REED, INPUT_PULLUP);
  delay(5);
  bool open = digitalRead(PIN_REED) == HIGH;
  g_s.reedOpen = open;
  Serial.printf("      GPIO%d reads %s -> door %s\n", PIN_REED,
                open ? "HIGH" : "LOW", open ? "OPEN" : "CLOSED");
  Serial.println("      Move the magnet against the switch and press r. If this");
  Serial.println("      line does not change, the switch is not wired to GND.");
}

static void checkLdr() {
  head("Light sensor");
  analogReadResolution(12);
  int raw = 0;
  for (int i = 0; i < 8; ++i) { raw += analogRead(PIN_LDR); delay(5); }
  raw /= 8;
  g_s.ldrRaw = raw;

  Serial.printf("      GPIO%d raw %d of 4095 -> %s (threshold %d)\n", PIN_LDR, raw,
                raw >= LDR_DARK_BELOW ? "LIGHT" : "DARK", LDR_DARK_BELOW);

  if (raw < 20 || raw > 4075) {
    // A rail-pinned reading is what a missing divider leg looks like. A working
    // LDR sits somewhere in the middle and moves when you cover it.
    result(false, "LDR divider",
           "pinned to a rail — check the 10k to GND and the LDR to 3V3");
  } else {
    result(true, "LDR divider", "reading in range; cover it and press r to confirm it moves");
  }
  Serial.println("      Calibrate LDR_DARK_BELOW on site from these numbers.");
}

/**
 * The LD2410C streams frames continuously with no prompting, so its presence is
 * simply whether bytes arrive. Checked at the raw UART level on purpose: this
 * keeps BenchCheck free of Library Manager, and it distinguishes "no bytes at
 * all" (wiring) from "bytes but no frame header" (baud or a swapped pair).
 */
static void checkRadar() {
  head("mmWave presence (LD2410C)");
  Serial2.begin(256000, SERIAL_8N1, PIN_LD2410_RX, PIN_LD2410_TX);
  Serial.printf("      UART2 RX=GPIO%d (<- module TX), TX=GPIO%d (-> module RX) @256000\n",
                PIN_LD2410_RX, PIN_LD2410_TX);

  while (Serial2.available()) Serial2.read();

  uint8_t window[4] = {0, 0, 0, 0};
  size_t bytes = 0;
  bool sawHeader = false;
  uint32_t start = millis();
  while (millis() - start < 400) {
    while (Serial2.available()) {
      uint8_t b = Serial2.read();
      bytes++;
      window[0] = window[1]; window[1] = window[2];
      window[2] = window[3]; window[3] = b;
      // Target-data frame header, little-endian on the wire.
      if (window[0] == 0xF4 && window[1] == 0xF3 && window[2] == 0xF2 &&
          window[3] == 0xF1) {
        sawHeader = true;
      }
    }
    delay(5);
  }

  g_s.radarBytes = (int)bytes;
  g_s.radarHeader = sawHeader;

  char msg[80];
  if (bytes == 0) {
    result(false, "LD2410C",
           "no bytes — check 5V, GND, and that TX/RX are crossed");
  } else if (sawHeader) {
    snprintf(msg, sizeof(msg), "%u bytes, valid frame header", (unsigned)bytes);
    result(true, "LD2410C", msg);
  } else {
    snprintf(msg, sizeof(msg),
             "%u bytes but no frame header — wrong baud, or TX/RX swapped",
             (unsigned)bytes);
    result(false, "LD2410C", msg);
  }
}

static bool i2cAck(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

/**
 * Both ToF sensors ship on 0x29, so they are brought up one at a time behind
 * their XSHUT pins — the same sequence the firmware uses. Testing them together
 * would just show one address and tell you nothing about which sensor answered.
 */
static void checkToF() {
  head("Footfall sensors (VL53L0X)");
  pinMode(PIN_TOF_OUTER_XSHUT, OUTPUT);
  pinMode(PIN_TOF_INNER_XSHUT, OUTPUT);

  digitalWrite(PIN_TOF_OUTER_XSHUT, LOW);
  digitalWrite(PIN_TOF_INNER_XSHUT, LOW);
  delay(30);
  if (i2cAck(0x29)) {
    // Something is answering while both sensors are held in reset, so the XSHUT
    // lines are not actually controlling anything.
    result(false, "XSHUT control",
           "0x29 answers with both sensors in reset — XSHUT pins are not wired");
  } else {
    g_s.xshutOk = true;
    result(true, "XSHUT control", "both sensors silent while held in reset");
  }

  digitalWrite(PIN_TOF_OUTER_XSHUT, HIGH);
  delay(30);
  bool outer = i2cAck(0x29);
  g_s.tofOuter = outer;
  result(outer, "ToF outer (corridor)",
         outer ? "answers at 0x29" : "silent — check VIN, GND, SDA/SCL and its XSHUT");

  digitalWrite(PIN_TOF_OUTER_XSHUT, LOW);
  delay(30);
  digitalWrite(PIN_TOF_INNER_XSHUT, HIGH);
  delay(30);
  bool inner = i2cAck(0x29);
  g_s.tofInner = inner;
  result(inner, "ToF inner (room)",
         inner ? "answers at 0x29" : "silent — check VIN, GND, SDA/SCL and its XSHUT");

  digitalWrite(PIN_TOF_OUTER_XSHUT, HIGH);
  delay(20);

  if (outer && inner) {
    Serial.println("      Both answer individually. Which one is \"outer\" is a wiring");
    Serial.println("      decision — get it backwards and every entry is logged as an exit.");
  }
}

#endif  // BOARD_ROOM_MONITOR

// ── run ─────────────────────────────────────────────────────────────────────

/**
 * Everything on one line, last thing printed, so a single copy captures the
 * whole state of the bench.
 */
static void printSummaryLine() {
  Serial.println();
  Serial.print("PASTE-THIS> ");
  Serial.printf("chip=%s", ESP.getChipModel());
  if (g_isCam) Serial.print(" board=ESP32-CAM");
#if defined(BOARD_WITNESS)
  Serial.printf(" psram=%s camera=%s", g_s.psram ? "OK" : "NO",
                g_s.camera ? "OK" : "NO");
#endif
  Serial.printf(" i2c=%d rtc=%s sd=%s/%s", g_s.i2cCount,
                g_s.rtc ? "OK" : "NO",
                g_s.sdMounted ? "MOUNT" : "NO",
                g_s.sdWrite ? "RW" : "NO");
#if defined(BOARD_ROOM_MONITOR)
  if (g_isCam) {
    Serial.println();
    Serial.println();
    Serial.println("      ^ copy that one line and send it. It has everything.");
    return;
  }
  Serial.printf(" reed=%s ldr=%d radar=%d/%s xshut=%s tof=%s,%s",
                g_s.reedOpen ? "OPEN" : "CLOSED", g_s.ldrRaw, g_s.radarBytes,
                g_s.radarHeader ? "HDR" : "nohdr",
                g_s.xshutOk ? "OK" : "NO",
                g_s.tofOuter ? "OUT" : "-", g_s.tofInner ? "IN" : "-");
#endif
  Serial.println();
  Serial.println();
  Serial.println("      ^ copy that one line and send it. It has everything.");
}

static void runAll() {
  g_pass = g_fail = 0;
  Serial.println();
  Serial.println("════════════════════════════════════════════════════════════════");
  Serial.println("  Mohar bench check");
  Serial.println("════════════════════════════════════════════════════════════════");

  checkChip();
#if defined(BOARD_WITNESS)
  checkI2C();
  checkCard();
  checkCamera();
#else
  if (g_isCam) {
    // Deliberately shallow. This build knows it is on the wrong pin map for an
    // ESP32-CAM, so it reports what it is sure of and refuses to probe blind.
    head("ESP32-CAM detected");
    Serial.println("      4 MB PSRAM present, so this is an ESP32-CAM, not a devkit.");
    Serial.println("      The room-monitor pin map does not apply to this board:");
    Serial.println("      GPIO16 is the PSRAM chip select and GPIO21/22 belong to");
    Serial.println("      the camera. Sensor checks are skipped rather than run");
    Serial.println("      against pins that would take the board down.");
    Serial.println();
    Serial.println("      Getting this far means the programmer works, which is");
    Serial.println("      the only thing this upload had to prove.");
    result(true, "Programmer path", "sketch uploaded, booted and is talking");
  } else {
    checkI2C();
    checkCard();
    checkReed();
    checkLdr();
    checkRadar();
    checkToF();
  }
#endif

  head("Summary");
  Serial.printf("      %d passed, %d failed\n", g_pass, g_fail);
  printSummaryLine();
  if (g_fail == 0) {
    Serial.println("      Everything wired so far is answering. Add the next");
    Serial.println("      peripheral and press r.");
  } else {
    Serial.println("      Fix the FAIL lines above before wiring anything else —");
    Serial.println("      a second fault on top of a first is much harder to read.");
  }
  Serial.println();
  Serial.println("      press r to re-run");
}

void setup() {
  Serial.begin(115200);
  // The S3's USB CDC port enumerates a moment after boot. Without this wait the
  // first half of the report is written into a port nobody is listening on yet.
  uint32_t start = millis();
  while (!Serial && millis() - start < 3000) delay(50);
  delay(400);

  // Before anything else touches a pin.
  g_isCam = psramFound();

  runAll();
}

void loop() {
  if (Serial.available() && (Serial.read() == 'r' || Serial.read() == 'R')) {
    runAll();
  }
  delay(50);
}
