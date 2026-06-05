#include "SimulatorBridge.h"
#include <Arduino.h>
#include "SPI.h"
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include "esp_log.h"
#include "soc/timer_group_struct.h"
#include "soc/timer_group_reg.h"

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
    
    static volatile bool _in_spi_flush = false;
    if (_sim_ready_sent && !_in_spi_flush) {
        _in_spi_flush = true;
        SPI.flush();
        _in_spi_flush = false;
    }
    
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

void sim_analogWrite(uint8_t pin, uint32_t value) {
    char frame[48];
    snprintf(frame, sizeof(frame), ">PWM:%d:%u<", pin, value);
    _sim_send(frame);
}

void sim_tone(uint8_t pin, unsigned int frequency, unsigned long duration) {
    // Emit as a SIM control frame — handled by _handleSimFrame TONE case in qemuRunner.js
    // This ensures TONE never leaks into the serial monitor as raw text
    char frame[64];
    snprintf(frame, sizeof(frame), ">SIM:TONE:%d:%u:%lu<", pin, frequency, duration);
    _sim_send(frame);
}

void sim_noTone(uint8_t pin) {
    // frequency=0, duration=0 signals stop
    char frame[48];
    snprintf(frame, sizeof(frame), ">SIM:TONE:%d:0:0<", pin);
    _sim_send(frame);
}

void sim_dacWrite(uint8_t pin, uint8_t value) {
    // DAC on ESP32: pins 25 and 26 only
    char frame[48];
    snprintf(frame, sizeof(frame), ">DAC:%d:%u<", pin, value);
    _sim_send(frame);
}

// ─────────────────────────────────────────────────────────────────────────────
//  LEDC (LED Controller PWM)
// ─────────────────────────────────────────────────────────────────────────────
static uint8_t  _ledc_channel_pin[16]  = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
                                           0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
static uint8_t  _ledc_resolution[16]   = {8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8};
static uint32_t _ledc_duty[16]         = {0};

void sim_ledcSetup(uint8_t channel, double freq, uint8_t resolution_bits) {
    if (channel >= 16) return;
    _ledc_resolution[channel] = resolution_bits;
    // freq is informational in simulation; we just record the resolution
}

void sim_ledcAttachPin(uint8_t pin, uint8_t channel) {
    if (channel >= 16) return;
    _ledc_channel_pin[channel] = pin;
    // Inform the frontend about the channel→pin mapping via SIM frame
    char frame[64];
    snprintf(frame, sizeof(frame), ">LEDC_ATTACH:%d:%d<", channel, pin);
    _sim_send(frame);
}

void sim_ledcWrite(uint8_t channel, uint32_t duty) {
    if (channel >= 16) return;
    _ledc_duty[channel] = duty;
    char frame[64];
    snprintf(frame, sizeof(frame), ">LEDC:%d:%u<", channel, duty);
    _sim_send(frame);
}

uint32_t sim_ledcRead(uint8_t channel) {
    if (channel >= 16) return 0;
    return _ledc_duty[channel];
}

