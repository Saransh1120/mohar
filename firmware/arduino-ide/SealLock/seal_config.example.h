#pragma once

// Copy to seal_config.h and provision each board separately. Never commit keys.
#define DEVICE_ID "CHANGE_ME_DEVICE_UUID"
#define EXAM_ID "CHANGE_ME_EXAM_UUID"
#define CENTRE_ID "CHANGE_ME_CENTRE_UUID"
#define PACKAGE_ID "CHANGE_ME_PACKAGE_UUID"
#define DEVICE_PRIVATE_KEY_HEX "CHANGE_ME_64_HEX"
#define DEVICE_PUBLIC_KEY_HEX "CHANGE_ME_64_HEX"
#define AUTHORITY_PUBLIC_KEY_HEX "CHANGE_ME_64_HEX"
#define WIFI_SSID "CHANGE_ME"
#define WIFI_PASSWORD "CHANGE_ME"
// Point at the gateway, which forwards signed /events to the private ledger.
#define LEDGER_URL "http://192.168.1.10:8081"

// GPIO numbers for the ESP32-C6 board and driver actually fitted.
//
// Not 4, 5, 8, 9 or 15: those are the C6's strapping pins, and the sketch
// refuses to compile with the solenoid on one. Not 12 or 13 (USB), 16 or 17
// (the service UART the commands arrive on), 22 or 23 (I2C to the DS3231).
#define SOLENOID_PIN 10
#define TAMPER_PIN 11
#define REED_PIN 6

// Driver LOW means de-energised and mechanically locked. Inputs use pull-ups.
// Fit a 10 k resistor from the driver's gate to the de-energised level: the
// GPIO floats while the chip is in reset or being flashed, and firmware cannot
// hold it then.
#define SOLENOID_ACTIVE_HIGH 1
#define TAMPER_OPEN_LEVEL LOW
#define REED_CLOSED_LEVEL LOW

// How long an authorised command holds the coil, 200 to 10000 ms. Keep it
// inside the solenoid's rated on-time.
#define SOLENOID_PULSE_MS 5000
