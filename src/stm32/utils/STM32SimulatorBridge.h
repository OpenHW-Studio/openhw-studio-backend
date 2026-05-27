/**
 * STM32SimulatorBridge.h    STM32 Renode GPIO + Serial Shim
 * 
 * Injected at compile time by compileController.js.
 * Communicates over Serial1 (USART1 on PA9/PA10).
 */

#ifndef STM32_SIMULATOR_BRIDGE_H
#define STM32_SIMULATOR_BRIDGE_H

#include <Arduino.h>

#define SIM_GPIO_COUNT      128
#define SIM_CMD_MAX_LEN     64
#define SIM_UART_BAUD       115200

// Log-level tokens
#define SIM_INFO    "INFO"
#define SIM_WARN    "WARN"
#define SIM_ERROR   "ERROR"
#define SIM_SUCCESS "OK"

// Set all pins initially to 0xFF (floating/un-driven state)
extern "C" {
    volatile uint8_t sim_gpio_state[SIM_GPIO_COUNT];
    volatile uint8_t sim_gpio_mode[SIM_GPIO_COUNT];
    volatile uint16_t sim_gpio_analog_value[SIM_GPIO_COUNT];
}

// DHT State
volatile bool sim_dht_enabled[SIM_GPIO_COUNT] = {false};
volatile int16_t sim_dht_temp[SIM_GPIO_COUNT] = {240}; // 24.0 C
volatile uint16_t sim_dht_hum[SIM_GPIO_COUNT] = {500}; // 50.0 %
volatile bool sim_dht_in_progress[SIM_GPIO_COUNT] = {false};
volatile unsigned long sim_dht_low_start_us[SIM_GPIO_COUNT] = {0};
volatile unsigned long sim_dht_trigger_us[SIM_GPIO_COUNT] = {0};

bool _sim_ready_sent = false;
unsigned long _last_beat_ms = 0;

// ── Direct USART1 polling TX ──────────────────────────────────────────────
// The STM32 Arduino core uses interrupt-driven TX: Serial1.print() places
// bytes in a software ring buffer; the USART1_IRQHandler drains the buffer
// to USART1_DR one byte at a time.  In Renode this DEADLOCKS: the interrupt
// fires only when the firmware writes to DR, but the firmware waits for the
// interrupt before writing.  The symptom is that flush() spins forever and
// sim_ready() is never called.
//
// FIX: Write directly to USART1_DR with a TXE poll.
// In Renode, TXE (bit 7 of USART_SR at 0x40013800) is always 1 because
// Renode's UART model has infinite TX capacity.  On real hardware this also
// works because the register set-up by Serial1.begin() has already enabled
// the USART.  The timeout prevents accidental infinite loops on real HW if
// the USART is mis-configured.

#define _SIM_USART1_SR  (*(volatile uint32_t*)0x40013800u)  // USART1 status reg
#define _SIM_USART1_DR  (*(volatile uint32_t*)0x40013804u)  // USART1 data reg

static void _sim_uart_putc(char c) {
    _SIM_USART1_DR = (uint8_t)c;
}

static void _sim_uart_puts(const char* s) {
    while (*s) _sim_uart_putc(*s++);
}

// _sim_send — the single entry point for all outbound frames.
// Wraps the frame in newlines so the host-side FrameParser can detect it.
static void _sim_send(const char* frame) {
    _sim_uart_putc('\n');
    _sim_uart_puts(frame);
    _sim_uart_putc('\n');
}

void sim_wire_emit(const char* frame) {
    _sim_send(frame);
}

void sim_log(const char* level, const char* msg) {
    char frame[256];
    snprintf(frame, sizeof(frame), ">SIM:LOG:%s:%s<", level, msg);
    _sim_send(frame);
}
void sim_log(const char* level, const String& msg) { sim_log(level, msg.c_str()); }

void sim_ready() {
    if (_sim_ready_sent) return;
    _sim_ready_sent = true;
    _sim_send(">SIM:READY<");
    sim_log(SIM_SUCCESS, "STM32 Device ready");
}

// SPI RX Ring Buffer
#define SIM_SPI_RX_MAX 256
extern "C" {
    volatile uint8_t _sim_spi_rx_buf[SIM_SPI_RX_MAX];
    volatile uint16_t _sim_spi_rx_head;
    volatile uint16_t _sim_spi_rx_tail;
}

