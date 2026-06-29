/**
 * RV32BridgeHelper.h  —  OpenHW Studio RV32 WASM Bridge  (v1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Injected at compile time by compileController.js when targetEngine = 'rv32'.
 *
 * How it works:
 *   This header uses Arduino-layer macro redirection (same pattern as
 *   SimulatorBridge.h) to hook all major peripheral calls.  Instead of
 *   replacing the hardware implementation (which runs natively inside the
 *   esp_emu WASM engine), each hook performs the REAL call first, then emits
 *   a '$PROTO:DATA' line to UART0 so RV32Runner.ts can parse it and drive
 *   the component simulation layer.
 *
 *   For inputs (digitalRead, analogRead, DHT sensors), a background FreeRTOS
 *   task monitors UART RX for commands (e.g. <GPIO:pin:val>, <ADC:pin:val>) 
 *   sent by the JS runner, and caches them in a local array so reads return
 *   the correct simulated value instantly.
 *
 * Protocol — all lines start with '$' and end with '\n':
 *   $GPIO:<pin>:<0|1>                 — digital output changed
 *   $GPIOP:<pin>:<INPUT|OUTPUT|...>   — pinMode called
 *   $PWM:<pin>:<duty_0_255>           — analogWrite / LEDC PWM
 *   $I2C:<addr_hex>:<data_hex>        — I2C write transaction complete
 *   $I2CR:<addr_hex>:<n>              — I2C read request (n bytes)
 *   $SPI:<cs>:<tx_hex>                — SPI transaction (per endTransaction)
 *   $CAN:<id_hex>:<dlc>:<data_hex>    — TWAI/CAN transmit
 *   $I2S:<port>:<sr>:<bits>:<b64>     — I2S audio chunk (base64 PCM)
 *   $BLE:ADV:<b64_adv_data>           — BLE advertisement started
 *   $THREAD:TX:<ch>:<b64_frame>       — 802.15.4 frame transmitted (C6)
 *   $WIFI:IP:<ip>                     — WiFi/Ethernet got IP
 *   $SYS:RESTART                      — esp_restart() called
 *   $SYS:DELAY:<ms>                   — delay(ms) called (for time tracking)
 */

#ifndef RV32_BRIDGE_HELPER_H
#define RV32_BRIDGE_HELPER_H

#include <Arduino.h>
#include <stdint.h>
#include <stdarg.h>
#include <string.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

#define SIM_GPIO_COUNT      40
#define SIM_UART_BAUD       115200

// ─── Shared State Declarations ───────────────────────────────────────────────
#ifdef RV32_BRIDGE_IMPL
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

SemaphoreHandle_t _rv32_serial_mtx = nullptr;
bool _rv32_ready_sent = false;
void *_rv32_dbg_eq = nullptr;
#else
extern volatile uint8_t sim_gpio_state[SIM_GPIO_COUNT];
extern volatile uint8_t sim_gpio_mode[SIM_GPIO_COUNT];
extern volatile uint16_t sim_gpio_analog_value[SIM_GPIO_COUNT];
extern volatile bool sim_dht_enabled[SIM_GPIO_COUNT];
extern volatile int16_t sim_dht_temp[SIM_GPIO_COUNT];
extern volatile uint16_t sim_dht_hum[SIM_GPIO_COUNT];
extern volatile bool sim_dht_in_progress[SIM_GPIO_COUNT];
extern volatile unsigned long sim_dht_low_start_us[SIM_GPIO_COUNT];
extern volatile unsigned long sim_dht_trigger_us[SIM_GPIO_COUNT];
extern SemaphoreHandle_t _rv32_serial_mtx;
extern bool _rv32_ready_sent;
extern void *_rv32_dbg_eq;
#endif

