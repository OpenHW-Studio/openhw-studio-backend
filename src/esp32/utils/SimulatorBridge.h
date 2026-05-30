/**
 * SimulatorBridge.h    ESP32 QEMU GPIO + Serial Shim  (v3.0  stable)
 * 
 * Injected at compile time by compileController.js.
 */

#ifndef SIMULATOR_BRIDGE_H
#define SIMULATOR_BRIDGE_H

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include "esp_log.h"
#include <esp_task_wdt.h>

//  Configuration 

#define SIM_GPIO_COUNT      40
#define SIM_CMD_MAX_LEN     64
#define SIM_UART_BAUD       115200
#define SIM_TASK_STACK      4096
#define SIM_TASK_PRIO       2
#define SIM_TASK_CORE       0
#define SIM_TASK_DELAY_MS   5
#define SIM_HEARTBEAT_MS    5000
#define SIM_BEAT_STACK      2048
#define SIM_BEAT_PRIO       1

// Log-level tokens
#define SIM_INFO    "INFO"
#define SIM_WARN    "WARN"
#define SIM_ERROR   "ERROR"
#define SIM_SUCCESS "OK"

//  GPIO state 
extern volatile uint8_t sim_gpio_state[SIM_GPIO_COUNT];
extern volatile uint8_t sim_gpio_mode[SIM_GPIO_COUNT];
extern volatile uint16_t sim_gpio_analog_value[SIM_GPIO_COUNT];

// --- DHT State ---
extern volatile bool sim_dht_enabled[SIM_GPIO_COUNT];
extern volatile int16_t sim_dht_temp[SIM_GPIO_COUNT];
extern volatile uint16_t sim_dht_hum[SIM_GPIO_COUNT];
extern volatile bool sim_dht_in_progress[SIM_GPIO_COUNT];
extern volatile unsigned long sim_dht_low_start_us[SIM_GPIO_COUNT];
extern volatile unsigned long sim_dht_trigger_us[SIM_GPIO_COUNT];

extern SemaphoreHandle_t _sim_serial_mtx;

void sim_wire_emit(const char* frame);
void sim_log(const char* level, const char* msg);
void sim_log(const char* level, const String& msg);
extern bool _sim_ready_sent;
void sim_ready();

#define SIM_SPI_RX_MAX 256
extern uint8_t           _sim_spi_rx_buf[SIM_SPI_RX_MAX];
extern volatile uint16_t _sim_spi_rx_head;
extern volatile uint16_t _sim_spi_rx_tail;

// Declarations
void sim_pinMode(uint8_t pin, uint8_t mode);
uint8_t sim_digitalRead(uint8_t pin);
void sim_digitalWrite(uint8_t pin, uint8_t value);
uint16_t sim_analogRead(uint8_t pin);
void sim_tone(uint8_t pin, unsigned int frequency, unsigned long duration = 0);
void sim_noTone(uint8_t pin);
void _simBridgeInit_Early();
void _simBridgeInit_Late();

//  Macro hijacking 
#undef  pinMode
#undef  digitalRead
#undef  digitalWrite
#undef  analogRead
#undef  tone
#undef  noTone

#define pinMode      sim_pinMode
#define digitalRead  sim_digitalRead
#define digitalWrite sim_digitalWrite
#define analogRead   sim_analogRead
#define tone         sim_tone
#define noTone       sim_noTone

#endif // SIMULATOR_BRIDGE_H