// Shared Wire Buffers
#define SIM_WIRE_RX_SIZE 64
extern "C" {
    extern volatile uint8_t  sim_wire_rx_buf[SIM_WIRE_RX_SIZE];
    extern volatile uint8_t  sim_wire_rx_len;
    extern volatile bool     sim_wire_rx_ready;
}

// Convert STM32 numeric pin to string name (e.g. PA5)
const char* _get_pin_name(uint8_t pin) {
    #ifdef PA0
    if (pin == PA0) return "PA0";
    #endif
    #ifdef PA1
    if (pin == PA1) return "PA1";
    #endif
    #ifdef PA2
    if (pin == PA2) return "PA2";
    #endif
    #ifdef PA3
    if (pin == PA3) return "PA3";
    #endif
    #ifdef PA4
    if (pin == PA4) return "PA4";
    #endif
    #ifdef PA5
    if (pin == PA5) return "PA5";
    #endif
    #ifdef PA6
    if (pin == PA6) return "PA6";
    #endif
    #ifdef PA7
    if (pin == PA7) return "PA7";
    #endif
    #ifdef PA8
    if (pin == PA8) return "PA8";
    #endif
    #ifdef PA9
    if (pin == PA9) return "PA9";
    #endif
    #ifdef PA10
    if (pin == PA10) return "PA10";
    #endif
    #ifdef PA11
    if (pin == PA11) return "PA11";
    #endif
    #ifdef PA12
    if (pin == PA12) return "PA12";
    #endif
    #ifdef PA13
    if (pin == PA13) return "PA13";
    #endif
    #ifdef PA14
    if (pin == PA14) return "PA14";
    #endif
    #ifdef PA15
    if (pin == PA15) return "PA15";
    #endif

    #ifdef PB0
    if (pin == PB0) return "PB0";
    #endif
    #ifdef PB1
    if (pin == PB1) return "PB1";
    #endif
    #ifdef PB2
    if (pin == PB2) return "PB2";
    #endif
    #ifdef PB3
    if (pin == PB3) return "PB3";
    #endif
    #ifdef PB4
    if (pin == PB4) return "PB4";
    #endif
    #ifdef PB5
    if (pin == PB5) return "PB5";
    #endif
    #ifdef PB6
    if (pin == PB6) return "PB6";
    #endif
    #ifdef PB7
    if (pin == PB7) return "PB7";
    #endif
    #ifdef PB8
    if (pin == PB8) return "PB8";
    #endif
    #ifdef PB9
    if (pin == PB9) return "PB9";
    #endif
    #ifdef PB10
    if (pin == PB10) return "PB10";
    #endif
    #ifdef PB11
    if (pin == PB11) return "PB11";
    #endif
    #ifdef PB12
    if (pin == PB12) return "PB12";
    #endif
    #ifdef PB13
    if (pin == PB13) return "PB13";
    #endif
    #ifdef PB14
    if (pin == PB14) return "PB14";
    #endif
    #ifdef PB15
    if (pin == PB15) return "PB15";
    #endif

    #ifdef PC13
    if (pin == PC13) return "PC13";
    #endif
    #ifdef PC14
    if (pin == PC14) return "PC14";
    #endif
    #ifdef PC15
    if (pin == PC15) return "PC15";
    #endif

    return nullptr;
}