// ─── Base-64 encoder ─────────────────────────────────────────────────────────
static const char _rv32_b64tab[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static inline void _rv32_b64_encode(const uint8_t* src, size_t len, char* out) {
    size_t i = 0, o = 0;
    while (i < len) {
        uint32_t b = ((uint32_t)src[i] << 16)
                   | (i + 1 < len ? (uint32_t)src[i+1] << 8 : 0)
                   | (i + 2 < len ? (uint32_t)src[i+2]      : 0);
        out[o++] = _rv32_b64tab[(b >> 18) & 0x3F];
        out[o++] = _rv32_b64tab[(b >> 12) & 0x3F];
        out[o++] = (i + 1 < len) ? _rv32_b64tab[(b >> 6) & 0x3F] : '=';
        out[o++] = (i + 2 < len) ? _rv32_b64tab[b & 0x3F]        : '=';
        i += 3;
    }
    out[o] = '\0';
}

static inline int _rv32_b64_decode(const char* src, size_t len, uint8_t* out);

#include "esp_bt.h"

#ifdef RV32_BRIDGE_IMPL
const esp_vhci_host_callback_t* _rv32_vhci_cb = nullptr;
void* _rv32_ot_instance = nullptr;
#else
extern const esp_vhci_host_callback_t* _rv32_vhci_cb;
extern void* _rv32_ot_instance;
#endif

#if __has_include(<openthread/platform/radio.h>) && __has_include(<openthread/error.h>)
#include <openthread/platform/radio.h>
#include <openthread/error.h>
#include <openthread/instance.h>
#endif


// Emit a $-protocol line to UART0 (thread-safe printf)
static inline void _rv32_send(const char* frame) {
    if (!_rv32_serial_mtx) return;
    if (xSemaphoreTake(_rv32_serial_mtx, pdMS_TO_TICKS(10)) == pdTRUE) {
        printf("%s\n", frame);
        xSemaphoreGive(_rv32_serial_mtx);
    }
}

#define _RV32_EMIT(fmt, ...) do { \
    char buf[256]; \
    snprintf(buf, sizeof(buf), "$" fmt, ##__VA_ARGS__); \
    _rv32_send(buf); \
} while(0)

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 1 — GPIO Overrides
// ─────────────────────────────────────────────────────────────────────────────

static inline void _rv32_pinMode(uint8_t pin, uint8_t mode) {
    if (pin >= SIM_GPIO_COUNT) return;
    ::pinMode(pin, mode);
    
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

    const char* mstr =
        (mode == INPUT)         ? "INPUT" :
        (mode == OUTPUT)        ? "OUTPUT" :
        (mode == INPUT_PULLUP)  ? "INPUT_PULLUP" :
        (mode == INPUT_PULLDOWN)? "INPUT_PULLDOWN" : "OTHER";
    _RV32_EMIT("GPIOP:%d:%s", (int)pin, mstr);
}

static inline void _rv32_digitalWrite(uint8_t pin, uint8_t value) {
    if (pin >= SIM_GPIO_COUNT) return;
    ::digitalWrite(pin, value);
    
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
    _RV32_EMIT("GPIO:%d:%d", (int)pin, (int)level);
}

static inline int _rv32_digitalRead(uint8_t pin) {
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

static inline int _rv32_analogRead(uint8_t pin) {
    if (pin >= SIM_GPIO_COUNT) return 0;
    uint16_t val = sim_gpio_analog_value[pin];
    if (val == 0xFFFF) {
        uint8_t dig = sim_gpio_state[pin];
        if (dig == 0xFF) return 0;
        return dig ? 4095 : 0;
    }
    return val;
}

static inline void _rv32_analogWrite(uint8_t pin, uint32_t value) {
    ::analogWrite(pin, value);
    _RV32_EMIT("PWM:%d:%u", (int)pin, (unsigned)value);
}

#if SOC_DAC_SUPPORTED || CONFIG_IDF_TARGET_ESP32 || CONFIG_IDF_TARGET_ESP32S2
static inline void _rv32_dacWrite(uint8_t pin, uint8_t value) {
    ::dacWrite(pin, value);
    _RV32_EMIT("DAC:%d:%u", (int)pin, (unsigned)value);
}
#endif

static inline void _rv32_tone(uint8_t pin, unsigned int freq, unsigned long dur = 0) {
    ::tone(pin, freq, dur);
    _RV32_EMIT("TONE:%d:%u:%lu", (int)pin, freq, dur);
}

static inline void _rv32_noTone(uint8_t pin) {
    ::noTone(pin);
    _RV32_EMIT("NOTONE:%d", (int)pin);
}

// delay hook
static inline void _rv32_delay(unsigned long ms) {
    _RV32_EMIT("SYS:DELAY:%lu", ms);
    ::delay(ms);
}

// ─── Background UART RX Polling Task ─────────────────────────────────────────

#ifdef __cplusplus
extern "C" {
    int ble_hs_hci_rx_evt(uint8_t *hci_ev, void *arg);
    void ble_hs_sched_start(void);
#if __has_include(<openthread/platform/radio.h>) && __has_include(<openthread/error.h>)
    __attribute__((weak)) void otPlatRadioReceiveDone(otInstance *aInstance, otRadioFrame *aFrame, otError aError);
#endif
}
#endif

#ifdef RV32_BRIDGE_IMPL
static void _rv32UARTTask(void*) {
    _RV32_EMIT("TEST:RV32_BRIDGE_INJECTED_SUCCESSFULLY");
    String rxBuf;
    rxBuf.reserve(1024);
    for (;;) {
        if (_rv32_serial_mtx && xSemaphoreTake(_rv32_serial_mtx, pdMS_TO_TICKS(5)) == pdTRUE) {
            if (Serial) {
                while (Serial.available() > 0) {
                    char c = static_cast<char>(Serial.read());
                    if (c == '\n') {
                        if (rxBuf.length() > 8 && rxBuf.charAt(0) == '<' && rxBuf.startsWith("<GPIO:")) {
                            int c1 = rxBuf.indexOf(':');
                            int c2 = rxBuf.indexOf(':', c1 + 1);
                            int cl = rxBuf.indexOf('>', c2);
                            if (c1 > 0 && c2 > c1 && cl > c2) {
                                int pin = rxBuf.substring(c1 + 1, c2).toInt();
                                int val = rxBuf.substring(c2 + 1, cl).toInt();
                                if (pin >= 0 && pin < SIM_GPIO_COUNT) {
                                    sim_gpio_state[pin] = val ? 1 : 0;
                                    sim_gpio_analog_value[pin] = static_cast<uint16_t>(val);
                                }
                            }
                        }
                        else if (rxBuf.length() > 8 && rxBuf.startsWith("<ADC:")) {
                            int c1 = rxBuf.indexOf(':');
                            int c2 = rxBuf.indexOf(':', c1 + 1);
                            int cl = rxBuf.indexOf('>', c2);
                            if (c1 > 0 && c2 > c1 && cl > c2) {
                                int pin = rxBuf.substring(c1 + 1, c2).toInt();
                                int val = rxBuf.substring(c2 + 1, cl).toInt();
                                if (pin >= 0 && pin < SIM_GPIO_COUNT) {
                                    sim_gpio_analog_value[pin] = static_cast<uint16_t>(val & 0x0FFF);
                                }
                            }
                        }
                        else if (rxBuf.length() > 8 && rxBuf.startsWith("<DHT:")) {
                            int c1 = rxBuf.indexOf(':');
                            int c2 = rxBuf.indexOf(':', c1 + 1);
                            int c3 = rxBuf.indexOf(':', c2 + 1);
                            int cl = rxBuf.indexOf('>', c3);
                            if (c1 > 0 && c2 > c1 && c3 > c2 && cl > c3) {
                                int pin = rxBuf.substring(c1 + 1, c2).toInt();
                                int temp = rxBuf.substring(c2 + 1, c3).toInt();
                                int hum = rxBuf.substring(c3 + 1, cl).toInt();
                                if (pin >= 0 && pin < SIM_GPIO_COUNT) {
                                    sim_dht_enabled[pin] = true;
                                    sim_dht_temp[pin] = static_cast<int16_t>(temp);
                                    sim_dht_hum[pin] = static_cast<uint16_t>(hum);
                                }
                            }
                        }
                        else if (rxBuf.length() > 8 && rxBuf.startsWith("<BLE:RX:")) {
                            int c1 = rxBuf.indexOf(':');
                            int c2 = rxBuf.indexOf(':', c1 + 1);
                            int cl = rxBuf.indexOf('>', c2);
                            if (c1 > 0 && c2 > c1 && cl > c2) {
                                String b64 = rxBuf.substring(c2 + 1, cl);
                                static uint8_t ble_rx_buf[512];
                                int len = _rv32_b64_decode(b64.c_str(), b64.length(), ble_rx_buf);
                                if (len > 0) {
                                    if (_rv32_vhci_cb && _rv32_vhci_cb->notify_host_recv) {
                                        // PATH A: Legacy VHCI (ESP32 classic)
                                        _rv32_vhci_cb->notify_host_recv(ble_rx_buf, len);
                                    } else {
                                        // PATH B: NimBLE native controller (C6/C3/S3)
                                        if (len > 0 && ble_rx_buf[0] == 0x04) {
                                            // Strip the HCI indicator byte before passing to NimBLE
                                            ble_hs_hci_rx_evt(ble_rx_buf + 1, NULL);
                                        }
                                    }
                                }
                            }
                        }

                        else if (rxBuf.length() > 8 && rxBuf.startsWith("<THREAD:RX:")) {
                            int c1 = rxBuf.indexOf(':');
                            int c2 = rxBuf.indexOf(':', c1 + 1);
                            int c3 = rxBuf.indexOf(':', c2 + 1);
                            int cl = rxBuf.indexOf('>', c3);
                            if (c1 > 0 && c2 > c1 && c3 > c2 && cl > c3) {
                                int channel = rxBuf.substring(c2 + 1, c3).toInt();
                                String b64 = rxBuf.substring(c3 + 1, cl);
                                static uint8_t thread_rx_buf[256];
                                int len = _rv32_b64_decode(b64.c_str(), b64.length(), thread_rx_buf);
                                if (len > 0 && _rv32_ot_instance) {
#if __has_include(<openthread/platform/radio.h>) && __has_include(<openthread/error.h>)
                                    if (otPlatRadioReceiveDone != nullptr) {
                                        static otRadioFrame rxFrame;
                                        rxFrame.mPsdu = thread_rx_buf;
                                        rxFrame.mLength = len;
                                        rxFrame.mChannel = channel;
                                        otPlatRadioReceiveDone((otInstance*)_rv32_ot_instance, &rxFrame, OT_ERROR_NONE);
                                    }
#endif
                                }
                            }
                        }
                        rxBuf.clear();
                    } else if (c != '\r') {
                        if (rxBuf.length() < 1024) rxBuf += c;
                        else rxBuf.clear();
                    }
                }
            }
            xSemaphoreGive(_rv32_serial_mtx);
        }
        static int loop_cnt = 0;
        loop_cnt++;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void _rv32_bridge_init() {
    if (!_rv32_serial_mtx) {
        _rv32_serial_mtx = xSemaphoreCreateMutex();
    }
    // Start background UART receiver task
    xTaskCreatePinnedToCore(
        _rv32UARTTask, "RV32BridgeUART",
        4096, nullptr, 1, nullptr, 0
    );
    _RV32_EMIT("TEST:RV32_BRIDGE_INJECTED_SUCCESSFULLY");
}
#endif

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 2 — LEDC (PWM)
// ─────────────────────────────────────────────────────────────────────────────

static inline void _rv32_ledcAttach(uint8_t pin, uint32_t freq, uint8_t res) {
    ::ledcAttach(pin, freq, res);
}

static inline void _rv32_ledcWrite(uint8_t pin, uint32_t duty) {
    ::ledcWrite(pin, duty);
    uint8_t duty8 = (uint8_t)((duty * 255UL) / 255UL);
    _RV32_EMIT("PWM:%d:%u", (int)pin, (unsigned)duty8);
}

static inline void _rv32_ledcDetach(uint8_t pin) {
    ::ledcDetach(pin);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 3 — I2C (Wire)
// ─────────────────────────────────────────────────────────────────────────────

#include <Wire.h>

class RV32TwoWire : public TwoWire {
public:
    explicit RV32TwoWire(uint8_t bus) : TwoWire(bus), _addr(0) {}

    void beginTransmission(uint8_t address) {
        _addr = address;
        TwoWire::beginTransmission(address);
    }
    void beginTransmission(int address) {
        beginTransmission((uint8_t)address);
    }

    uint8_t endTransmission(bool sendStop = true) {
        uint8_t result = TwoWire::endTransmission(sendStop);
        char hex[(_RV32_I2C_BUF_LEN * 2) + 1];
        hex[0] = '\0';
        for (int i = 0; i < _shadow_len; i++) {
            snprintf(hex + i*2, 3, "%02X", _shadow_buf[i]);
        }
        _RV32_EMIT("I2C:%02X:%s", (unsigned)_addr, hex);
        _shadow_len = 0;
        return result;
    }
    uint8_t endTransmission(uint8_t sendStop) {
        return endTransmission((bool)sendStop);
    }

    size_t write(uint8_t data) {
        if (_shadow_len < _RV32_I2C_BUF_LEN)
            _shadow_buf[_shadow_len++] = data;
        return TwoWire::write(data);
    }
    size_t write(const uint8_t* data, size_t len) {
        for (size_t i = 0; i < len && _shadow_len < _RV32_I2C_BUF_LEN; i++)
            _shadow_buf[_shadow_len++] = data[i];
        return TwoWire::write(data, len);
    }

    uint8_t requestFrom(uint8_t address, uint8_t size, bool sendStop = true) {
        _RV32_EMIT("I2CR:%02X:%d", (unsigned)address, (int)size);
        return TwoWire::requestFrom(address, size, sendStop);
    }
    uint8_t requestFrom(int address, int size, int sendStop) {
        return requestFrom((uint8_t)address, (uint8_t)size, (bool)sendStop);
    }
    uint8_t requestFrom(int address, int size) {
        return requestFrom((uint8_t)address, (uint8_t)size, true);
    }

private:
    static const int _RV32_I2C_BUF_LEN = 256;
    uint8_t _addr;
    uint8_t _shadow_buf[_RV32_I2C_BUF_LEN];
    int     _shadow_len = 0;
};

#undef Wire
#undef Wire1
extern RV32TwoWire _rv32Wire;
extern RV32TwoWire _rv32Wire1;
#define Wire  _rv32Wire
#define Wire1 _rv32Wire1

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 4 — SPI
// ─────────────────────────────────────────────────────────────────────────────

#include <SPI.h>

class RV32SPIClass : public SPIClass {
public:
    RV32SPIClass() : SPIClass(FSPI), _cs_pin(-1), _tx_len(0) {}

    void beginTransaction(SPISettings s) {
        _tx_len = 0;
        SPIClass::beginTransaction(s);
    }

    void endTransaction() {
        SPIClass::endTransaction();
        if (_tx_len > 0) {
            char hex[(_RV32_SPI_BUF * 2) + 1];
            for (int i = 0; i < _tx_len; i++)
                snprintf(hex + i*2, 3, "%02X", _tx_buf[i]);
            hex[_tx_len * 2] = '\0';
            _RV32_EMIT("SPI:%d:%s", (int)_cs_pin, hex);
            _tx_len = 0;
        }
    }

    uint8_t transfer(uint8_t data) {
        if (_tx_len < _RV32_SPI_BUF) _tx_buf[_tx_len++] = data;
        return SPIClass::transfer(data);
    }

    void transfer(void* buf, uint32_t size) {
        const uint8_t* src = (const uint8_t*)buf;
        for (uint32_t i = 0; i < size && _tx_len < _RV32_SPI_BUF; i++)
            _tx_buf[_tx_len++] = src[i];
        SPIClass::transfer(buf, size);
    }

    void writeBytes(const uint8_t* data, uint32_t size) {
        for (uint32_t i = 0; i < size && _tx_len < _RV32_SPI_BUF; i++)
            _tx_buf[_tx_len++] = data[i];
        SPIClass::writeBytes(data, size);
    }

    void setCSPin(int8_t pin) { _cs_pin = pin; }

private:
    static const int _RV32_SPI_BUF = 512;
    int8_t  _cs_pin;
    uint8_t _tx_buf[_RV32_SPI_BUF];
    int     _tx_len;
};

#undef SPI
extern RV32SPIClass _rv32SPI;
#define SPI _rv32SPI

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 5 — TWAI / CAN Bus
// ─────────────────────────────────────────────────────────────────────────────

#include <driver/twai.h>

static inline esp_err_t _rv32_twai_transmit(const twai_message_t* msg, TickType_t ticks) {
    esp_err_t r = twai_transmit(msg, ticks);
    if (r == ESP_OK) {
        char hex[msg->data_length_code * 2 + 1];
        for (int i = 0; i < msg->data_length_code; i++)
            snprintf(hex + i*2, 3, "%02X", msg->data[i]);
        hex[msg->data_length_code * 2] = '\0';
        _RV32_EMIT("CAN:%03X:%d:%s",
            (unsigned)msg->identifier,
            (int)msg->data_length_code,
            hex);
    }
    return r;
}

#define twai_transmit(msg, ticks)  _rv32_twai_transmit((msg), (ticks))

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 6 — I2S Audio
// ─────────────────────────────────────────────────────────────────────────────

#include <driver/i2s_std.h>

static inline esp_err_t _rv32_i2s_channel_write(
    i2s_chan_handle_t handle,
    const void* src, size_t size,
    size_t* bytes_written,
    uint32_t timeout_ms,
    uint32_t sample_rate = 44100,
    uint8_t  bits_per_sample = 16)
{
    esp_err_t r = i2s_channel_write(handle, src, size, bytes_written, timeout_ms);
    size_t emit_len = size < 512 ? size : 512;
    size_t b64_len  = ((emit_len + 2) / 3) * 4 + 1;
    char*  b64      = (char*)alloca(b64_len);
    _rv32_b64_encode((const uint8_t*)src, emit_len, b64);
    _RV32_EMIT("I2S:0:%u:%u:%s", sample_rate, (unsigned)bits_per_sample, b64);
    return r;
}

#define i2s_channel_write(h, src, sz, bw, tms) \
    _rv32_i2s_channel_write((h), (src), (sz), (bw), (tms))

// ─── Base-64 decoder ─────────────────────────────────────────────────────────
static const signed char _rv32_b64inv[] = {
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 62, -1, -1, -1, 63,
    52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1,
    -1,  0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14,
    15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, -1, -1, -1, -1, -1,
    -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
    41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, -1, -1, -1, -1, -1
};

static inline int _rv32_b64_decode(const char* src, size_t len, uint8_t* out) {
    size_t i = 0, o = 0;
    while (i < len) {
        if (src[i] == '\r' || src[i] == '\n' || src[i] == ' ') {
            i++;
            continue;
        }
        if (i + 3 >= len) break;
        char c1 = src[i];
        char c2 = src[i+1];
        char c3 = src[i+2];
        char c4 = src[i+3];
        
        int8_t v1 = _rv32_b64inv[(uint8_t)c1];
        int8_t v2 = _rv32_b64inv[(uint8_t)c2];
        int8_t v3 = (c3 == '=') ? 0 : _rv32_b64inv[(uint8_t)c3];
        int8_t v4 = (c4 == '=') ? 0 : _rv32_b64inv[(uint8_t)c4];
        
        if (v1 < 0 || v2 < 0 || v3 < 0 || v4 < 0) break;
        
        uint32_t b = ((uint32_t)v1 << 18) | ((uint32_t)v2 << 12) | ((uint32_t)v3 << 6) | (uint32_t)v4;
        out[o++] = (b >> 16) & 0xFF;
        if (c3 != '=') out[o++] = (b >> 8) & 0xFF;
        if (c4 != '=') out[o++] = b & 0xFF;
        i += 4;
    }
    return o;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 7 — BLE Bridge (firmware-side HCI intercept, dual-path)
//
//  WHY FIRMWARE-SIDE HOOKS ARE NEEDED:
//  The WASM JS API (esp_emu.js) exposes ONLY:
//    run_batch()     → returns UART output as string
//    wifi_tx_drain() → returns WiFi frames as Uint8Array
//    uart_input()    → injects bytes into UART RX
//  There is NO ble_tx_drain() / ble_rx_push().
//
//  Therefore the ONLY way BLE HCI packets can reach the JS WebSocket layer
//  is if the firmware itself prints "$BLE:TX:<base64>\n" on UART, which
//  run_batch() then returns as part of its UART string.  rv32-runner.ts
//  parses lines starting with '$BLE:TX:' and forwards them to the Bumble
//  BLE gateway WebSocket.
//
//  RX path: rv32-runner.ts receives binary from the BLE WebSocket, encodes
//  it as base64, and calls uart_input("<BLE:RX:b64>\n").  The background
//  _rv32UARTTask wakes up, decodes it, and calls:
//    _rv32_vhci_cb->notify_host_recv()   (legacy VHCI path, ESP32 classic)
//    ble_hs_hci_rx_evt()                  (NimBLE native path, C3/C6/S3)
//
//  TX PATH A — Legacy VHCI (ESP32 classic / CONFIG_BT_NIMBLE_LEGACY_VHCI_ENABLE):
//    NimBLE calls esp_vhci_host_send_packet() → we emit $BLE:TX:
//
//  TX PATH B — NimBLE native controller (ESP32-C3/C6/S3, SOC_ESP_NIMBLE_CONTROLLER=1):
//    NimBLE calls ble_hs_hci_cmd_tx() and ble_hs_hci_acl_tx_now() directly.
//    We provide __attribute__((weak)) overrides so our version wins at link
//    time over the NimBLE library .a version, and we emit $BLE:TX: from there.
// ─────────────────────────────────────────────────────────────────────────────

#include "esp_bt.h"

#ifdef __cplusplus
extern "C" {
#endif

// ── PATH A: Legacy VHCI / ESP-IDF Abstraction ────────────────────────────────

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t __wrap_esp_vhci_host_register_callback(const esp_vhci_host_callback_t *callback) {
    _RV32_EMIT("TEST:__wrap_esp_vhci_host_register_callback called");
    _rv32_vhci_cb = callback;
    return ESP_OK; // ESP_OK
}

esp_err_t __wrap_esp_vhci_host_send_packet(uint8_t *data, uint16_t len) {
    _RV32_EMIT("TEST:__wrap_esp_vhci_host_send_packet called, len=%d", (int)len);
    if (len > 0) {
        size_t b64_len = ((len + 2) / 3) * 4 + 1;
        char* b64 = (char*)alloca(b64_len);
        _rv32_b64_encode(data, len, b64);
        _RV32_EMIT("BLE:TX:%s", b64);
    }
    return ESP_OK; // ESP_OK
}

bool __wrap_esp_vhci_host_check_send_available(void) {
    _RV32_EMIT("TEST:__wrap_esp_vhci_host_check_send_available called");
    return true;
}

esp_err_t __wrap_esp_bt_controller_init(void *cfg) {
    _RV32_EMIT("TEST:__wrap_esp_bt_controller_init called");
    extern esp_err_t __real_esp_bt_controller_init(void *cfg);
    esp_err_t ret = __real_esp_bt_controller_init(cfg);
    _RV32_EMIT("TEST:__real_esp_bt_controller_init returned %d", (int)ret);
    return ret;
}

esp_err_t __wrap_esp_bt_controller_enable(int mode) {
    _RV32_EMIT("TEST:__wrap_esp_bt_controller_enable called, mode=%d", mode);
    extern esp_err_t __real_esp_bt_controller_enable(int mode);
    esp_err_t ret = __real_esp_bt_controller_enable(mode);
    _RV32_EMIT("TEST:__real_esp_bt_controller_enable returned %d", (int)ret);
    return ret;
}

esp_err_t __wrap_esp_bt_controller_disable(void) {
    _RV32_EMIT("TEST:__wrap_esp_bt_controller_disable called");
    return ESP_OK;
}

esp_err_t __wrap_esp_bt_controller_deinit(void) {
    _RV32_EMIT("TEST:__wrap_esp_bt_controller_deinit called");
    return ESP_OK;
}

int __wrap_esp_bt_controller_get_status(void) {
    _RV32_EMIT("TEST:__wrap_esp_bt_controller_get_status called");
    return 3; // ESP_BT_CONTROLLER_STATUS_ENABLED
}

esp_err_t __wrap_ble_buf_alloc(void) {
    _RV32_EMIT("TEST:__wrap_ble_buf_alloc called");
    return ESP_OK;
}

void __wrap_ble_buf_free(void) {
    _RV32_EMIT("TEST:__wrap_ble_buf_free called");
}

void __wrap_ble_vhci_disc_duplicate_mode_disable(uint32_t mode) {
    _RV32_EMIT("TEST:__wrap_ble_vhci_disc_duplicate_mode_disable called");
}

void __wrap_ble_vhci_disc_duplicate_mode_enable(uint32_t mode) {
    _RV32_EMIT("TEST:__wrap_ble_vhci_disc_duplicate_mode_enable called");
}

void __wrap_ble_vhci_disc_duplicate_set_max_cache_size(uint16_t size) {
    _RV32_EMIT("TEST:__wrap_ble_vhci_disc_duplicate_set_max_cache_size called");
}

void __wrap_ble_vhci_disc_duplicate_set_period_refresh_time(uint32_t period) {
    _RV32_EMIT("TEST:__wrap_ble_vhci_disc_duplicate_set_period_refresh_time called");
}

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

struct ble_npl_eventq;
struct npl_funcs_t;
#ifdef __cplusplus
extern "C" {
#endif
extern struct npl_funcs_t *npl_funcs;
void npl_freertos_funcs_init(void);
int npl_freertos_mempool_init(void);
int npl_freertos_set_controller_npl_info(ble_npl_count_info_t *ctrl_npl_info);
struct npl_funcs_t *npl_freertos_funcs_get(void);
struct ble_npl_eventq *nimble_port_get_dflt_eventq(void);
#ifdef __cplusplus
}
#endif



void __wrap_ble_transport_ll_init(void) {
    _RV32_EMIT("TEST:__wrap_ble_transport_ll_init called");
    
    // Call the real ROM function first to set up HCI shared memory
    extern void __real_ble_transport_ll_init(void);
    __real_ble_transport_ll_init();
    _RV32_EMIT("TEST:__real_ble_transport_ll_init returned");
    
    // Then do our NPL setup for the host side
    _RV32_EMIT("TEST:calling npl_freertos_funcs_init");
    npl_freertos_funcs_init();
    _RV32_EMIT("TEST:npl_funcs before=%p, npl_freertos_funcs_get=%p", npl_funcs, npl_freertos_funcs_get());
    npl_funcs = npl_freertos_funcs_get();
    _RV32_EMIT("TEST:npl_funcs after=%p", npl_funcs);
    
    _RV32_EMIT("TEST:setting controller NPL info");
    static ble_npl_count_info_t count_info = {64, 16, 64, 64, 64};
    int ret_info = npl_freertos_set_controller_npl_info(&count_info);
    _RV32_EMIT("TEST:npl_freertos_set_controller_npl_info returned %d", ret_info);

    _RV32_EMIT("TEST:calling npl_freertos_mempool_init");
    int ret_mem = npl_freertos_mempool_init();
    _RV32_EMIT("TEST:npl_freertos_mempool_init returned %d", ret_mem);

    _RV32_EMIT("TEST:bypassing os_mempool_module_init & os_msys_init manually");

    struct ble_npl_eventq *eq = nimble_port_get_dflt_eventq();
    _RV32_EMIT("TEST:eq=%p", eq);
    if (eq) {
        _RV32_EMIT("TEST:manually initializing event queue bypassing NPL");
#if CONFIG_BT_LE_CONTROLLER_NPL_OS_PORTING_SUPPORT
        eq->eventq = xQueueCreate(32, sizeof(void *));
        _RV32_EMIT("TEST:created eventq=%p", eq->eventq);
#else
        eq->q = xQueueCreate(32, sizeof(void *));
        _RV32_EMIT("TEST:created q=%p", eq->q);
#endif
    } else {
        _RV32_EMIT("TEST:eq is NULL, skipping eventq init");
    }
    _rv32_dbg_eq = (void *)eq;

    _RV32_EMIT("TEST:__wrap_ble_transport_ll_init finished successfully");
    _RV32_EMIT("TEST:free heap size=%d", (int)xPortGetFreeHeapSize());
}

extern "C" {
    int __wrap_os_mempool_init(void *mp, uint16_t blocks, uint32_t block_size, void *membuf, const char *name) {
        _RV32_EMIT("TEST:__wrap_os_mempool_init called for pool '%s' (bypassing NimBLE FreeRTOS memory pools)", name ? name : "unknown");
        return 0; // OS_OK
    }

    void __wrap_os_msys_init(void) {
        _RV32_EMIT("TEST:__wrap_os_msys_init called (bypassing NimBLE msys init)");
    }
}

extern "C" void __wrap_ble_hs_init(void) {
    _RV32_EMIT("TEST:__wrap_ble_hs_init called");
    extern void __real_ble_hs_init(void);
    __real_ble_hs_init();
    _RV32_EMIT("TEST:__real_ble_hs_init returned");
}

extern "C" int __wrap_nimble_port_init(void) {
    _RV32_EMIT("TEST:__wrap_nimble_port_init called");
    extern int __real_nimble_port_init(void);
    int ret = __real_nimble_port_init();
    _RV32_EMIT("TEST:__real_nimble_port_init returned %d", ret);
    return ret;
}

extern "C" void __wrap_ble_transport_init(void) {
    _RV32_EMIT("TEST:__wrap_ble_transport_init called");
    extern void __real_ble_transport_init(void);
    __real_ble_transport_init();
    _RV32_EMIT("TEST:__real_ble_transport_init returned");
}

extern "C" int __wrap_ble_store_init(void) {
    _RV32_EMIT("TEST:__wrap_ble_store_init called");
    extern int __real_ble_store_init(void);
    int ret = __real_ble_store_init();
    _RV32_EMIT("TEST:__real_ble_store_init returned %d", ret);
    return ret;
}

extern "C" int __wrap_ble_hs_start(void) {
    _RV32_EMIT("TEST:__wrap_ble_hs_start called");
    extern int __real_ble_hs_start(void);
    int ret = __real_ble_hs_start();
    _RV32_EMIT("TEST:__real_ble_hs_start returned %d", ret);
    return ret;
}

extern "C" void __wrap_ble_npl_eventq_init(struct ble_npl_eventq *evq) {
    _RV32_EMIT("TEST:__wrap_ble_npl_eventq_init called evq=%p", evq);
    extern void __real_ble_npl_eventq_init(struct ble_npl_eventq *evq);
    __real_ble_npl_eventq_init(evq);
    _RV32_EMIT("TEST:__real_ble_npl_eventq_init returned");
}

extern "C" void __wrap_ble_npl_sem_init(struct ble_npl_sem *sem, uint16_t tokens) {
    _RV32_EMIT("TEST:__wrap_ble_npl_sem_init called sem=%p tokens=%u", sem, tokens);
    extern void __real_ble_npl_sem_init(struct ble_npl_sem *sem, uint16_t tokens);
    __real_ble_npl_sem_init(sem, tokens);
    _RV32_EMIT("TEST:__real_ble_npl_sem_init returned");
}

extern "C" void __wrap_ble_npl_mutex_init(struct ble_npl_mutex *mu) {
    _RV32_EMIT("TEST:__wrap_ble_npl_mutex_init called mu=%p", mu);
    extern void __real_ble_npl_mutex_init(struct ble_npl_mutex *mu);
    __real_ble_npl_mutex_init(mu);
    _RV32_EMIT("TEST:__real_ble_npl_mutex_init returned");
}


extern "C" {
void __wrap_na_npl_freertos_eventq_init(struct ble_npl_eventq *evq) {
    _RV32_EMIT("TEST:__wrap_na_npl_freertos_eventq_init called");
    extern void __real_na_npl_freertos_eventq_init(struct ble_npl_eventq *evq);
    __real_na_npl_freertos_eventq_init(evq);
    _RV32_EMIT("TEST:__wrap_na_npl_freertos_eventq_init finished successfully");
}
}

int __wrap_ble_phy_init(void) {
    _RV32_EMIT("TEST:__wrap_ble_phy_init called");
    return 0;
}

#ifdef __cplusplus
}
#endif

// ── PATH B: NimBLE native HCI (ESP32-C6/C3/S3 — SOC_ESP_NIMBLE_CONTROLLER) ──
//
// On these chips NimBLE bypasses esp_vhci_host_* and calls these internal
// transport functions directly. We wrap the LL transport functions via GCC linker flags
// (-Wl,--wrap=ble_transport_to_ll_cmd_impl) so the linker redirects LL traffic to us!
//
// HCI packet format emitted to UART:
//   CMD: [0x01, opcode_lo, opcode_hi, param_len, params...]  base64-encoded
//   ACL: [0x02, handle_lo, handle_hi, total_len_lo, total_len_hi, payload...] base64-encoded

struct os_mbuf; // forward-decl — avoids pulling in all NimBLE headers
#ifdef __cplusplus
extern "C" {
#endif
extern void ble_transport_free(void *buf);
extern int r_os_mbuf_free_chain(struct os_mbuf *om);
#ifdef __cplusplus
}
#endif

// Drain a NimBLE os_mbuf chain into a flat buffer.
static inline int _rv32_drain_mbuf(struct os_mbuf* om, uint8_t* out, int max_len) {
    int total = 0;
    while (om && total < max_len) {
        uint16_t om_len  = *(const uint16_t*)((const uint8_t*)om + 12);
        uint8_t* om_data = *(uint8_t**)((uint8_t*)om + 16);
        int copy = (int)om_len;
        if (total + copy > max_len) copy = max_len - total;
        if (om_data && copy > 0) {
            memcpy(out + total, om_data, copy);
            total += copy;
        }
        om = *(struct os_mbuf**)((uint8_t*)om + 20);
    }
    return total;
}

// Override LL Command Transport. Emits "$BLE:TX:<b64>"
int __wrap_ble_transport_to_ll_cmd_impl(void *buf) {
    _RV32_EMIT("TEST:__wrap_ble_transport_to_ll_cmd_impl called");
    if (!buf) return 0;
    uint8_t* pkt = (uint8_t*)buf;
    uint8_t param_len = pkt[2];
    int total = 3 + param_len;
    
    uint8_t* full_pkt = (uint8_t*)alloca(total + 1);
    full_pkt[0] = 0x01; // HCI indicator: CMD
    memcpy(full_pkt + 1, pkt, total);
    
    size_t b64_len = ((total + 1 + 2) / 3) * 4 + 1;
    char* b64 = (char*)alloca(b64_len);
    _rv32_b64_encode(full_pkt, total + 1, b64);
    _RV32_EMIT("BLE:TX:%s", b64);
    
    ble_transport_free(buf);
    return 0; // BLE_ERR_SUCCESS
}

// Override LL ACL Transport. Emits "$BLE:TX:<b64>"
int __wrap_ble_transport_to_ll_acl_impl(struct os_mbuf *om) {
    if (!om) return 0;
    uint8_t buf[1024];
    buf[0] = 0x02; // HCI indicator: ACL
    int body = _rv32_drain_mbuf(om, buf + 1, (int)sizeof(buf) - 1);
    int total = body + 1;
    if (total > 1) {
        size_t b64_len = ((total + 2) / 3) * 4 + 1;
        char* b64 = (char*)alloca(b64_len);
        _rv32_b64_encode(buf, total, b64);
        _RV32_EMIT("BLE:TX:%s", b64);
    }
    r_os_mbuf_free_chain(om);
    return 0;
}

#ifdef __cplusplus
}
#endif



// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 8 — Thread / 802.15.4 (OpenThread Radio Driver Intercept)
// ─────────────────────────────────────────────────────────────────────────────

#if defined(CONFIG_OPENTHREAD_ENABLED)

#include "openthread/platform/radio.h"

#ifdef __cplusplus
extern "C" {
#endif


static inline otError _rv32_otPlatRadioEnable(otInstance* aInstance) {
    _rv32_ot_instance = aInstance;
    return otPlatRadioEnable(aInstance);
}

static inline otError _rv32_otPlatRadioTransmit(otInstance* aInstance, otRadioFrame* aFrame) {
    if (aFrame && aFrame->mLength > 0) {
        size_t b64_len = ((aFrame->mLength + 2) / 3) * 4 + 1;
        char*  b64     = (char*)alloca(b64_len);
        _rv32_b64_encode(aFrame->mPsdu, aFrame->mLength, b64);
        _RV32_EMIT("THREAD:TX:%d:%s", (int)aFrame->mChannel, b64);
    }
    return OT_ERROR_NONE;
}

#define otPlatRadioEnable(a)      _rv32_otPlatRadioEnable((a))
#define otPlatRadioTransmit(a, f) _rv32_otPlatRadioTransmit((a), (f))

#ifdef __cplusplus
}
#endif

#endif

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 9 — WiFi
// ─────────────────────────────────────────────────────────────────────────────

#include <WiFi.h>

class RV32WiFiClass : public WiFiClass {
public:
    wl_status_t begin(const char* ssid, const char* passphrase = NULL,
                      int32_t channel = 0, const uint8_t* bssid = NULL,
                      bool connect = true)
    {
        wl_status_t s = WiFiClass::begin(ssid, passphrase, channel, bssid, connect);
        _RV32_EMIT("WIFI:BEGIN:%s", ssid ? ssid : "");
        return s;
    }

    IPAddress localIP() {
        IPAddress ip = WiFiClass::localIP();
        if ((uint32_t)ip != 0) {
            _RV32_EMIT("WIFI:IP:%d.%d.%d.%d", ip[0], ip[1], ip[2], ip[3]);
        }
        return ip;
    }
};

#undef WiFi
extern RV32WiFiClass _rv32WiFi;
#define WiFi _rv32WiFi

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 10 — System
// ─────────────────────────────────────────────────────────────────────────────

static inline void _rv32_esp_restart() {
    _RV32_EMIT("SYS:RESTART");
    ::esp_restart();
}
#define esp_restart()  _rv32_esp_restart()

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 11 — Macro redirects
// ─────────────────────────────────────────────────────────────────────────────

#undef  pinMode
#undef  digitalWrite
#undef  digitalRead
#undef  analogRead
#undef  analogWrite
#if SOC_DAC_SUPPORTED || CONFIG_IDF_TARGET_ESP32 || CONFIG_IDF_TARGET_ESP32S2
#undef  dacWrite
#endif
#undef  tone
#undef  noTone
#undef  delay
#undef  ledcAttach
#undef  ledcWrite
#undef  ledcDetach

#define pinMode(pin, mode)           _rv32_pinMode((pin), (mode))
#define digitalWrite(pin, val)       _rv32_digitalWrite((pin), (val))
#define digitalRead(pin)             _rv32_digitalRead((pin))
#define analogRead(pin)              _rv32_analogRead((pin))
#define analogWrite(pin, val)        _rv32_analogWrite((pin), (val))
#if SOC_DAC_SUPPORTED || CONFIG_IDF_TARGET_ESP32 || CONFIG_IDF_TARGET_ESP32S2
#define dacWrite(pin, val)           _rv32_dacWrite((pin), (val))
#endif
#define tone(pin, freq, ...)         _rv32_tone((pin), (freq), ##__VA_ARGS__)
#define noTone(pin)                  _rv32_noTone((pin))
#define delay(ms)                    _rv32_delay((ms))
#define ledcAttach(pin, freq, res)   _rv32_ledcAttach((pin), (freq), (res))
#define ledcWrite(pin, duty)         _rv32_ledcWrite((pin), (duty))
#define ledcDetach(pin)              _rv32_ledcDetach((pin))

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 12 — Global objects
// ─────────────────────────────────────────────────────────────────────────────

#ifdef RV32_BRIDGE_IMPL
RV32TwoWire  _rv32Wire(0);
RV32TwoWire  _rv32Wire1(1);
RV32SPIClass _rv32SPI;
RV32WiFiClass _rv32WiFi;
#else
extern RV32TwoWire  _rv32Wire;
extern RV32TwoWire  _rv32Wire1;
extern RV32SPIClass _rv32SPI;
extern RV32WiFiClass _rv32WiFi;
#endif

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 13 — Stubs
// ─────────────────────────────────────────────────────────────────────────────

#ifndef ps_malloc
#  define ps_malloc(size)           malloc(size)
#  define ps_calloc(n, s)           calloc(n, s)
#  define ps_realloc(p, s)          realloc(p, s)
#  define ps_free(p)                free(p)
#  define heap_caps_malloc(sz, c)   malloc(sz)
#  define heap_caps_calloc(n, s, c) calloc(n, s)
#  define heap_caps_realloc(p, s, c)realloc(p, s)
#  define heap_caps_free(p)         free(p)
#endif

#define esp_task_wdt_init(t, p)    ((void)0)
#define esp_task_wdt_deinit()      ((void)0)
#define esp_task_wdt_add(t)        ((void)0)
#define esp_task_wdt_delete(t)     ((void)0)
#define esp_task_wdt_reset()       ((void)0)

#ifndef RTC_DATA_ATTR
#  define RTC_DATA_ATTR    static
#  define RTC_RODATA_ATTR  static const
#  define RTC_FAST_ATTR    static
#  define RTC_SLOW_ATTR    static
#endif

#ifndef CAMERA_SHIM_DEFINED
#  define CAMERA_SHIM_DEFINED
struct camera_fb_t { uint8_t* buf; size_t len; size_t width; size_t height; uint32_t format; };
#  define esp_camera_fb_get()        ((camera_fb_t*)nullptr)
#  define esp_camera_fb_return(fb)   ((void)(fb))
#  define esp_camera_init(cfg)       (ESP_OK)
#  define esp_camera_deinit()        (ESP_OK)
#endif

#ifndef esp_random
#  define esp_random()              ((uint32_t)rand())
#  define esp_fill_random(buf, n)   do { for(int _i=0;_i<(int)(n);_i++) ((uint8_t*)(buf))[_i]=(uint8_t)rand(); } while(0)
#endif

#endif // RV32_BRIDGE_HELPER_H
