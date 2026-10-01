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
#define LEDGER_URL "http://192.168.1.10:8080"

// GPIO numbers for the ESP32-C6 board and driver actually fitted.
#define SOLENOID_PIN 4
#define TAMPER_PIN 5
#define REED_PIN 6

// Driver LOW means de-energised and mechanically locked. Inputs use pull-ups.
#define SOLENOID_ACTIVE_HIGH 1
#define TAMPER_OPEN_LEVEL LOW
#define REED_CLOSED_LEVEL LOW