// Convert string pin name to numeric pin
int _parse_pin_name(const String& pinStr) {
    #ifdef PA0
    if (pinStr == "PA0") return PA0;
    #endif
    #ifdef PA1
    if (pinStr == "PA1") return PA1;
    #endif
    #ifdef PA2
    if (pinStr == "PA2") return PA2;
    #endif
    #ifdef PA3
    if (pinStr == "PA3") return PA3;
    #endif
    #ifdef PA4
    if (pinStr == "PA4") return PA4;
    #endif
    #ifdef PA5
    if (pinStr == "PA5") return PA5;
    #endif
    #ifdef PA6
    if (pinStr == "PA6") return PA6;
    #endif
    #ifdef PA7
    if (pinStr == "PA7") return PA7;
    #endif
    #ifdef PA8
    if (pinStr == "PA8") return PA8;
    #endif
    #ifdef PA9
    if (pinStr == "PA9") return PA9;
    #endif
    #ifdef PA10
    if (pinStr == "PA10") return PA10;
    #endif
    #ifdef PA11
    if (pinStr == "PA11") return PA11;
    #endif
    #ifdef PA12
    if (pinStr == "PA12") return PA12;
    #endif
    #ifdef PA13
    if (pinStr == "PA13") return PA13;
    #endif
    #ifdef PA14
    if (pinStr == "PA14") return PA14;
    #endif
    #ifdef PA15
    if (pinStr == "PA15") return PA15;
    #endif

    #ifdef PB0
    if (pinStr == "PB0") return PB0;
    #endif
    #ifdef PB1
    if (pinStr == "PB1") return PB1;
    #endif
    #ifdef PB2
    if (pinStr == "PB2") return PB2;
    #endif
    #ifdef PB3
    if (pinStr == "PB3") return PB3;
    #endif
    #ifdef PB4
    if (pinStr == "PB4") return PB4;
    #endif
    #ifdef PB5
    if (pinStr == "PB5") return PB5;
    #endif
    #ifdef PB6
    if (pinStr == "PB6") return PB6;
    #endif
    #ifdef PB7
    if (pinStr == "PB7") return PB7;
    #endif
    #ifdef PB8
    if (pinStr == "PB8") return PB8;
    #endif
    #ifdef PB9
    if (pinStr == "PB9") return PB9;
    #endif
    #ifdef PB10
    if (pinStr == "PB10") return PB10;
    #endif
    #ifdef PB11
    if (pinStr == "PB11") return PB11;
    #endif
    #ifdef PB12
    if (pinStr == "PB12") return PB12;
    #endif
    #ifdef PB13
    if (pinStr == "PB13") return PB13;
    #endif
    #ifdef PB14
    if (pinStr == "PB14") return PB14;
    #endif
    #ifdef PB15
    if (pinStr == "PB15") return PB15;
    #endif

    #ifdef PC13
    if (pinStr == "PC13") return PC13;
    #endif
    #ifdef PC14
    if (pinStr == "PC14") return PC14;
    #endif
    #ifdef PC15
    if (pinStr == "PC15") return PC15;
    #endif

    return pinStr.toInt();
}

static String rxBuf = "";
static unsigned long _last_serial_check_us = 0;

