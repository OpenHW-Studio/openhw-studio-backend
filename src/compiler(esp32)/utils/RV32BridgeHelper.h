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
    printf("%s\n", frame);
    fflush(stdout);
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

// delay hook — no-op in emulator; vTaskDelay() would hang because FreeRTOS
// tick interrupts never fire under the WASM emulator.
static inline void _rv32_delay(unsigned long ms) {
    (void)ms;
}

// ─── Background UART RX Polling Task ─────────────────────────────────────────

#ifdef __cplusplus
extern "C" {
    int ble_hs_hci_rx_evt(uint8_t *hci_ev, void *arg);
    struct ble_hci_ev;
    int ble_hs_hci_evt_process(struct ble_hci_ev *ev);
    int ble_hs_hci_evt_acl_process(struct os_mbuf *om);
    void ble_hs_sched_start(void);
    void ble_gap_rx_le_scan_timeout(void);
    void ble_gap_master_reset_state(void);
#if __has_include(<openthread/platform/radio.h>) && __has_include(<openthread/error.h>)
    __attribute__((weak)) void otPlatRadioReceiveDone(otInstance *aInstance, otRadioFrame *aFrame, otError aError);
#endif
}
#endif

// Global counter for LE Advertising Reports seen (bypasses NimBLE host processing
// which hangs on LE Meta events in the WASM emulator)
int _rv32_disc_count = 0;

// Callback for direct advertising report delivery (bypasses NimBLE host)
// Parameters: mac[6] (LE byte order), rssi, addr_type
typedef void (*_rv32_adv_callback_t)(const uint8_t mac[6], int8_t rssi, uint8_t addr_type);
static _rv32_adv_callback_t _rv32_adv_cb = nullptr;
void _rv32_set_adv_callback(_rv32_adv_callback_t cb) { _rv32_adv_cb = cb; }

// BLE RX ring buffer — decouples UART task from NimBLE processing
#define BLE_RX_RING_SIZE 8
static volatile int _rv32_ble_rx_ring_r = 0, _rv32_ble_rx_ring_w = 0;
struct { uint8_t data[512]; int len; } _rv32_ble_rx_ring[BLE_RX_RING_SIZE];

static void _rv32_ble_rx_push(const uint8_t *data, int len) {
    int next = (_rv32_ble_rx_ring_w + 1) % BLE_RX_RING_SIZE;
    if (next != _rv32_ble_rx_ring_r) {
        int n = len < 512 ? len : 512;
        memcpy(_rv32_ble_rx_ring[_rv32_ble_rx_ring_w].data, data, n);
        _rv32_ble_rx_ring[_rv32_ble_rx_ring_w].len = n;
        _rv32_ble_rx_ring_w = next;
    }
}

static bool _rv32_ble_rx_pop(uint8_t *data, int *len) {
    if (_rv32_ble_rx_ring_r == _rv32_ble_rx_ring_w) return false;
    *len = _rv32_ble_rx_ring[_rv32_ble_rx_ring_r].len;
    memcpy(data, _rv32_ble_rx_ring[_rv32_ble_rx_ring_r].data, *len);
    _rv32_ble_rx_ring_r = (_rv32_ble_rx_ring_r + 1) % BLE_RX_RING_SIZE;
    return true;
}

#ifdef RV32_BRIDGE_IMPL

