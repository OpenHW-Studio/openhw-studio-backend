/**
 * SimulatorBridge.h    ESP32 QEMU GPIO + Serial Shim  (v3.0  stable)
 * 
 * Injected at compile time by compileController.js.
 * The bridge entry-point is _simBridgeInit(), which is called from the
 * compiler-injected setup() wrapper  AFTER the Arduino core has fully
 * initialized hardware, FreeRTOS, and the flash cache.
 *
 *  WHY NOT __attribute__((constructor)) 
 *   C++ constructors run during static-init, before app_main() and before
 *   the IDF initialises the flash cache.  Calling Serial.begin(),
 *   xTaskCreatePinnedToCore(), or ANY FreeRTOS primitive at that stage
 *   causes:
 *       Guru Meditation Error: Core panic'ed (Cache error)
 *       Cache disabled but cached memory region accessed
 *   The fix is to perform all bridge init inside _simBridgeInit(), which is
 *   called by the injected setup() wrapper after Arduino hardware is ready.
 *
 *  Boot lifecycle 
 *   ROM  IDF  app_main()  Arduino hardware init  injected setup() {
 *       _simBridgeInit()    mutex + Serial + tasks spawned HERE (safe)
 *       _sim_user_setup()   user's original setup() body
 *       sim_ready()         sends >SIM:READY< (auto-called if user forgot)
 *   }  injected loop() { _sim_user_loop() }  repeat
 *
 *  Protocol (firmware  Node.js over uart.out) 
 *   >GPIO:<pin>:<val><         digitalWrite event
 *   >SIM:READY<                device fully initialised
 *   >SIM:BEAT<                 heartbeat (every SIM_HEARTBEAT_MS)
 *   >SIM:LOG:<level>:<msg><    structured log
 *
 *  Protocol (Node.js  firmware over uart.in) 
 *   <GPIO:<pin>:<val>>\n       virtual pin injection
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

// Set all pins initially to 0xFF (floating/un-driven state)
volatile uint8_t sim_gpio_state[SIM_GPIO_COUNT] = {
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF
};
volatile uint8_t sim_gpio_mode[SIM_GPIO_COUNT]  = {0};

// --- Analog State ---
volatile uint16_t sim_gpio_analog_value[SIM_GPIO_COUNT] = {
    0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF,
    0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF,
    0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF,
    0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF
};

// --- DHT State ---
volatile bool sim_dht_enabled[SIM_GPIO_COUNT] = {false};
volatile int16_t sim_dht_temp[SIM_GPIO_COUNT] = {240}; // 24.0 C
volatile uint16_t sim_dht_hum[SIM_GPIO_COUNT] = {500}; // 50.0 %
volatile bool sim_dht_in_progress[SIM_GPIO_COUNT] = {false};
volatile unsigned long sim_dht_low_start_us[SIM_GPIO_COUNT] = {0};
volatile unsigned long sim_dht_trigger_us[SIM_GPIO_COUNT] = {0};

//  Serial TX mutex 
// Declared non-static so the injected setup() wrapper can test it.
// NULL until _simBridgeInit() is called.

SemaphoreHandle_t _sim_serial_mtx = nullptr;

//  Low-level frame sender 

static void _sim_send(const char* frame) {
    if (!_sim_serial_mtx) return;
    if (!Serial) return; // Deduplicate and prevent crash if UART is not active
    if (xSemaphoreTake(_sim_serial_mtx, pdMS_TO_TICKS(10)) == pdTRUE) {
        Serial.print('\n');
        Serial.print(frame);
        Serial.print('\n');
        xSemaphoreGive(_sim_serial_mtx);
    }
}

// Public non-static wrapper called by Wire.cpp and future SPI shim.
// `frame` MUST be in SRAM (stack / heap)  never pass a flash string literal.
// Using _sim_send guarantees the serial mutex is held during the write,
// preventing concurrent access between Core 0 (UART RX task) and Core 1 (user).
void sim_wire_emit(const char* frame) {
    _sim_send(frame);
}

//  Public: structured logging 

void sim_log(const char* level, const char* msg) {
    char frame[256];
    snprintf(frame, sizeof(frame), ">SIM:LOG:%s:%s<", level, msg);
    _sim_send(frame);
}
void sim_log(const char* level, const String& msg) { sim_log(level, msg.c_str()); }

//  Public: ready handshake 

// Non-static  the injected setup() wrapper checks this to auto-call sim_ready().
bool _sim_ready_sent = false;

void sim_ready() {
    if (_sim_ready_sent) return;
    _sim_ready_sent = true;
    _sim_send(">SIM:READY<");
    sim_log(SIM_SUCCESS, "Device ready");
}

//  Heartbeat task 

#if SIM_HEARTBEAT_MS > 0
static void _simulatorHeartbeatTask(void*) {
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(SIM_HEARTBEAT_MS));
        if (_sim_ready_sent) _sim_send(">SIM:BEAT<");
    }
}
#endif

//  Wire.cpp shared RX buffer (extern  defined in Wire.cpp) 
// The UART task below writes here when it receives <I2C_RESP:addr:hex>.
// Wire.cpp's requestFrom() reads from it via spin-wait.
// Only available when Wire.h (our simulator shim) was included.

#ifdef TwoWire_h
extern volatile uint8_t  sim_wire_rx_buf[];
extern volatile uint8_t  sim_wire_rx_len;
extern volatile bool     sim_wire_rx_ready;
#endif

// SPI RX ring buffer (used by future SimSPI)
#define SIM_SPI_RX_MAX 256
static uint8_t           _sim_spi_rx_buf[SIM_SPI_RX_MAX];
static volatile uint16_t _sim_spi_rx_head = 0;
static volatile uint16_t _sim_spi_rx_tail = 0;

//  UART RX task 

static void _simulatorUARTTask(void*) {
    String rxBuf;
    rxBuf.reserve(SIM_CMD_MAX_LEN + 4);
    for (;;) {
        if (_sim_serial_mtx && xSemaphoreTake(_sim_serial_mtx, pdMS_TO_TICKS(5)) == pdTRUE) {
            if (Serial) {
                while (Serial.available() > 0) {
                    const char c = static_cast<char>(Serial.read());
                    if (c == '\n') {
                        //  <GPIO:pin:value> 
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
                        //  <ADC:pin:val_12bit> 
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
                        //  <I2C_RESP:addr_hex:hexdata> 
                        // Written into Wire.cpp's sim_wire_rx_buf so requestFrom()
                        // can serve the bytes back to the calling sketch.
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
                        //  <SPI_RESP:hexdata> 
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
                        //  <DHT:pin:temp:humidity> 
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



//  GPIO shims 

void sim_pinMode(uint8_t pin, uint8_t mode) {
    if (pin >= SIM_GPIO_COUNT) return;

    if (sim_dht_enabled[pin]) {
        if (mode == INPUT || mode == INPUT_PULLUP) {
            // transition from OUTPUT to INPUT/float
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
    // Set initial virtual level based on pullup/pulldown logic if un-driven
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
            
            // DHT-22 timing sequence:
            // 0 to 40us: Host release, line goes HIGH (pulled up)
            if (elapsed < 40) {
                return HIGH;
            }
            // 40us to 120us (80us): DHT pulls LOW
            if (elapsed < 120) {
                return LOW;
            }
            // 120us to 200us (80us): DHT pulls HIGH (prep)
            if (elapsed < 200) {
                return HIGH;
            }
            
            // Data bits: 40 bits
            unsigned long bit_start = 200;
            
            uint16_t h_val = sim_dht_hum[pin];
            int16_t t_val = sim_dht_temp[pin];
            uint16_t t_unsigned = abs(t_val);
            if (t_val < 0) {
                t_unsigned |= 0x8000; // Sign bit
            }
            uint8_t checksum = ((h_val >> 8) + (h_val & 0xFF) + (t_unsigned >> 8) + (t_unsigned & 0xFF)) & 0xFF;
            
            for (int i = 0; i < 40; i++) {
                bool bit_val = false;
                if (i < 16) {
                    bit_val = (h_val >> (15 - i)) & 1;
                } else if (i < 32) {
                    bit_val = (t_unsigned >> (31 - i)) & 1;
                } else {
                    bit_val = (checksum >> (39 - i)) & 1;
                }
                
                unsigned long bit_len = 50 + (bit_val ? 70 : 27); // LOW 50us, HIGH 70us or 27us
                if (elapsed >= bit_start && elapsed < bit_start + bit_len) {
                    unsigned long bit_elapsed = elapsed - bit_start;
                    if (bit_elapsed < 50) {
                        return LOW;
                    } else {
                        return HIGH;
                    }
                }
                bit_start += bit_len;
            }
            
            // End of transmission: 50us LOW, then release (HIGH)
            if (elapsed >= bit_start && elapsed < bit_start + 50) {
                return LOW;
            }
            
            sim_dht_in_progress[pin] = false;
            return HIGH;
        }
        return HIGH; // DHT idle is HIGH
    }

    uint8_t val = sim_gpio_state[pin];
    if (val == 0xFF) {
        if (sim_gpio_mode[pin] == INPUT_PULLUP) {
            return HIGH;
        }
        return LOW; // standard INPUT floats to LOW
    }
    return val;
}

void sim_digitalWrite(uint8_t pin, uint8_t value) {
    if (pin >= SIM_GPIO_COUNT) return;
    
    if (sim_dht_enabled[pin]) {
        if (value == 0) {
            if (sim_gpio_state[pin] != 0) { // transition from HIGH/float to LOW
                sim_dht_low_start_us[pin] = micros();
            }
        } else {
            // transition from LOW to HIGH
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
    if (sim_gpio_state[pin] == level) return; // dedup  no change, skip TX
    sim_gpio_state[pin] = level;
    char frame[24];
    snprintf(frame, sizeof(frame), ">GPIO:%d:%d<", pin, level);
    _sim_send(frame);
}

uint16_t sim_analogRead(uint8_t pin) {
    if (pin >= SIM_GPIO_COUNT) return 0;
    uint16_t val = sim_gpio_analog_value[pin];
    if (val == 0xFFFF) {
        // Fallback to standard reading if not virtualized
        uint8_t dig = sim_gpio_state[pin];
        if (dig == 0xFF) return 0;
        return dig ? 4095 : 0;
    }
    return val;
}

//  Bridge init (called from injected setup() wrapper) 

void _simBridgeInit_Early() {
    // 1. Disable task watchdogs inside simulation builds to prevent false reboots
    disableCore0WDT();
#ifndef CONFIG_FREERTOS_UNICORE
    disableCore1WDT();
#endif

    // 2. TX mutex  first, before any _sim_send() is possible
    if (!_sim_serial_mtx) {
        _sim_serial_mtx = xSemaphoreCreateMutex();
    }

    // 3. Kill ALL ESP-IDF log noise
    esp_log_level_set("*", ESP_LOG_NONE);

    // 4. Force initialize serial port for simulation communication
    Serial.begin(SIM_UART_BAUD);
}

/**
 * _simBridgeInit_Late()
 * Called AFTER user's setup() completes. This prevents Guru Meditation Cache
 * Errors caused by the user calling Serial.begin() while our UART RX task
 * is already polling the UART driver.
 */
