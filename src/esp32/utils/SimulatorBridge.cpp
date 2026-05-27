#include "SimulatorBridge.h"
#include <Arduino.h>
#include "SPI.h"
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include "esp_log.h"
#include <esp_task_wdt.h>

volatile uint8_t sim_gpio_state[SIM_GPIO_COUNT] = {
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF
};
volatile uint8_t sim_gpio_mode[SIM_GPIO_COUNT]  = {0};

volatile uint16_t sim_gpio_analog_value[SIM_GPIO_COUNT] = {
    0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF,
    0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF,
    0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF,
    0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF
};

volatile bool sim_dht_enabled[SIM_GPIO_COUNT] = {false};
volatile int16_t sim_dht_temp[SIM_GPIO_COUNT] = {240}; // 24.0 C
volatile uint16_t sim_dht_hum[SIM_GPIO_COUNT] = {500}; // 50.0 %
volatile bool sim_dht_in_progress[SIM_GPIO_COUNT] = {false};
volatile unsigned long sim_dht_low_start_us[SIM_GPIO_COUNT] = {0};
volatile unsigned long sim_dht_trigger_us[SIM_GPIO_COUNT] = {0};

SemaphoreHandle_t _sim_serial_mtx = nullptr;

static void _sim_send(const char* frame) {
    if (!_sim_serial_mtx) return;
    if (!Serial) return;
    if (xSemaphoreTake(_sim_serial_mtx, pdMS_TO_TICKS(10)) == pdTRUE) {
        Serial.print('\n');
        Serial.print(frame);
        Serial.print('\n');
        xSemaphoreGive(_sim_serial_mtx);
    }
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

bool _sim_ready_sent = false;

void sim_ready() {
    if (_sim_ready_sent) return;
    _sim_ready_sent = true;
    _sim_send(">SIM:READY<");
    sim_log(SIM_SUCCESS, "Device ready");
}

#if SIM_HEARTBEAT_MS > 0
static void _simulatorHeartbeatTask(void*) {
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(SIM_HEARTBEAT_MS));
        if (_sim_ready_sent) _sim_send(">SIM:BEAT<");
    }
}
#endif

#ifdef TwoWire_h
extern volatile uint8_t  sim_wire_rx_buf[];
extern volatile uint8_t  sim_wire_rx_len;
extern volatile bool     sim_wire_rx_ready;
#endif

uint8_t           _sim_spi_rx_buf[SIM_SPI_RX_MAX];
volatile uint16_t _sim_spi_rx_head = 0;
volatile uint16_t _sim_spi_rx_tail = 0;

