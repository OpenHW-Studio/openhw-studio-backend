/**
 * STM32SimulatorBridge.h    STM32 Renode GPIO + Serial Shim
 * 
 * Injected at compile time by compileController.js.
 * Communicates over Serial1 (USART1 on PA9/PA10).
 */

#ifndef STM32_SIMULATOR_BRIDGE_H
#define STM32_SIMULATOR_BRIDGE_H

// Prevent fast direct register access in display libraries (forces fallback to digitalWrite shims)
#undef USE_FAST_PINIO
#undef BUSIO_USE_FAST_PINIO

#include <Arduino.h>

#define SIM_GPIO_COUNT      128
#define SIM_CMD_MAX_LEN     64
#define SIM_UART_BAUD       2000000

// Log-level tokens
#define SIM_INFO    "INFO"
#define SIM_WARN    "WARN"
#define SIM_ERROR   "ERROR"
#define SIM_SUCCESS "OK"

#define _SIM_USART1_SR  (*(volatile uint32_t*)0x40013800u)  // USART1 status reg
#define _SIM_USART1_DR  (*(volatile uint32_t*)0x40013804u)  // USART1 data reg

// Set all pins initially to 0xFF (floating/un-driven state)
extern "C" {
    extern volatile uint8_t sim_gpio_state[SIM_GPIO_COUNT];
    extern volatile uint8_t sim_gpio_mode[SIM_GPIO_COUNT];
    extern volatile uint16_t sim_gpio_analog_value[SIM_GPIO_COUNT];
}

// DHT State
extern volatile bool sim_dht_enabled[SIM_GPIO_COUNT];
extern volatile int16_t sim_dht_temp[SIM_GPIO_COUNT];
extern volatile uint16_t sim_dht_hum[SIM_GPIO_COUNT];
extern volatile bool sim_dht_in_progress[SIM_GPIO_COUNT];
extern volatile unsigned long sim_dht_low_start_us[SIM_GPIO_COUNT];
extern volatile unsigned long sim_dht_trigger_us[SIM_GPIO_COUNT];

extern bool _sim_ready_sent;
extern unsigned long _last_beat_ms;

// SPI RX Ring Buffer
#define SIM_SPI_RX_MAX 256
extern "C" {
    extern volatile uint8_t _sim_spi_rx_buf[SIM_SPI_RX_MAX];
    extern volatile uint16_t _sim_spi_rx_head;
    extern volatile uint16_t _sim_spi_rx_tail;
}

// Shared Wire Buffers
#define SIM_WIRE_RX_SIZE 64
extern "C" {
    extern volatile uint8_t  sim_wire_rx_buf[SIM_WIRE_RX_SIZE];
    extern volatile uint8_t  sim_wire_rx_len;
    extern volatile bool     sim_wire_rx_ready;
}

// Declarations
// C++ Helper Declarations (can be overloaded)
const char* _get_pin_name(uint32_t pin);
int _parse_pin_name(const String& pinStr);
void _process_serial_input();
void sim_wire_emit(const char* frame);
void sim_log(const char* level, const char* msg);
void sim_log(const char* level, const String& msg);
void sim_ready();
void _simBridgeInit_Early();
void _simBridgeInit_Late();

// C-compatible shims mapping directly to Arduino core APIs
extern "C" {
    void sim_pinMode(uint32_t pin, uint32_t mode);
    uint32_t sim_digitalRead(uint32_t pin);
    void sim_digitalWrite(uint32_t pin, uint32_t value);
    uint32_t sim_analogRead(uint32_t pin);
    void sim_tone(uint32_t pin, unsigned int frequency, unsigned long duration = 0);
    void sim_noTone(uint32_t pin);
}

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

#endif // STM32_SIMULATOR_BRIDGE_H