void sim_ledcDetachPin(uint8_t pin) {
    for (int i = 0; i < 16; i++) {
        if (_ledc_channel_pin[i] == pin) {
            _ledc_channel_pin[i] = 0xFF;
            break;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PCNT (Pulse Counter)
// ─────────────────────────────────────────────────────────────────────────────
static uint8_t  _pcnt_unit_pin[8]   = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
static int16_t  _pcnt_counts[8]     = {0};

void sim_pcntInit(uint8_t unit, uint8_t pin) {
    if (unit >= 8) return;
    _pcnt_unit_pin[unit] = pin;
    char frame[48];
    snprintf(frame, sizeof(frame), ">PCNT_INIT:%d:%d<", unit, pin);
    _sim_send(frame);
}

int16_t sim_pcntGetCount(uint8_t unit) {
    if (unit >= 8) return 0;
    return _pcnt_counts[unit];
}

void sim_pcntClear(uint8_t unit) {
    if (unit >= 8) return;
    _pcnt_counts[unit] = 0;
    char frame[32];
    snprintf(frame, sizeof(frame), ">PCNT:%d:0<", unit);
    _sim_send(frame);
}

// ─────────────────────────────────────────────────────────────────────────────
//  TWAI / CAN Bus
// ─────────────────────────────────────────────────────────────────────────────
void sim_twaiTransmit(uint32_t id, uint8_t dlc, const uint8_t* data) {
    // >TWAI:<id_hex>:<dlc_hex>:<data_hex><
    char frame[128];
    char hexdata[17] = {0};
    for (int i = 0; i < dlc && i < 8; i++) {
        snprintf(hexdata + i * 2, 3, "%02x", data[i]);
    }
    snprintf(frame, sizeof(frame), ">TWAI:%08lx:%02x:%s<",
             (unsigned long)id, dlc, hexdata);
    _sim_send(frame);
}

// ─────────────────────────────────────────────────────────────────────────────
//  RMT (Remote Control Transceiver / IR)
// ─────────────────────────────────────────────────────────────────────────────
void sim_rmtTx(uint8_t channel, const uint32_t* items, uint16_t num_items) {
    // Encode RMT items as hex string: each uint32 = 2 pulse+level pairs
    // Max 64 items * 8 hex chars each = 512 chars; keep header small
    char frame[600];
    int pos = snprintf(frame, sizeof(frame), ">RMT:%d:", channel);
    for (int i = 0; i < num_items && pos + 8 < (int)sizeof(frame) - 2; i++) {
        pos += snprintf(frame + pos, sizeof(frame) - pos, "%08lx", (unsigned long)items[i]);
    }
    frame[pos++] = '<';
    frame[pos]   = '\0';
    _sim_send(frame);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Deep Sleep / Light Sleep
// ─────────────────────────────────────────────────────────────────────────────
void sim_deepSleep(uint64_t time_us) {
    char frame[64];
    snprintf(frame, sizeof(frame), ">SIM:SLEEP:%llu<", (unsigned long long)time_us);
    _sim_send(frame);
    // In simulation: block the task briefly then yield — QEMU/WASM will handle actual timing
    vTaskDelay(pdMS_TO_TICKS(10));
}

void sim_lightSleep(uint64_t time_us) {
    // Light sleep: same as deep sleep in simulation (no register state difference)
    sim_deepSleep(time_us);
}

// ─────────────────────────────────────────────────────────────────────────────
//  I2S Audio Output / Input
// ─────────────────────────────────────────────────────────────────────────────
// Base64 alphabet (standard)
static const char _b64tab[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Encode up to 256 bytes → ~344 chars.  Returns number of chars written (no NUL).
static int _b64encode(const uint8_t* src, size_t len, char* dst, size_t dst_max) {
    int out = 0;
    for (size_t i = 0; i < len && out + 5 < (int)dst_max; i += 3) {
        const uint32_t b0 = src[i];
        const uint32_t b1 = (i + 1 < len) ? src[i + 1] : 0;
        const uint32_t b2 = (i + 2 < len) ? src[i + 2] : 0;
        const uint32_t v  = (b0 << 16) | (b1 << 8) | b2;
        dst[out++] = _b64tab[(v >> 18) & 0x3F];
        dst[out++] = _b64tab[(v >> 12) & 0x3F];
        dst[out++] = (i + 1 < len) ? _b64tab[(v >>  6) & 0x3F] : '=';
        dst[out++] = (i + 2 < len) ? _b64tab[(v      ) & 0x3F] : '=';
    }
    dst[out] = '\0';
    return out;
}

// Maximum PCM bytes per SIM frame (keeps UART line < ~700 chars)
#define I2S_CHUNK_BYTES  192   // 192 raw bytes → 256 base64 chars

void sim_i2s_write(uint8_t port_num, const void* src, size_t size,
                   size_t* bytes_written, uint32_t /*ticks*/,
                   uint32_t sample_rate, uint8_t bits) {
    if (bytes_written) *bytes_written = size;
    if (!src || size == 0) return;

    const uint8_t* data = reinterpret_cast<const uint8_t*>(src);
    size_t offset = 0;

    // Send in chunks so a single UART line never becomes too long
    while (offset < size) {
        const size_t chunk = (size - offset > I2S_CHUNK_BYTES)
                            ? I2S_CHUNK_BYTES : (size - offset);

        // Header: >SIM:I2S:port:sampleRate:bits:<  then b64 payload then >
        // Max header length: ~30 chars, b64 payload: chunk*4/3 ≈ 260 chars
        char frame[350];
        int  hdr = snprintf(frame, sizeof(frame),
                            ">SIM:I2S:%d:%lu:%d:", (int)port_num,
                            (unsigned long)sample_rate, (int)bits);
        if (hdr < 0 || hdr >= (int)(sizeof(frame) - 10)) break;

        const int b64len = _b64encode(data + offset, chunk,
                                      frame + hdr, sizeof(frame) - hdr - 2);
        frame[hdr + b64len]     = '<';
        frame[hdr + b64len + 1] = '\0';
        _sim_send(frame);

        offset += chunk;
    }
}

void sim_i2s_read(uint8_t /*port_num*/, void* dest, size_t size,
                  size_t* bytes_read, uint32_t /*ticks*/) {
    // In simulation there is no real mic; return silence (zeros)
    if (dest && size > 0) memset(dest, 0, size);
    if (bytes_read) *bytes_read = size;
}


void _simBridgeInit_Early() {

    // 1. Disable software task watchdogs
    disableCore0WDT();
#ifndef CONFIG_FREERTOS_UNICORE
    disableCore1WDT();
#endif

    // 2. Disable hardware watchdog timers (TG0 and TG1) via direct register writes
    TIMERG0.wdtwprotect.val = TIMG_WDT_WKEY_V; // Unlock write-protection
    TIMERG0.wdtfeed.val     = 1;                // Reset the countdown
    TIMERG0.wdtconfig0.val  = 0;               // Disable WDT entirely
    TIMERG0.wdtwprotect.val = 0;               // Re-lock

    TIMERG1.wdtwprotect.val = TIMG_WDT_WKEY_V;
    TIMERG1.wdtfeed.val     = 1;
    TIMERG1.wdtconfig0.val  = 0;
    TIMERG1.wdtwprotect.val = 0;

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