static void _rv32UARTTask(void*) {
    _RV32_EMIT("TEST:RV32_BRIDGE_INJECTED_SUCCESSFULLY");
    String rxBuf;
    rxBuf.reserve(1024);
    for (;;) {
        if (Serial0) {
            while (Serial0.available() > 0) {
                char c = static_cast<char>(Serial0.read());
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
                            { static int bcnt=0; if (++bcnt <= 2) _RV32_EMIT("TEST:BLE_RX_GOT_LINE len=%d", rxBuf.length()); }
                            int c1 = rxBuf.indexOf(':');
                            int c2 = rxBuf.indexOf(':', c1 + 1);
                            int cl = rxBuf.indexOf('>', c2);
                            if (c1 > 0 && c2 > c1 && cl > c2) {
                                String b64 = rxBuf.substring(c2 + 1, cl);
                                _RV32_EMIT("TEST:BLE_RX_DECODING b64_len=%d", b64.length());
                                uint8_t ble_rx_buf[512];
                                int len = _rv32_b64_decode(b64.c_str(), b64.length(), ble_rx_buf);
                                _RV32_EMIT("TEST:BLE_RX_DECODED len=%d", len);
                                if (len > 0) {
                                    _rv32_ble_rx_push(ble_rx_buf, len);
                                    _RV32_EMIT("TEST:BLE_RX_PUSHED len=%d w=%d", len, _rv32_ble_rx_ring_w);
                                }
                            } else {
                                _RV32_EMIT("TEST:BLE_RX_PARSE_FAIL c1=%d c2=%d cl=%d", c1, c2, cl);
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
        static int loop_cnt = 0;
        loop_cnt++;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void _rv32_bridge_init() {
    if (!_rv32_serial_mtx) {
        _rv32_serial_mtx = xSemaphoreCreateMutex();
    }
    // Initialize UART0 explicitly — on ESP32-C6, Serial may map to USB CDC,
    // but uart_input writes to UART0's RX FIFO. We use Serial0 for reading.
    Serial0.begin(115200, SERIAL_8N1, 17, 16);
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
#include <os/os_mbuf.h>

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
    // Skip real controller enable to prevent creation of high-priority BLE
    // controller tasks (prio 23) which consume all CPU and starve loopTask
    // (prio 1) and esp_timer (prio 22). HCI commands go to the gateway via
    // __wrap_ble_hs_hci_cmd_tx, so the real controller is not needed.
    //extern esp_err_t __real_esp_bt_controller_enable(int mode);
    //esp_err_t ret = __real_esp_bt_controller_enable(mode);
    //_RV32_EMIT("TEST:__real_esp_bt_controller_enable returned %d", (int)ret);
    _RV32_EMIT("TEST:__wrap_esp_bt_controller_enable - SKIPPED real call");
    return ESP_OK;
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

// Wrap ble_transport_free to safely handle heap-allocated HCI event buffers.
// Wrapper for ble_transport_free -- intercepts calls from NimBLE host
// to handle heap-allocated HCI event buffers (from WebSocket gateway)
// instead of passing them to the transport pool deallocator.
extern "C" void __wrap_ble_transport_free(void *buf) {
    // If this wrapper IS called (via --wrap), free the buffer directly.
    // Even if not called, transport.c's ble_transport_free now falls
    // through to free(buf) for non-pool memory.
    _RV32_EMIT("DBG:__wrap_ble_transport_free buf=%p", buf);
    if (buf) {
        _RV32_EMIT("DBG:__wrap_ble_transport_free calling free(%p)", buf);
        free(buf);
        _RV32_EMIT("DBG:__wrap_ble_transport_free free done");
    }
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
#include "freertos/semphr.h"

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



// Custom NPL function implementations. These replace broken library entries in the function table.
// We use malloc/free for event alloc (avoids depending on os_mempool.h which is not yet included)
// and cast void pointers from the opaque struct to FreeRTOS handles for mutex/sem calls.
static void _my_npl_event_init(struct ble_npl_event *ev, ble_npl_event_fn *fn,
                                void *arg) {
    ev->event = malloc(12);
    if (ev->event) {
        memset(ev->event, 0, 12);
        *(ble_npl_event_fn **)((char*)ev->event + 4) = fn;
        *(void **)((char*)ev->event + 8) = arg;
    }
}

static void _my_npl_event_deinit(struct ble_npl_event *ev) {
    if (ev->event) {
        free(ev->event);
        ev->event = NULL;
    }
}

static void _my_npl_event_run(struct ble_npl_event *ev) {
    if (!ev->event) return;
    ble_npl_event_fn *fn = *(ble_npl_event_fn **)((char*)ev->event + 4);
    if (fn) fn(ev);
}

static void *_my_npl_event_get_arg(struct ble_npl_event *ev) {
    return ev->event ? *(void **)((char*)ev->event + 8) : NULL;
}

static void _my_npl_event_set_arg(struct ble_npl_event *ev, void *arg) {
    if (ev->event) *(void **)((char*)ev->event + 8) = arg;
}

static void _my_npl_event_reset(struct ble_npl_event *ev) {
    if (ev->event) {
        free(ev->event);
        ev->event = NULL;
    }
}

static ble_npl_error_t _my_npl_mutex_init(struct ble_npl_mutex *mu) {
    // Simple non-blocking mutex for cooperative mode
    uint32_t *flag = (uint32_t *)malloc(sizeof(uint32_t));
    if (!flag) return BLE_NPL_ENOMEM;
    *flag = 0;
    mu->mutex = flag;
    return BLE_NPL_OK;
}

static ble_npl_error_t _my_npl_mutex_deinit(struct ble_npl_mutex *mu) {
    if (mu->mutex) {
        free(mu->mutex);
        mu->mutex = NULL;
    }
    return BLE_NPL_OK;
}

static ble_npl_error_t _my_npl_mutex_pend(struct ble_npl_mutex *mu,
                                           ble_npl_time_t timeout) {
    if (!mu->mutex) return BLE_NPL_ERROR;
    // Cooperative mode: always succeed
    return BLE_NPL_OK;
}

static ble_npl_error_t _my_npl_mutex_release(struct ble_npl_mutex *mu) {
    if (!mu->mutex) return BLE_NPL_ERROR;
    return BLE_NPL_OK;
}

static ble_npl_error_t _my_npl_sem_init(struct ble_npl_sem *sem, uint16_t tokens) {
    // Use a simple counter instead of FreeRTOS semaphore (cooperative mode)
    uint32_t *cnt = (uint32_t *)malloc(sizeof(uint32_t));
    if (!cnt) return BLE_NPL_ENOMEM;
    *cnt = tokens;
    sem->sem = cnt;
    return BLE_NPL_OK;
}

static ble_npl_error_t _my_npl_sem_deinit(struct ble_npl_sem *sem) {
    if (sem->sem) {
        free(sem->sem);
        sem->sem = NULL;
    }
    return BLE_NPL_OK;
}

// Forward declaration — defined later in SECTION 7
static void _rv32_process_ble_events(void);

static ble_npl_error_t _my_npl_sem_pend(struct ble_npl_sem *sem,
                                         ble_npl_time_t timeout) {
    if (!sem->sem) return BLE_NPL_ERROR;
    uint32_t *cnt = (uint32_t *)sem->sem;
    // Process BLE ring buffer events before checking semaphore count.
    // This ensures command complete / connection complete events that have
    // been injected into the ring buffer (by run.js) are delivered to the
    // NimBLE host even during blocking waits (e.g. ble_gap_connect).
    _rv32_process_ble_events();
    if (*cnt > 0) {
        (*cnt)--;
        return BLE_NPL_OK;
    }
    if (timeout == 0) {
        return BLE_NPL_TIMEOUT;
    }
    // For non-zero timeouts, spin-wait with iteration limit.
    // ble_hs_hci_cmd_tx is fully wrapped (returns 0 immediately), so
    // ble_hs_hci_wait_for_ack is never reached. This spin is a safety
    // net for any other NimBLE code path that calls ble_npl_sem_pend.
    for (int _sp = 0; _sp < 200; _sp++) {
        _rv32_process_ble_events();
        if (*cnt > 0) {
            (*cnt)--;
            return BLE_NPL_OK;
        }
    }
    return BLE_NPL_TIMEOUT;
}

static ble_npl_error_t _my_npl_sem_release(struct ble_npl_sem *sem) {
    if (!sem->sem) return BLE_NPL_ERROR;
    uint32_t *cnt = (uint32_t *)sem->sem;
    (*cnt)++;
    return BLE_NPL_OK;
}

// Minimal callout stubs to avoid calling broken library entries
static int _my_npl_callout_init(struct ble_npl_callout *co,
                                 struct ble_npl_eventq *evq,
                                 ble_npl_event_fn *ev_cb, void *ev_arg) {
    // Allocate a struct ble_npl_callout_freertos (TimerHandle_t + evq + ev)
    co->co = malloc(20);
    if (!co->co) return BLE_NPL_ENOMEM;
    memset(co->co, 0, 20);
    return BLE_NPL_OK;
}

static void _my_npl_callout_deinit(struct ble_npl_callout *co) {
    if (co->co) {
        free(co->co);
        co->co = NULL;
    }
}

static void _my_npl_callout_stop(struct ble_npl_callout *co) {}

static ble_npl_error_t _my_npl_callout_reset(struct ble_npl_callout *co,
                                              ble_npl_time_t ticks) {
    return BLE_NPL_OK;
}

static void _my_npl_callout_mem_reset(struct ble_npl_callout *co) {}

static bool _my_npl_callout_is_active(struct ble_npl_callout *co) {
    return false;
}

static ble_npl_time_t _my_npl_callout_get_ticks(struct ble_npl_callout *co) {
    return 0;
}

static uint32_t _my_npl_callout_remaining_ticks(struct ble_npl_callout *co,
                                                 ble_npl_time_t now) {
    return 0;
}

static void _my_npl_callout_set_arg(struct ble_npl_callout *co, void *arg) {}

// Custom event queue — bypasses FreeRTOS queues which don't work in WASM emulator
#define RV32_CUSTOM_EVQ_SIZE 128
static void *_rv32_evq_buf[RV32_CUSTOM_EVQ_SIZE];
static int _rv32_evq_head = 0, _rv32_evq_tail = 0;

static void _my_npl_eventq_init(struct ble_npl_eventq *evq) { evq->eventq = (void *)1; } // non-null marker
static void _my_npl_eventq_deinit(struct ble_npl_eventq *evq) {}
static struct ble_npl_event *_my_npl_eventq_get(struct ble_npl_eventq *evq,
                                                  ble_npl_time_t tmo) {
    (void)tmo;
    if (!evq || !evq->eventq) return NULL;
    if (_rv32_evq_head == _rv32_evq_tail) return NULL; // empty
    // xQueueReceive stores the item value (which is ev->event, i.e. void*)
    struct ble_npl_event *ev = (struct ble_npl_event *)malloc(sizeof(struct ble_npl_event));
    if (ev) {
        ev->event = _rv32_evq_buf[_rv32_evq_head];
        _rv32_evq_head = (_rv32_evq_head + 1) % RV32_CUSTOM_EVQ_SIZE;
    }
    return ev;
}
static void _my_npl_eventq_put(struct ble_npl_eventq *evq,
                                struct ble_npl_event *ev) {
    if (!evq || !evq->eventq || !ev) return;
    int next = (_rv32_evq_tail + 1) % RV32_CUSTOM_EVQ_SIZE;
    if (next != _rv32_evq_head) {
        _rv32_evq_buf[_rv32_evq_tail] = ev->event;
        _rv32_evq_tail = next;
    }
}
static void _my_npl_eventq_remove(struct ble_npl_eventq *evq,
                                   struct ble_npl_event *ev) {
    (void)evq; (void)ev;
}
static bool _my_npl_eventq_is_empty(struct ble_npl_eventq *evq) {
    (void)evq;
    return _rv32_evq_head == _rv32_evq_tail;
}
static bool _my_npl_event_is_queued(struct ble_npl_event *ev) { return false; }
static uint16_t _my_npl_sem_get_count(struct ble_npl_sem *sem) {
    if (!sem->sem) return 0;
    uint32_t *cnt = (uint32_t *)sem->sem;
    return (uint16_t)(*cnt);
}

static void _my_npl_hw_set_isr(int irqn, uint32_t addr) {}

static uint32_t _my_npl_time_get(void) {
    return xTaskGetTickCount();
}

static ble_npl_error_t _my_npl_time_ms_to_ticks(uint32_t ms, ble_npl_time_t *out_ticks) {
    *out_ticks = ms / portTICK_PERIOD_MS;
    return BLE_NPL_OK;
}

static ble_npl_error_t _my_npl_time_ticks_to_ms(ble_npl_time_t ticks, uint32_t *out_ms) {
    *out_ms = ticks * portTICK_PERIOD_MS;
    return BLE_NPL_OK;
}

static ble_npl_time_t _my_npl_time_ms_to_ticks32(uint32_t ms) {
    return ms / portTICK_PERIOD_MS;
}

static uint32_t _my_npl_time_ticks_to_ms32(ble_npl_time_t ticks) {
    return ticks * portTICK_PERIOD_MS;
}

static void _my_npl_time_delay(ble_npl_time_t ticks) {
    vTaskDelay(ticks);
}

static uint32_t _my_npl_get_time_forever(void) {
    return portMAX_DELAY;
}

static uint32_t _my_npl_hw_enter_critical(void) {
    vPortEnterCritical();
    return 0;
}

static void _my_npl_hw_exit_critical(uint32_t ctx) {
    vPortExitCritical();
}

static uint8_t _my_npl_hw_is_in_critical(void) {
    return 0;
}

static bool _my_npl_os_started(void) {
    return xTaskGetSchedulerState() != taskSCHEDULER_NOT_STARTED;
}

static void *_my_npl_get_current_task_id(void) {
    return xTaskGetCurrentTaskHandle();
}

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

    // Replace function table with our own; override broken entries with custom implementations
    if (npl_funcs) {
        struct npl_funcs_t *my_funcs = (struct npl_funcs_t *)malloc(sizeof(struct npl_funcs_t));
        if (my_funcs) {
            memcpy(my_funcs, npl_funcs, sizeof(struct npl_funcs_t));
            _RV32_EMIT("TEST:original p_ble_npl_event_init=%p p_ble_npl_mutex_init=%p p_ble_npl_sem_init=%p",
                (void*)my_funcs->p_ble_npl_event_init, (void*)my_funcs->p_ble_npl_mutex_init, (void*)my_funcs->p_ble_npl_sem_init);
            my_funcs->p_ble_npl_event_init = _my_npl_event_init;
            my_funcs->p_ble_npl_event_deinit = _my_npl_event_deinit;
            my_funcs->p_ble_npl_event_run = _my_npl_event_run;
            my_funcs->p_ble_npl_event_get_arg = _my_npl_event_get_arg;
            my_funcs->p_ble_npl_event_set_arg = _my_npl_event_set_arg;
            my_funcs->p_ble_npl_event_reset = _my_npl_event_reset;
            my_funcs->p_ble_npl_mutex_init = _my_npl_mutex_init;
            my_funcs->p_ble_npl_mutex_deinit = _my_npl_mutex_deinit;
            my_funcs->p_ble_npl_mutex_pend = _my_npl_mutex_pend;
            my_funcs->p_ble_npl_mutex_release = _my_npl_mutex_release;
            my_funcs->p_ble_npl_sem_init = _my_npl_sem_init;
            my_funcs->p_ble_npl_sem_deinit = _my_npl_sem_deinit;
            my_funcs->p_ble_npl_sem_pend = _my_npl_sem_pend;
            my_funcs->p_ble_npl_sem_release = _my_npl_sem_release;
            my_funcs->p_ble_npl_callout_init = _my_npl_callout_init;
            my_funcs->p_ble_npl_callout_deinit = _my_npl_callout_deinit;
            my_funcs->p_ble_npl_callout_reset = _my_npl_callout_reset;
            my_funcs->p_ble_npl_callout_stop = _my_npl_callout_stop;
            my_funcs->p_ble_npl_callout_mem_reset = _my_npl_callout_mem_reset;
            my_funcs->p_ble_npl_callout_is_active = _my_npl_callout_is_active;
            my_funcs->p_ble_npl_callout_get_ticks = _my_npl_callout_get_ticks;
            my_funcs->p_ble_npl_callout_remaining_ticks = _my_npl_callout_remaining_ticks;
            my_funcs->p_ble_npl_callout_set_arg = _my_npl_callout_set_arg;
            my_funcs->p_ble_npl_time_get = _my_npl_time_get;
            my_funcs->p_ble_npl_time_ms_to_ticks = _my_npl_time_ms_to_ticks;
            my_funcs->p_ble_npl_time_ticks_to_ms = _my_npl_time_ticks_to_ms;
            my_funcs->p_ble_npl_time_ms_to_ticks32 = _my_npl_time_ms_to_ticks32;
            my_funcs->p_ble_npl_time_ticks_to_ms32 = _my_npl_time_ticks_to_ms32;
            my_funcs->p_ble_npl_time_delay = _my_npl_time_delay;
            my_funcs->p_ble_npl_get_time_forever = _my_npl_get_time_forever;
            my_funcs->p_ble_npl_hw_enter_critical = _my_npl_hw_enter_critical;
            my_funcs->p_ble_npl_hw_exit_critical = _my_npl_hw_exit_critical;
            my_funcs->p_ble_npl_hw_is_in_critical = _my_npl_hw_is_in_critical;
            my_funcs->p_ble_npl_os_started = _my_npl_os_started;
            my_funcs->p_ble_npl_get_current_task_id = _my_npl_get_current_task_id;
            my_funcs->p_ble_npl_eventq_init = _my_npl_eventq_init;
            my_funcs->p_ble_npl_eventq_deinit = _my_npl_eventq_deinit;
            my_funcs->p_ble_npl_eventq_get = _my_npl_eventq_get;
            my_funcs->p_ble_npl_eventq_put = _my_npl_eventq_put;
            my_funcs->p_ble_npl_eventq_remove = _my_npl_eventq_remove;
            my_funcs->p_ble_npl_eventq_is_empty = _my_npl_eventq_is_empty;
            my_funcs->p_ble_npl_event_is_queued = _my_npl_event_is_queued;
            my_funcs->p_ble_npl_sem_get_count = _my_npl_sem_get_count;
            my_funcs->p_ble_npl_hw_set_isr = _my_npl_hw_set_isr;
            npl_funcs = my_funcs;
            _RV32_EMIT("TEST:custom p_ble_npl_event_init=%p p_ble_npl_mutex_init=%p p_ble_npl_sem_init=%p",
                (void*)my_funcs->p_ble_npl_event_init, (void*)my_funcs->p_ble_npl_mutex_init, (void*)my_funcs->p_ble_npl_sem_init);
        }
    }

    _RV32_EMIT("TEST:calling npl_freertos_mempool_init");
    int ret_mem = npl_freertos_mempool_init();
    _RV32_EMIT("TEST:npl_freertos_mempool_init returned %d", ret_mem);

    // On C6 the mbuf system is initialized by the controller path.
    // Explicitly call os_msys_init here would conflict — skip it.

    struct ble_npl_eventq *eq = nimble_port_get_dflt_eventq();
    _RV32_EMIT("TEST:eq=%p", eq);
    if (eq) {
        _RV32_EMIT("TEST:manually initializing event queue bypassing NPL");
        eq->eventq = xQueueCreate(32, sizeof(void *));
        _RV32_EMIT("TEST:created eventq=%p", eq->eventq);
    } else {
        _RV32_EMIT("TEST:eq is NULL, skipping eventq init");
    }
    _rv32_dbg_eq = (void *)eq;

    _RV32_EMIT("TEST:__wrap_ble_transport_ll_init finished successfully");
    _RV32_EMIT("TEST:free heap size=%d", (int)xPortGetFreeHeapSize());
}

extern "C" {
    int __wrap_os_mempool_init(void *mp, uint16_t blocks, uint32_t block_size, void *membuf, const char *name) {
        _RV32_EMIT("TEST:__wrap_os_mempool_init called for pool '%s' blocks=%u blk_sz=%u membuf=%p", name ? name : "unknown", blocks, block_size, membuf);
        extern int __real_os_mempool_init(void *mp, uint16_t blocks, uint32_t block_size, void *membuf, const char *name);
        int ret = __real_os_mempool_init(mp, blocks, block_size, membuf, name);
        _RV32_EMIT("TEST:__real_os_mempool_init returned %d", ret);
        return ret;
    }

    void __wrap_os_msys_init(void) {
        _RV32_EMIT("TEST:__wrap_os_msys_init called");
        extern void __real_os_msys_init(void);
        __real_os_msys_init();
        _RV32_EMIT("TEST:__real_os_msys_init returned");
    }
}

BaseType_t __wrap_xTaskCreatePinnedToCore(TaskFunction_t pvTaskCode, const char *const pcName, const uint32_t usStackDepth, void *const pvParameters, UBaseType_t uxPriority, TaskHandle_t *const pvCreatedTask, const BaseType_t xCoreID) {
    _RV32_EMIT("TEST:__wrap_xTaskCreatePinnedToCore called name='%s' stack=%u prio=%u core=%d", pcName ? pcName : "NULL", usStackDepth, uxPriority, (int)xCoreID);
    // For the nimble_host task, bypass the crashing real FreeRTOS implementation.
    // NimBLEDevice::init() waits for m_synced in a busy-loop; we can't run the
    // host task to set it, so just return (the bridge helper bypass handles sync).
    if (pcName && strcmp(pcName, "nimble_host") == 0) {
        _RV32_EMIT("TEST:bypassing real xTaskCreatePinnedToCore for nimble_host - faking success");
        if (pvCreatedTask) *pvCreatedTask = (TaskHandle_t)1;
        return pdPASS;
    }
    // esp_timer at prio 22 starves loopTask (prio 1) in the cooperative FreeRTOS
    // scheduler. Create a dummy handle and skip creation.
    if (pcName && strcmp(pcName, "esp_timer") == 0) {
        _RV32_EMIT("TEST:bypassing real xTaskCreatePinnedToCore for esp_timer - faking success");
        if (pvCreatedTask) *pvCreatedTask = (TaskHandle_t)1;
        return pdPASS;
    }
    extern BaseType_t __real_xTaskCreatePinnedToCore(TaskFunction_t, const char *, uint32_t, void *, UBaseType_t, TaskHandle_t *, BaseType_t);
    BaseType_t ret = __real_xTaskCreatePinnedToCore(pvTaskCode, pcName, usStackDepth, pvParameters, uxPriority, pvCreatedTask, xCoreID);
    _RV32_EMIT("TEST:__real_xTaskCreatePinnedToCore returned %d", (int)ret);
    return ret;
}


extern "C" {
void __wrap_na_npl_freertos_eventq_init(struct ble_npl_eventq *evq) {
    _RV32_EMIT("TEST:__wrap_na_npl_freertos_eventq_init called");
    extern void __real_na_npl_freertos_eventq_init(struct ble_npl_eventq *evq);
    __real_na_npl_freertos_eventq_init(evq);
    _RV32_EMIT("TEST:__wrap_na_npl_freertos_eventq_init finished successfully");
}
}

extern "C" int __wrap_nimble_port_init(void) {
    _RV32_EMIT("TEST:__wrap_nimble_port_init called");
    // esp_nimble_init() calls ble_npl_eventq_init(&g_eventq_dflt) BEFORE
    // ble_transport_ll_init, but npl_freertos_mempool_init() (which initializes
    // ble_freertos_evq_pool needed by the eventq init) is only called inside
    // our ble_transport_ll_init wrap — too late. Pre-init the pool here.
    _RV32_EMIT("TEST:calling npl_freertos_mempool_init early");
    int ret_mp = npl_freertos_mempool_init();
    _RV32_EMIT("TEST:npl_freertos_mempool_init early returned %d", ret_mp);

    extern int __real_nimble_port_init(void);
    int ret = __real_nimble_port_init();
    _RV32_EMIT("TEST:__real_nimble_port_init returned %d", ret);

    // Set a random address so active scan can work.
    // ble_gap_ext_disc() calls ble_hs_id_use_addr() which fails with
    // BLE_HS_ENOADDR unless an identity address (public or random) is set.
    // We use a static NRPA (non-resolvable private address).  The HCI command
    // (LE Set Random Address) emitted by ble_hs_id_set_rnd flows through
    // __wrap_ble_hs_hci_cmd_tx -> BLE:TX to the bridge and back as BLE:RX.
    // The wrapper returns 0 immediately, so this call does NOT wait for the
    // response — that arrives later asynchronously.
    {
        uint8_t nrpa[6];
        nrpa[0] = 0x12; nrpa[1] = 0x34; nrpa[2] = 0x56;
        nrpa[3] = 0x78; nrpa[4] = 0x9a; nrpa[5] = 0xbc;
        nrpa[5] &= 0x3f; // NRPA: top 2 bits of last byte must be 00
        extern int ble_hs_id_set_rnd(const uint8_t *rnd_addr);
        int addr_ret = ble_hs_id_set_rnd(nrpa);
        _RV32_EMIT("TEST:ble_hs_id_set_rnd returned %d", addr_ret);
    }

    // Drain the host event queue to process queued startup events
    // (ble_hs_ev_start_stage1, ble_hs_ev_start_stage2).  Stage2 calls
    // ble_hs_start() which properly sets enabled_state=ON and
    // sync_state=GOOD via the HCI startup sequence.
    {
        extern struct ble_npl_eventq *ble_hs_evq_get(void);
        struct ble_npl_eventq *hs_evq = ble_hs_evq_get();
        if (hs_evq) {
            struct ble_npl_event *ev;
            while ((ev = ble_npl_eventq_get(hs_evq, 0)) != NULL) {
                ble_npl_event_run(ev);
                ble_npl_event_deinit(ev);
                free(ev);
            }
        }
    }

    // Ensure the host state is set (safety net in case evq drain didn't do it).
    {
        extern uint8_t ble_hs_enabled_state;
        extern uint8_t ble_hs_sync_state;
        ble_hs_enabled_state = 2; // BLE_HS_ENABLED_STATE_ON
        ble_hs_sync_state    = 2; // BLE_HS_SYNC_STATE_GOOD
        _RV32_EMIT("TEST:ble_hs_enabled_state=ON sync_state=GOOD");
    }
    {
        extern void ble_hs_id_set_pub(const uint8_t *pub_addr);
        uint8_t mock_pub[6] = {0xfa, 0xce, 0xb0, 0x0c, 0x00, 0x01};
        ble_hs_id_set_pub(mock_pub);
        _RV32_EMIT("TEST:ble_hs_id_pub set to mock address");
    }

    return ret;
}

extern "C" void __wrap_ble_hs_init(void) {
    _RV32_EMIT("TEST:__wrap_ble_hs_init called");
    extern void __real_ble_hs_init(void);
    __real_ble_hs_init();
    _RV32_EMIT("TEST:__real_ble_hs_init returned");
}

int __wrap_r_os_mempool_init(void *mp, uint16_t blocks, uint32_t block_size, void *membuf, const char *name) {
    _RV32_EMIT("TEST:__wrap_r_os_mempool_init called pool='%s' blocks=%u blk_sz=%u membuf=%p", name ? name : "?", blocks, block_size, membuf);
    extern int __real_r_os_mempool_init(void *mp, uint16_t blocks, uint32_t block_size, void *membuf, const char *name);
    int ret = __real_r_os_mempool_init(mp, blocks, block_size, membuf, name);
    _RV32_EMIT("TEST:__real_r_os_mempool_init returned %d", ret);
    return ret;
}

void __wrap_ble_hs_hci_init(void) {
    _RV32_EMIT("TEST:__wrap_ble_hs_hci_init called - calling real");
    extern void __real_ble_hs_hci_init(void);
    __real_ble_hs_hci_init();
    _RV32_EMIT("TEST:__wrap_ble_hs_hci_init done");
}

// Bypass HCI command/response cycle: build the HCI packet, emit $BLE:TX:,
// then synthesize a Command Complete response so the NimBLE host updates
// its internal GAP state immediately (rather than waiting for the async
// response from the gateway which arrives via <BLE:RX:b64>).
int __wrap_ble_hs_hci_cmd_tx(uint16_t opcode, const void *cmd, uint8_t cmd_len,
                              void *rsp, uint8_t rsp_len) {
    _RV32_EMIT("TEST:__wrap_ble_hs_hci_cmd_tx opcode=0x%04x len=%d", opcode, cmd_len);
    // Build HCI packet: indicator(0x01) + opcode(2) + param_len(1) + params
    uint8_t total = 3 + cmd_len;
    uint8_t* pkt = (uint8_t*)alloca(1 + total);
    pkt[0] = 0x01;
    pkt[1] = opcode & 0xFF;
    pkt[2] = (opcode >> 8) & 0xFF;
    pkt[3] = cmd_len;
    if (cmd_len > 0) memcpy(pkt + 4, cmd, cmd_len);
    size_t b64_len = ((1 + total + 2) / 3) * 4 + 1;
    char* b64 = (char*)alloca(b64_len);
    _rv32_b64_encode(pkt, 1 + total, b64);
    _RV32_EMIT("BLE:TX:%s", b64);

    // Fill response buffer with success so the caller's state machine advances
    if (rsp && rsp_len > 0) {
        memset(rsp, 0, rsp_len);
    }

    return 0;
}

void __wrap_ble_transport_hs_init(void) {
    _RV32_EMIT("TEST:__wrap_ble_transport_hs_init called, calling ble_hs_init manually");
    extern void ble_hs_init(void);
    ble_hs_init();
    _RV32_EMIT("TEST:ble_hs_init returned");
}

extern "C" void __wrap_ble_npl_eventq_init(struct ble_npl_eventq *evq) {
    _RV32_EMIT("TEST:__wrap_ble_npl_eventq_init called evq=%p", evq);
    // On C6, this is an inline function in nimble_npl_os.h, so the wrap is
    // never reached. We define it here for completeness.
    extern void __real_ble_npl_eventq_init(struct ble_npl_eventq *evq);
    __real_ble_npl_eventq_init(evq);
    _RV32_EMIT("TEST:__real_ble_npl_eventq_init returned");
}

int __wrap_ble_phy_init(void) {
    _RV32_EMIT("TEST:__wrap_ble_phy_init called");
    return 0;
}

// Wrap scan timeout — the BLE gateway sends this event after the scan duration
// expires (wall clock). The NimBLE host state machine isn't fully initialized
// in the emulator (we bypass nimble_host task creation), so calling the real
// ble_gap_disc_complete() panics. Instead, just reset the GAP master state.
void __wrap_ble_gap_rx_le_scan_timeout(void) {
    _RV32_EMIT("TEST:__wrap_ble_gap_rx_le_scan_timeout - resetting GAP master state");
    ble_gap_master_reset_state();
    _RV32_EMIT("TEST:scan timeout handled safely");
}

#ifdef __cplusplus
}
#endif

// Cooperative NimBLE event processing — called from loop() in place of a
// real host task. Drains all pending events from the default event queue
// without blocking, then returns. Also drains pending <BLE:RX:> packets
// from Serial (the UART background task may not get CPU time in the
// cooperative FreeRTOS scheduler, so we handle BLE responses inline).
// Uses npl_funcs directly to avoid depending on NimBLE inline wrappers
// not yet declared.
#ifdef __cplusplus
extern "C"
#endif
// ── UART0 register definitions for direct FIFO poll ────────────
// ESP32-C6: UART0 base = 0x00A00000
// Use READ_PERI_REG / WRITE_PERI_REG macros (safe in emulator if address is valid)
#include "soc/uart_reg.h"
#include "soc/uart_struct.h"
#include "hal/uart_ll.h"

// Same inline reader as Serial0 but using uart_ll functions.
// This bypasses the interrupt-driven driver and reads the hardware FIFO directly.
static int _rv32_poll_uart0_hw(void) {
    static char _line[1024];
    static int _pos = 0;
    int pushed = 0;
    // uart_ll_get_rxfifo_len returns number of bytes available
    while (uart_ll_get_rxfifo_len(UART_LL_GET_HW(0)) > 0) {
        uint8_t raw;
        uart_ll_read_rxfifo(UART_LL_GET_HW(0), &raw, 1);
        char c = (char)raw;
        if (c == '\n') {
            _line[_pos] = '\0';
            if (_pos > 8 && strncmp(_line, "<BLE:RX:", 8) == 0) {
                int cl = _pos - 1;
                while (cl > 0 && _line[cl] != '>') cl--;
                if (cl > 8) {
                    const char* b64 = _line + 8;
                    int b64_len = cl - 8;
                    uint8_t ble_buf[512];
                    int len = _rv32_b64_decode(b64, b64_len, ble_buf);
                    if (len > 0) {
                        _rv32_ble_rx_push(ble_buf, len);
                        pushed++;
                        printf("DBG:UART_HW_POLL pushed len=%d\n", len);
                        fflush(stdout);
                    }
                }
            }
            _pos = 0;
        } else if (c != '\r') {
            if (_pos < (int)sizeof(_line) - 1) _line[_pos++] = c;
        }
    }
    return pushed;
}

void _rv32_process_ble_events(void) {
    // Reentrancy guard — prevents recursive calls via
    // _my_npl_sem_pend → _rv32_process_ble_events when a host evq
    // event handler pends on a semaphore. The static line buffers
    // below (and in _rv32_poll_uart0_hw) are not reentrant-safe.
    static int _rvg = 0;
    if (_rvg) return;
    _rvg = 1;

    // Try direct UART hardware poll first (works even if interrupt-driven
    // Serial0 misses data due to emulator UART interrupt timing issues).
    _rv32_poll_uart0_hw();

    // Then drain any BLE RX lines directly from Serial0 (backup path).
    // The background UART task sleeps 10ms between polls, but the emulator
    // only advances ~0.3ms per batch, so it never wakes up. We read inline.
    static char _rv32_ble_rx_line[1024];
    static int _rv32_ble_rx_pos = 0;
    int avail = (Serial0 ? Serial0.available() : -1);
    if (avail > 0) {
        printf("DBG:SERIAL0_AVAIL=%d\n", avail);
        fflush(stdout);
    }
    while (Serial0 && Serial0.available() > 0) {
        char c = (char)Serial0.read();
        if (c == '\n') {
            _rv32_ble_rx_line[_rv32_ble_rx_pos] = '\0';
            if (_rv32_ble_rx_pos > 8 && strncmp(_rv32_ble_rx_line, "<BLE:RX:", 8) == 0) {
                printf("DBG:BLE_RX_INLINE len=%d\n", _rv32_ble_rx_pos);
                fflush(stdout);
                int cl = _rv32_ble_rx_pos - 1;
                while (cl > 0 && _rv32_ble_rx_line[cl] != '>') cl--;
                if (cl > 8) {
                    const char* b64 = _rv32_ble_rx_line + 8;
                    int b64_len = cl - 8;
                    uint8_t ble_buf[512];
                    int len = _rv32_b64_decode(b64, b64_len, ble_buf);
                    printf("DBG:BLE_RX_INLINE_DECODED len=%d\n", len);
                    fflush(stdout);
                    if (len > 0) {
                        _rv32_ble_rx_push(ble_buf, len);
                        printf("DBG:BLE_RX_PUSHED len=%d\n", len);
                        fflush(stdout);
                    }
                }
            }
            _rv32_ble_rx_pos = 0;
        } else if (c != '\r') {
            if (_rv32_ble_rx_pos < (int)sizeof(_rv32_ble_rx_line) - 1) {
                _rv32_ble_rx_line[_rv32_ble_rx_pos++] = c;
            }
        }
    }

    // Then drain the ring buffer (may have events from UART task too)
    // NOTE: we used to bypass ALL ble_hs_hci_evt_process calls here because
    // NimBLE host event processing hung in the WASM emulator. Now we feed
    // events directly to ble_hs_hci_evt_process (bypassing the FreeRTOS event
    // queue that would deadlock), enabling the NimBLE GAP callback chain,
    // including NimBLEScanCallbacks::onResult.
    static uint8_t rx_buf[512];
    int rx_len;
    if (_rv32_ble_rx_ring_w != _rv32_ble_rx_ring_r) {
        Serial.printf("RB_STATE: w=%d r=%d diff=%d\n",
            _rv32_ble_rx_ring_w, _rv32_ble_rx_ring_r,
            (_rv32_ble_rx_ring_w - _rv32_ble_rx_ring_r + 8) % 8);
    }
    while (_rv32_ble_rx_pop(rx_buf, &rx_len)) {
        if (rx_len > 1 && rx_buf[0] == 0x04) {
            uint8_t evcode = rx_buf[1];
            int subevt = (evcode == 0x3e && rx_len >= 4) ? rx_buf[3] : -1;

            // Bypass callback for LE Advertising Reports.
            // When _rv32_adv_cb is set, we call it and skip the NimBLE host
            // event processing (ble_hs_hci_evt_process hangs for LE Advertising
            // Reports in the WASM emulator due to NimBLE internal processing).
            if (evcode == 0x3e && subevt == 0x02) {
                uint8_t addr0 = (rx_len >= 8) ? rx_buf[7] : 0;
                uint8_t addr5 = (rx_len >= 13) ? rx_buf[12] : 0;
                Serial.printf("ADV_DETECT rx_len=%d _rv32_adv_cb=%p addr=%02x...%02x\n",
                    rx_len, (void*)_rv32_adv_cb, addr0, addr5);
                _rv32_disc_count++;
                if (_rv32_adv_cb && rx_len >= 15) {
                    int data_len = rx_buf[13];
                    int rssi_off = 14 + data_len;
                    int8_t rssi = (rssi_off < rx_len) ? (int8_t)rx_buf[rssi_off] : -127;
                    uint8_t addr_type = rx_buf[6];
                    _rv32_adv_cb(rx_buf + 7, rssi, addr_type);
                } else {
                    // No bypass callback — feed to NimBLE host stack normally.
                    if (rx_len > 1) {
                        uint8_t *ev_copy = (uint8_t *)malloc(rx_len - 1);
                        if (ev_copy) {
                            memcpy(ev_copy, rx_buf + 1, rx_len - 1);
                            ble_hs_hci_evt_process((struct ble_hci_ev *)ev_copy);
                            Serial.printf("EVENT_DONE code=0x%02x\n", evcode);
                        }
                    }
                }
            } else {
                // Feed to NimBLE host stack for normal GAP event processing.
                // We allocate a copy (without the 0x04 HCI packet indicator byte)
                // so that struct ble_hci_ev starts at the malloc'd address.
                // ble_hs_hci_evt_process will eventually call ble_transport_free,
                // which our __wrap redirects to free(ev_copy).
                if (rx_len > 1) {
                    uint8_t *ev_copy = (uint8_t *)malloc(rx_len - 1);
                    if (ev_copy) {
                        Serial.printf("EVENT_BEFORE code=0x%02x\n", evcode);
                        memcpy(ev_copy, rx_buf + 1, rx_len - 1);
                        ble_hs_hci_evt_process((struct ble_hci_ev *)ev_copy);
                        Serial.printf("EVENT_DONE code=0x%02x\n", evcode);
                    }
                }
            }
        } else if (rx_len > 1 && rx_buf[0] == 0x02) {
            // ACL data packet from controller (e.g., GATT response from peer)
            // Strip the 0x02 HCI indicator, create an os_mbuf, and feed to
            // NimBLE's ACL processing path (which handles L2CAP/GATT).
            struct os_mbuf *om = os_msys_get_pkthdr(rx_len - 1, 0);
            if (om) {
                os_mbuf_append(om, rx_buf + 1, rx_len - 1);
                ble_hs_hci_evt_acl_process(om);
            }
        }
    }

    Serial.printf("START_DRAIN\n");
    // Drain the NimBLE host event queue (BLE_GAP_EVENT_CONNECT, etc.)
    // Safe now that AD reports are handled by the bypass callback — the
    // scan-result event handlers that previously blocked (by pending on
    // semaphores) are no longer invoked. Only connection and GATT events
    // remain, which complete synchronously in ble_npl_event_run.
    extern struct ble_npl_eventq *ble_hs_evq_get(void);
    struct ble_npl_eventq *hs_evq = ble_hs_evq_get();
    if (hs_evq) {
        struct ble_npl_event *ev;
        int drain_count = 0;
        while ((ev = ble_npl_eventq_get(hs_evq, 0)) != NULL) {
            drain_count++;
            Serial.printf("DRAIN_EV #%d\n", drain_count);
            ble_npl_event_run(ev);
            ble_npl_event_deinit(ev);
            free(ev);
        }
        Serial.printf("DRAIN_DONE count=%d\n", drain_count);
    }
    Serial.printf("END_PROCESS\n");

    _rvg = 0;
}

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
    if (!buf) return 0;
    uint8_t* pkt = (uint8_t*)buf;
    uint16_t opcode = (uint16_t)pkt[0] | ((uint16_t)pkt[1] << 8);
    uint8_t param_len = pkt[2];
    _RV32_EMIT("[BLE:TX] HCI CMD opcode=0x%04x params=%d bytes", opcode, param_len);
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
