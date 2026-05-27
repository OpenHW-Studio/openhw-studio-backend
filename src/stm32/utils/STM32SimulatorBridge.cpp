#include "SimulatorBridge.h"
#include <Arduino.h>
#include "SPI.h"

extern "C" {
    volatile uint8_t sim_gpio_state[SIM_GPIO_COUNT];
    volatile uint8_t sim_gpio_mode[SIM_GPIO_COUNT];
    volatile uint16_t sim_gpio_analog_value[SIM_GPIO_COUNT];
}

volatile bool sim_dht_enabled[SIM_GPIO_COUNT] = {false};
volatile int16_t sim_dht_temp[SIM_GPIO_COUNT] = {240}; // 24.0 C
volatile uint16_t sim_dht_hum[SIM_GPIO_COUNT] = {500}; // 50.0 %
volatile bool sim_dht_in_progress[SIM_GPIO_COUNT] = {false};
volatile unsigned long sim_dht_low_start_us[SIM_GPIO_COUNT] = {0};
volatile unsigned long sim_dht_trigger_us[SIM_GPIO_COUNT] = {0};

bool _sim_ready_sent = false;
unsigned long _last_beat_ms = 0;

extern "C" {
    volatile uint8_t _sim_spi_rx_buf[SIM_SPI_RX_MAX];
    volatile uint16_t _sim_spi_rx_head;
    volatile uint16_t _sim_spi_rx_tail;
}

static void _sim_uart_putc(char c) {
    _SIM_USART1_DR = (uint8_t)c;
}

static void _sim_uart_puts(const char* s) {
    while (*s) _sim_uart_putc(*s++);
}

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

uint32_t get_flat_pin(uint32_t pin) {
    uint32_t pin8 = (uint8_t)(int8_t)pin;
    PinName stmPin = digitalPinToPinName(pin8);
    if (stmPin == NC) {
        if (pin8 < SIM_GPIO_COUNT) return pin8;
        return 0xFF;
    }
    uint32_t port = STM_PORT(stmPin);
    uint32_t pinNum = STM_PIN(stmPin);
    uint32_t flat = port * 16 + pinNum;
    if (flat >= SIM_GPIO_COUNT) {
        if (pin8 < SIM_GPIO_COUNT) return pin8;
        return 0xFF;
    }
    return flat;
}

const char* _get_pin_name(uint32_t pin) {
    uint32_t flat = get_flat_pin(pin);
    if (flat == 0xFF) return nullptr;
    
    static char nameBuf[8];
    uint32_t port = flat / 16;
    uint32_t pinNum = flat % 16;
    if (port < 8) {
        snprintf(nameBuf, sizeof(nameBuf), "P%c%d", 'A' + port, pinNum);
        return nameBuf;
    }
    return nullptr;
}