void _process_serial_input() {
    unsigned long now = micros();
    if (now - _last_serial_check_us < 200) return;
    _last_serial_check_us = now;

    if (!Serial1) return;

    // Check heartbeat
    if (_sim_ready_sent && (millis() - _last_beat_ms >= 5000)) {
        _last_beat_ms = millis();
        _sim_send(">SIM:BEAT<");
    }

    while (Serial1.available() > 0) {
        char c = (char)Serial1.read();
        if (c == '\n') {
            if (rxBuf.length() > 6 && rxBuf.charAt(0) == '<') {
                if (rxBuf.startsWith("<GPIO:")) {
                    int c1 = rxBuf.indexOf(':');
                    int c2 = rxBuf.indexOf(':', c1 + 1);
                    int cl = rxBuf.indexOf('>', c2);
                    if (c1 > 0 && c2 > c1 && cl > c2) {
                        String pinStr = rxBuf.substring(c1 + 1, c2);
                        int val = rxBuf.substring(c2 + 1, cl).toInt();
                        int pin = _parse_pin_name(pinStr);
                        if (pin >= 0 && pin < SIM_GPIO_COUNT) {
                            sim_gpio_state[pin] = val ? 1 : 0;
                            sim_gpio_analog_value[pin] = (uint16_t)val;
                        }
                    }
                }
                else if (rxBuf.startsWith("<ADC:")) {
                    int c1 = rxBuf.indexOf(':');
                    int c2 = rxBuf.indexOf(':', c1 + 1);
                    int cl = rxBuf.indexOf('>', c2);
                    if (c1 > 0 && c2 > c1 && cl > c2) {
                        String pinStr = rxBuf.substring(c1 + 1, c2);
                        int val = rxBuf.substring(c2 + 1, cl).toInt();
                        int pin = _parse_pin_name(pinStr);
                        if (pin >= 0 && pin < SIM_GPIO_COUNT) {
                            sim_gpio_analog_value[pin] = (uint16_t)(val & 0x0FFF);
                        }
                    }
                }
                else if (rxBuf.startsWith("<I2C_RESP:")) {
                    int c1 = rxBuf.indexOf(':');
                    int c2 = rxBuf.indexOf(':', c1 + 1);
                    int cl = rxBuf.indexOf('>', c2);
                    if (c1 > 0 && c2 > c1 && cl > c2) {
                        String hex = rxBuf.substring(c2 + 1, cl);
                        uint8_t n = 0;
                        for (int i = 0; i + 1 < (int)hex.length() && n < SIM_WIRE_RX_SIZE; i += 2) {
                            char hb[3] = { hex.charAt(i), hex.charAt(i + 1), '\0' };
                            sim_wire_rx_buf[n++] = (uint8_t)strtoul(hb, nullptr, 16);
                        }
                        sim_wire_rx_len = n;
                        sim_wire_rx_ready = true;
                    }
                }
                else if (rxBuf.startsWith("<SPI_RESP:")) {
                    int c1 = rxBuf.indexOf(':');
                    int cl = rxBuf.indexOf('>', c1 + 1);
                    if (c1 > 0 && cl > c1) {
                        String hex = rxBuf.substring(c1 + 1, cl);
                        for (int i = 0; i + 1 < (int)hex.length(); i += 2) {
                            char hb[3] = { hex.charAt(i), hex.charAt(i + 1), '\0' };
                            uint8_t b = (uint8_t)strtoul(hb, nullptr, 16);
                            uint16_t next = (_sim_spi_rx_head + 1) % SIM_SPI_RX_MAX;
                            if (next != _sim_spi_rx_tail) {
                                _sim_spi_rx_buf[_sim_spi_rx_head] = b;
                                _sim_spi_rx_head = next;
                            }
                        }
                    }
                }
                else if (rxBuf.startsWith("<DHT:")) {
                    int c1 = rxBuf.indexOf(':');
                    int c2 = rxBuf.indexOf(':', c1 + 1);
                    int c3 = rxBuf.indexOf(':', c2 + 1);
                    int cl = rxBuf.indexOf('>', c3);
                    if (c1 > 0 && c2 > c1 && c3 > c2 && cl > c3) {
                        String pinStr = rxBuf.substring(c1 + 1, c2);
                        int temp = rxBuf.substring(c2 + 1, c3).toInt();
                        int hum  = rxBuf.substring(c3 + 1, cl).toInt();
                        int pin = _parse_pin_name(pinStr);
                        if (pin >= 0 && pin < SIM_GPIO_COUNT) {
                            sim_dht_enabled[pin] = true;
                            sim_dht_temp[pin] = (int16_t)temp;
                            sim_dht_hum[pin] = (uint16_t)hum;
                        }
                    }
                }
            }
            rxBuf = "";
        } else if (c != '\r') {
            if (rxBuf.length() < SIM_CMD_MAX_LEN) rxBuf += c;
            else rxBuf = "";
        }
    }
}

// Hook into standard yield() so background simulation work runs frequently
extern "C" void yield(void) {
    _process_serial_input();
    __asm__ volatile("wfi");
}

void sim_pinMode(uint8_t pin, uint8_t mode) {
    if (pin >= SIM_GPIO_COUNT) return;
    _process_serial_input();

    if (sim_dht_enabled[pin]) {
        if (mode == INPUT || mode == INPUT_PULLUP) {
            if (sim_gpio_mode[pin] == OUTPUT && sim_gpio_state[pin] == 0) {
                unsigned long low_duration = micros() - sim_dht_low_start_us[pin];
                if (low_duration > 800) {
                    sim_dht_trigger_us[pin] = micros();
                    sim_dht_in_progress[pin] = true;
                }
            }
        }
    }

    sim_gpio_mode[pin] = mode;
    if (mode == INPUT_PULLUP && sim_gpio_state[pin] == 0xFF) {
        sim_gpio_state[pin] = 1;
    } else if (mode == INPUT_PULLDOWN && sim_gpio_state[pin] == 0xFF) {
        sim_gpio_state[pin] = 0;
    }
}