static void _simulatorUARTTask(void*) {
    String rxBuf;
    rxBuf.reserve(SIM_CMD_MAX_LEN + 4);
    for (;;) {
        if (_sim_serial_mtx && xSemaphoreTake(_sim_serial_mtx, pdMS_TO_TICKS(5)) == pdTRUE) {
            if (Serial) {
                while (Serial.available() > 0) {
                    const char c = static_cast<char>(Serial.read());
                    if (c == '\n') {
                        if (rxBuf.length() > 8 && rxBuf.charAt(0) == '<' && rxBuf.startsWith("<GPIO:")) {
                            const int c1 = rxBuf.indexOf(':');
                            const int c2 = rxBuf.indexOf(':', c1 + 1);
                            const int cl = rxBuf.indexOf('>', c2);
                            if (c1 > 0 && c2 > c1 && cl > c2) {
                                const int pin = rxBuf.substring(c1 + 1, c2).toInt();
                                const int val = rxBuf.substring(c2 + 1, cl).toInt();
                                if (pin >= 0 && pin < SIM_GPIO_COUNT) {
                                    sim_gpio_state[pin]        = val ? 1 : 0;
                                    sim_gpio_analog_value[pin] = static_cast<uint16_t>(val);
                                }
                            }
                        }
                        else if (rxBuf.length() > 8 && rxBuf.startsWith("<ADC:")) {
                            const int c1 = rxBuf.indexOf(':');
                            const int c2 = rxBuf.indexOf(':', c1 + 1);
                            const int cl = rxBuf.indexOf('>', c2);
                            if (c1 > 0 && c2 > c1 && cl > c2) {
                                const int pin = rxBuf.substring(c1 + 1, c2).toInt();
                                const int val = rxBuf.substring(c2 + 1, cl).toInt();
                                if (pin >= 0 && pin < SIM_GPIO_COUNT) {
                                    sim_gpio_analog_value[pin] = static_cast<uint16_t>(val & 0x0FFF);
                                }
                            }
                        }
                        else if (rxBuf.length() > 10 && rxBuf.startsWith("<I2C_RESP:")) {
#ifdef TwoWire_h
                            const int c1 = rxBuf.indexOf(':');
                            const int c2 = rxBuf.indexOf(':', c1 + 1);
                            const int cl = rxBuf.indexOf('>', c2);
                            if (c1 > 0 && c2 > c1 && cl > c2) {
                                const String hex = rxBuf.substring(c2 + 1, cl);
                                uint8_t n = 0;
                                const uint8_t maxn = 64; // SIM_WIRE_RX_SIZE
                                for (int i = 0; i + 1 < (int)hex.length() && n < maxn; i += 2) {
                                    char hb[3] = { hex.charAt(i), hex.charAt(i + 1), '\0' };
                                    sim_wire_rx_buf[n++] = (uint8_t)strtoul(hb, nullptr, 16);
                                }
                                sim_wire_rx_len   = n;
                                sim_wire_rx_ready = true;
                            }
#endif
                        }
                        else if (rxBuf.length() > 10 && rxBuf.startsWith("<SPI_RESP:")) {
                            const int c1 = rxBuf.indexOf(':');
                            const int cl = rxBuf.indexOf('>', c1 + 1);
                            if (c1 > 0 && cl > c1) {
                                const String hex = rxBuf.substring(c1 + 1, cl);
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
                        else if (rxBuf.length() > 8 && rxBuf.startsWith("<DHT:")) {
                            const int c1 = rxBuf.indexOf(':');
                            const int c2 = rxBuf.indexOf(':', c1 + 1);
                            const int c3 = rxBuf.indexOf(':', c2 + 1);
                            const int cl = rxBuf.indexOf('>', c3);
                            if (c1 > 0 && c2 > c1 && c3 > c2 && cl > c3) {
                                const int pin  = rxBuf.substring(c1 + 1, c2).toInt();
                                const int temp = rxBuf.substring(c2 + 1, c3).toInt();
                                const int hum  = rxBuf.substring(c3 + 1, cl).toInt();
                                if (pin >= 0 && pin < SIM_GPIO_COUNT) {
                                    sim_dht_enabled[pin] = true;
                                    sim_dht_temp[pin]    = static_cast<int16_t>(temp);
                                    sim_dht_hum[pin]     = static_cast<uint16_t>(hum);
                                }
                            }
                        }
                        rxBuf.clear();
                    } else if (c != '\r') {
                        if (rxBuf.length() < SIM_CMD_MAX_LEN) rxBuf += c;
                        else rxBuf.clear();
                    }
                }
            }
            xSemaphoreGive(_sim_serial_mtx);
        }
        vTaskDelay(pdMS_TO_TICKS(SIM_TASK_DELAY_MS));
    }
}

void sim_pinMode(uint8_t pin, uint8_t mode) {
    if (pin >= SIM_GPIO_COUNT) return;

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
        if (sim_gpio_mode[pin] == INPUT_PULLUP) return HIGH;
        return LOW;
    }
    return val;
}

void sim_digitalWrite(uint8_t pin, uint8_t value) {
    if (pin >= SIM_GPIO_COUNT) return;
    SPI.flush();
    
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
    char frame[24];
    snprintf(frame, sizeof(frame), ">GPIO:%d:%d<", pin, level);
    _sim_send(frame);
}

uint16_t sim_analogRead(uint8_t pin) {
    if (pin >= SIM_GPIO_COUNT) return 0;
    uint16_t val = sim_gpio_analog_value[pin];
    if (val == 0xFFFF) {
        uint8_t dig = sim_gpio_state[pin];
        if (dig == 0xFF) return 0;
        return dig ? 4095 : 0;
    }
    return val;
}

void sim_tone(uint8_t pin, unsigned int frequency, unsigned long duration) {
    char frame[48];
    snprintf(frame, sizeof(frame), ">TONE:%d:%u:%lu<", pin, frequency, duration);
    _sim_send(frame);
}

void sim_noTone(uint8_t pin) {
    char frame[48];
    snprintf(frame, sizeof(frame), ">TONE:%d:0:0<", pin);
    _sim_send(frame);
}

void _simBridgeInit_Early() {
    disableCore0WDT();
#ifndef CONFIG_FREERTOS_UNICORE
    disableCore1WDT();
#endif

    if (!_sim_serial_mtx) {
        _sim_serial_mtx = xSemaphoreCreateMutex();
    }

    esp_log_level_set("*", ESP_LOG_NONE);
    Serial.begin(SIM_UART_BAUD);
}

void _simBridgeInit_Late() {
    Serial.println();
    Serial.println(F(""));
    Serial.println(F("  ESP32 Simulator Started"));
    Serial.println(F("  Status        : READY"));
    Serial.println(F("  GPIO System   : OK"));
    Serial.println(F("  Runtime       : ACTIVE"));
    Serial.println(F(""));
    Serial.println();
    Serial.flush();

    xTaskCreatePinnedToCore(
        _simulatorUARTTask, "SimBridgeUART",
        SIM_TASK_STACK, nullptr, SIM_TASK_PRIO, nullptr, SIM_TASK_CORE
    );

#if SIM_HEARTBEAT_MS > 0
    xTaskCreatePinnedToCore(
        _simulatorHeartbeatTask, "SimHeartbeat",
        SIM_BEAT_STACK, nullptr, SIM_BEAT_PRIO, nullptr, SIM_TASK_CORE
    );
#endif
}