int _parse_pin_name(const String& pinStr) {
    if (pinStr.length() >= 3 && pinStr[0] == 'P') {
        char portChar = pinStr[1];
        int pinNum = pinStr.substring(2).toInt();
        int port = portChar - 'A';
        if (port >= 0 && port < 8 && pinNum >= 0 && pinNum < 16) {
            return port * 16 + pinNum;
        }
    }
    return get_flat_pin(pinStr.toInt());
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

extern "C" void sim_pinMode(uint32_t pin, uint32_t mode) {
    uint32_t flatPin = get_flat_pin(pin);
    if (flatPin == 0xFF) return;
    _process_serial_input();

    if (sim_dht_enabled[flatPin]) {
        if (mode == INPUT || mode == INPUT_PULLUP) {
            if (sim_gpio_mode[flatPin] == OUTPUT && sim_gpio_state[flatPin] == 0) {
                unsigned long low_duration = micros() - sim_dht_low_start_us[flatPin];
                if (low_duration > 800) {
                    sim_dht_trigger_us[flatPin] = micros();
                    sim_dht_in_progress[flatPin] = true;
                }
            }
        }
    }

    sim_gpio_mode[flatPin] = mode;
    if (mode == INPUT_PULLUP && sim_gpio_state[flatPin] == 0xFF) {
        sim_gpio_state[flatPin] = 1;
    } else if (mode == INPUT_PULLDOWN && sim_gpio_state[flatPin] == 0xFF) {
        sim_gpio_state[flatPin] = 0;
    }
}

extern "C" uint32_t sim_digitalRead(uint32_t pin) {
    uint32_t flatPin = get_flat_pin(pin);
    if (flatPin == 0xFF) return LOW;
    _process_serial_input();

    if (sim_dht_enabled[flatPin]) {
        if (sim_dht_in_progress[flatPin]) {
            unsigned long elapsed = micros() - sim_dht_trigger_us[flatPin];
            if (elapsed < 40) return HIGH;
            if (elapsed < 120) return LOW;
            if (elapsed < 200) return HIGH;
            
            unsigned long bit_start = 200;
            uint16_t h_val = sim_dht_hum[flatPin];
            int16_t t_val = sim_dht_temp[flatPin];
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
            sim_dht_in_progress[flatPin] = false;
            return HIGH;
        }
        return HIGH;
    }

    uint8_t val = sim_gpio_state[flatPin];
    if (val == 0xFF) {
        return (sim_gpio_mode[flatPin] == INPUT_PULLUP) ? HIGH : LOW;
    }
    return val;
}

extern "C" void sim_digitalWrite(uint32_t pin, uint32_t value) {
    uint32_t flatPin = get_flat_pin(pin);
    if (flatPin == 0xFF) return;
    SPI.flush();
    _process_serial_input();

    char dbg[64];
    snprintf(dbg, sizeof(dbg), "digitalWrite pin=%lu (flat=%lu) val=%lu", pin, flatPin, value);
    // sim_log(SIM_INFO, dbg);

    if (sim_dht_enabled[flatPin]) {
        if (value == 0) {
            if (sim_gpio_state[flatPin] != 0) {
                sim_dht_low_start_us[flatPin] = micros();
            }
        } else {
            if (sim_gpio_state[flatPin] == 0) {
                unsigned long low_duration = micros() - sim_dht_low_start_us[flatPin];
                if (low_duration > 800) {
                    sim_dht_trigger_us[flatPin] = micros();
                    sim_dht_in_progress[flatPin] = true;
                }
            }
        }
    }

    const uint8_t level = value ? 1 : 0;
    if (sim_gpio_state[flatPin] == level) return;
    sim_gpio_state[flatPin] = level;

    const char* pinName = _get_pin_name(pin);
    if (!pinName) return;

    char frame[32];
    snprintf(frame, sizeof(frame), ">GPIO:%s:%d<", pinName, level);
    _sim_send(frame);
}

extern "C" uint32_t sim_analogRead(uint32_t pin) {
    uint32_t flatPin = get_flat_pin(pin);
    if (flatPin == 0xFF) return 0;
    _process_serial_input();
    uint16_t val = sim_gpio_analog_value[flatPin];
    if (val == 0xFFFF) {
        uint8_t dig = sim_gpio_state[flatPin];
        if (dig == 0xFF) return 0;
        return dig ? 4095 : 0;
    }
    return val;
}

extern "C" void sim_tone(uint32_t pin, unsigned int frequency, unsigned long duration) {
    _process_serial_input();
    const char* pinName = _get_pin_name(pin);
    if (!pinName) return;

    char frame[64];
    snprintf(frame, sizeof(frame), ">TONE:%s:%u:%lu<", pinName, frequency, duration);
    _sim_send(frame);
}

extern "C" void sim_noTone(uint32_t pin) {
    _process_serial_input();
    const char* pinName = _get_pin_name(pin);
    if (!pinName) return;

    char frame[64];
    snprintf(frame, sizeof(frame), ">TONE:%s:0:0<", pinName);
    _sim_send(frame);
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