uint8_t sim_digitalRead(uint8_t pin) {
    if (pin >= SIM_GPIO_COUNT) return LOW;
    _process_serial_input();

    if (sim_dht_enabled[pin]) {
        if (sim_dht_in_progress[pin]) {
            unsigned long elapsed = micros() - sim_dht_trigger_us[pin];
            if (elapsed < 40) return HIGH;
            if (elapsed < 120) return LOW;
            if (elapsed < 200) return HIGH;
            
            unsigned long bit_start = 200;
            uint16_t h_val = sim_dht_hum[pin];
            int16_t t_val = sim_dht_temp[pin];
            uint16_t t_unsigned = abs(t_val);
            if (t_val < 0) t_unsigned |= 0x8000;
            uint8_t checksum = ((h_val >> 8) + (h_val & 0xFF) + (t_unsigned >> 8) + (t_unsigned & 0xFF)) & 0xFF;
            
            for (int i = 0; i < 40; i++) {
                bool bit_val = false;
                if (i < 16) bit_val = (h_val >> (15 - i)) & 1;
                else if (i < 32) bit_val = (t_unsigned >> (31 - i)) & 1;
                else bit_val = (checksum >> (39 - i)) & 1;
                
                unsigned long bit_len = 50 + (bit_val ? 70 : 27);
                if (elapsed >= bit_start && elapsed < bit_start + bit_len) {
                    unsigned long bit_elapsed = elapsed - bit_start;
                    return (bit_elapsed < 50) ? LOW : HIGH;
                }
                bit_start += bit_len;
            }
            
            if (elapsed >= bit_start && elapsed < bit_start + 50) return LOW;
            sim_dht_in_progress[pin] = false;
            return HIGH;
        }
        return HIGH;
    }

    uint8_t val = sim_gpio_state[pin];
    if (val == 0xFF) {
        return (sim_gpio_mode[pin] == INPUT_PULLUP) ? HIGH : LOW;
    }
    return val;
}

void sim_digitalWrite(uint8_t pin, uint8_t value) {
    if (pin >= SIM_GPIO_COUNT) return;
    _process_serial_input();

    if (sim_dht_enabled[pin]) {
        if (value == 0) {
            if (sim_gpio_state[pin] != 0) {
                sim_dht_low_start_us[pin] = micros();
            }
        } else {
            if (sim_gpio_state[pin] == 0) {
                unsigned long low_duration = micros() - sim_dht_low_start_us[pin];
                if (low_duration > 800) {
                    sim_dht_trigger_us[pin] = micros();
                    sim_dht_in_progress[pin] = true;
                }
            }
        }
    }

    const uint8_t level = value ? 1 : 0;
    if (sim_gpio_state[pin] == level) return;
    sim_gpio_state[pin] = level;

    const char* pinName = _get_pin_name(pin);
    if (!pinName) return;

    char frame[32];
    snprintf(frame, sizeof(frame), ">GPIO:%s:%d<", pinName, level);
    _sim_send(frame);
}

uint16_t sim_analogRead(uint8_t pin) {
    if (pin >= SIM_GPIO_COUNT) return 0;
    _process_serial_input();
    uint16_t val = sim_gpio_analog_value[pin];
    if (val == 0xFFFF) {
        uint8_t dig = sim_gpio_state[pin];
        if (dig == 0xFF) return 0;
        return dig ? 4095 : 0;
    }
    return val;
}

void _simBridgeInit_Early() {
    for (int i = 0; i < SIM_GPIO_COUNT; i++) {
        sim_gpio_state[i] = 0xFF;
        sim_gpio_mode[i] = 0;
        sim_gpio_analog_value[i] = 0xFFFF;
    }
    _sim_spi_rx_head = 0;
    _sim_spi_rx_tail = 0;
    sim_wire_rx_len = 0;
    sim_wire_rx_ready = false;

    // Renode uses Serial1 (USART1) for communication
    Serial1.begin(SIM_UART_BAUD);
}

void _simBridgeInit_Late() {
    // Use direct polling writes (not Serial1.println) so the banner is
    // emitted without depending on the USART interrupt path.
    _sim_uart_puts("\r\n\r\n  STM32 Simulator Started\r\n");
    _sim_uart_puts("  Status        : READY\r\n");
    _sim_uart_puts("  GPIO System   : OK\r\n");
    _sim_uart_puts("  Runtime       : ACTIVE\r\n\r\n");
    _last_beat_ms = millis();
}

#undef  pinMode
#undef  digitalRead
#undef  digitalWrite
#undef  analogRead

#define pinMode      sim_pinMode
#define digitalRead  sim_digitalRead
#define digitalWrite sim_digitalWrite
#define analogRead   sim_analogRead

#endif // STM32_SIMULATOR_BRIDGE_H