void _simBridgeInit_Late() {

    // 4. Clean startup banner  no firmware version, heap, or core-freq spam
    Serial.println();
    Serial.println(F(""));
    Serial.println(F("  ESP32 Simulator Started"));
    Serial.println(F("  Status        : READY"));
    Serial.println(F("  GPIO System   : OK"));
    Serial.println(F("  Runtime       : ACTIVE"));
    Serial.println(F(""));
    Serial.println();
    Serial.flush();

    // 5. Spawn UART RX task on Core 0
    xTaskCreatePinnedToCore(
        _simulatorUARTTask, "SimBridgeUART",
        SIM_TASK_STACK, nullptr, SIM_TASK_PRIO, nullptr, SIM_TASK_CORE
    );

    // 6. Spawn heartbeat task on Core 0 (lower priority)
#if SIM_HEARTBEAT_MS > 0
    xTaskCreatePinnedToCore(
        _simulatorHeartbeatTask, "SimHeartbeat",
        SIM_BEAT_STACK, nullptr, SIM_BEAT_PRIO, nullptr, SIM_TASK_CORE
    );
#endif
}

//  Macro hijacking 
// MUST appear AFTER all shim function definitions so that the shims themselves
// compile against the real Arduino API.

#undef  pinMode
#undef  digitalRead
#undef  digitalWrite
#undef  analogRead

#define pinMode      sim_pinMode
#define digitalRead  sim_digitalRead
#define digitalWrite sim_digitalWrite
#define analogRead   sim_analogRead

// Note: Wire and SPI interception is handled by the Wire.h / SPI.h shims
// (SimulatorWire.h / SimulatorWire.cpp) which are injected into the sketch
// build folder by compileController.js.  Those files completely redefine the
// TwoWire class so that every I2C write emits a >I2C:<addr>:<hex>< UART frame
// and every SPI byte emits a >SPI:<hex>< frame, all without touching hardware.

#endif // SIMULATOR_BRIDGE_H
