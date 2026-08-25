#pragma once
#include "station_config.h"

/**
 * Camera and SD pin maps.
 *
 * The ESP32-S3 camera interface consumes sixteen GPIOs and the SDMMC slot three
 * more, which is why the witness station's own peripherals are squeezed into
 * what a given board leaves over. Adding a board means adding a block here, not
 * editing main.cpp.
 */

#if defined(CAMERA_MODEL_FREENOVE_S3)
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  15
#define SIOD_GPIO_NUM   4
#define SIOC_GPIO_NUM   5
#define Y9_GPIO_NUM    16
#define Y8_GPIO_NUM    17
#define Y7_GPIO_NUM    18
#define Y6_GPIO_NUM    12
#define Y5_GPIO_NUM    10
#define Y4_GPIO_NUM     8
#define Y3_GPIO_NUM     9
#define Y2_GPIO_NUM    11
#define VSYNC_GPIO_NUM  6
#define HREF_GPIO_NUM   7
#define PCLK_GPIO_NUM  13

#define SDMMC_CLK_PIN  39
#define SDMMC_CMD_PIN  38
#define SDMMC_D0_PIN   40

#elif defined(CAMERA_MODEL_XIAO_ESP32S3)
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  10
#define SIOD_GPIO_NUM  40
#define SIOC_GPIO_NUM  39
#define Y9_GPIO_NUM    48
#define Y8_GPIO_NUM    11
#define Y7_GPIO_NUM    12
#define Y6_GPIO_NUM    14
#define Y5_GPIO_NUM    16
#define Y4_GPIO_NUM    18
#define Y3_GPIO_NUM    17
#define Y2_GPIO_NUM    15
#define VSYNC_GPIO_NUM 38
#define HREF_GPIO_NUM  47
#define PCLK_GPIO_NUM  13

#define SDMMC_CLK_PIN   7
#define SDMMC_CMD_PIN   9
#define SDMMC_D0_PIN    8

#else
#error "Define exactly one CAMERA_MODEL_* in station_config.h"
#endif
