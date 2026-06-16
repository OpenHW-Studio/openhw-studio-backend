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

//  Configuration 

#define SIM_GPIO_COUNT      40
#define SIM_CMD_MAX_LEN     64
#define SIM_UART_BAUD       115200
#define SIM_TASK_STACK      4096
#define SIM_TASK_PRIO       1
#define SIM_TASK_CORE       1
#define SIM_TASK_DELAY_MS   10
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

// ── Core GPIO / Analog / Tone declarations ──────────────────────────────────
void sim_pinMode(uint8_t pin, uint8_t mode);
uint8_t sim_digitalRead(uint8_t pin);
void sim_digitalWrite(uint8_t pin, uint8_t value);
uint16_t sim_analogRead(uint8_t pin);
void sim_analogWrite(uint8_t pin, uint32_t value);
void sim_tone(uint8_t pin, unsigned int frequency, unsigned long duration = 0);
void sim_noTone(uint8_t pin);
void sim_dacWrite(uint8_t pin, uint8_t value);

// ── LEDC (LED Controller PWM) ────────────────────────────────────────────────
void sim_ledcSetup(uint8_t channel, double freq, uint8_t resolution_bits);
void sim_ledcAttachPin(uint8_t pin, uint8_t channel);
void sim_ledcWrite(uint8_t channel, uint32_t duty);
uint32_t sim_ledcRead(uint8_t channel);
void sim_ledcDetachPin(uint8_t pin);

// ── PCNT (Pulse Counter) ─────────────────────────────────────────────────────
void sim_pcntInit(uint8_t unit, uint8_t pin);
int16_t sim_pcntGetCount(uint8_t unit);
void sim_pcntClear(uint8_t unit);

// ── TWAI / CAN Bus ───────────────────────────────────────────────────────────
void sim_twaiTransmit(uint32_t id, uint8_t dlc, const uint8_t* data);

// ── RMT (IR / custom pulse) ──────────────────────────────────────────────────
void sim_rmtTx(uint8_t channel, const uint32_t* items, uint16_t num_items);

// ── Deep Sleep / RTC ─────────────────────────────────────────────────────────
void sim_deepSleep(uint64_t time_us);
void sim_lightSleep(uint64_t time_us);

// ── I2S Audio ─────────────────────────────────────────────────────────────────
// sim_i2s_write() captures PCM samples and emits >SIM:I2S:ch:sr:bits:b64< so
// the frontend can schedule them via Web Audio API.
// Call this instead of i2s_write() in your firmware sketch.
void sim_i2s_write(uint8_t port_num, const void* src, size_t size,
                   size_t* bytes_written, uint32_t ticks_to_wait,
                   uint32_t sample_rate = 44100, uint8_t bits = 16);
void sim_i2s_read(uint8_t port_num, void* dest, size_t size,
                  size_t* bytes_read, uint32_t ticks_to_wait);

// ── Camera shims (esp_camera_fb_get / esp_camera_fb_return) ──────────────────
// In simulation, esp_camera_fb_get() returns nullptr immediately (no frame).
// The real webcam stream is pushed from the frontend via sendCameraFrame().
// To get actual frames in simulation, check the CAMERA_FRAME event in your
// component's onCameraFrame() callback instead of polling esp_camera_fb_get().
struct camera_fb_t {
    uint8_t* buf;       ///< Pointer to the pixel data
    size_t   len;       ///< Length of the buffer in bytes
    size_t   width;     ///< Width of the buffer in pixels
    size_t   height;    ///< Height of the buffer in pixels
    uint32_t format;    ///< Format of the pixel data (PIXFORMAT_*)
};
#ifndef CAMERA_SHIM_DEFINED
#  define CAMERA_SHIM_DEFINED
#  define esp_camera_fb_get()       ((camera_fb_t*)nullptr)
#  define esp_camera_fb_return(fb)  ((void)(fb))
#  define esp_camera_init(cfg)      (ESP_OK)
#  define esp_camera_deinit()       (ESP_OK)
#endif

// ── Simulator init ───────────────────────────────────────────────────────────
void _simBridgeInit_Early();
void _simBridgeInit_Late();

// ─────────────────────────────────────────────────────────────────────────────
//  Macro hijacking — redirect Arduino/ESP-IDF API calls to simulator shims
// ─────────────────────────────────────────────────────────────────────────────
#undef  pinMode
#undef  digitalRead
#undef  digitalWrite
#undef  analogRead
#undef  analogWrite
#undef  tone
#undef  noTone

#define pinMode         sim_pinMode
#define digitalRead     sim_digitalRead
#define digitalWrite    sim_digitalWrite
#define analogRead      sim_analogRead
#define analogWrite     sim_analogWrite
#define tone            sim_tone
#define noTone          sim_noTone
#define dacWrite        sim_dacWrite

// LEDC macros
#define ledcSetup       sim_ledcSetup
#define ledcAttachPin   sim_ledcAttachPin
#define ledcWrite       sim_ledcWrite
#define ledcRead        sim_ledcRead
#define ledcDetachPin   sim_ledcDetachPin

// I2S macros — redirect i2s_write/i2s_read to simulator shims
// sim_i2s_write emits >SIM:I2S:< frames that the frontend plays via Web Audio
#define i2s_write(port, src, size, written, ticks) \
    sim_i2s_write((port), (src), (size), (written), (ticks), 44100, 16)
#define i2s_read(port, dest, size, read, ticks) \
    sim_i2s_read((port), (dest), (size), (read), (ticks))

// Deep sleep macros
#define esp_deep_sleep_start()            sim_deepSleep(0)
#define esp_deep_sleep(us)                sim_deepSleep(us)
#define esp_light_sleep_start()           sim_lightSleep(0)

// ── RNG shims (no hardware register access needed) ───────────────────────────
#ifndef esp_random
#  define esp_random()            ((uint32_t)rand())
#  define esp_fill_random(buf,n)  do { for(int _i=0;_i<(int)(n);_i++) ((uint8_t*)(buf))[_i]=(uint8_t)rand(); } while(0)
#endif

// ── PSRAM shims (ps_malloc falls back to heap malloc in simulation) ──────────
#ifndef ps_malloc
#  define ps_malloc(size)   malloc(size)
#  define ps_calloc(n,s)    calloc(n,s)
#  define ps_realloc(p,s)   realloc(p,s)
#  define ps_free(p)        free(p)
#  define heap_caps_malloc(size,caps)   malloc(size)
#  define heap_caps_calloc(n,s,caps)    calloc(n,s)
#  define heap_caps_realloc(p,s,caps)   realloc(p,s)
#  define heap_caps_free(p)             free(p)
#endif

// ── Watchdog shims ───────────────────────────────────────────────────────────
// WDT is already disabled in _simBridgeInit_Early; stubs prevent linker errors
#define esp_task_wdt_init(timeout,panic)  ((void)0)
#define esp_task_wdt_deinit()             ((void)0)
#define esp_task_wdt_add(task)            ((void)0)
#define esp_task_wdt_delete(task)         ((void)0)
#define esp_task_wdt_reset()              ((void)0)

// ── RTC memory attribute ─────────────────────────────────────────────────────
// In simulation, RTC_DATA_ATTR variables are just normal static variables.
// They don't survive a stop/start but are stable for the lifetime of the sketch.
#ifndef RTC_DATA_ATTR
#  define RTC_DATA_ATTR   static
#  define RTC_RODATA_ATTR static const
#  define RTC_FAST_ATTR   static
#  define RTC_SLOW_ATTR   static
#endif

// ── USB guard stubs (ESP32-S2/S3 only — not applicable to base ESP32) ────────
// Prevents compile errors if firmware includes USB headers conditionally
#ifdef CONFIG_IDF_TARGET_ESP32S2
#  define USB_SERIAL_JTAG_AVAILABLE  0
#endif
#ifdef CONFIG_IDF_TARGET_ESP32S3
#  define USB_SERIAL_JTAG_AVAILABLE  0
#endif

// ── ECC guard (ESP32-S3/C6 only) ─────────────────────────────────────────────
#ifndef esp_ecc_point_multiply
#  define esp_ecc_point_multiply(...)  ESP_ERR_NOT_SUPPORTED
#endif

#endif // SIMULATOR_BRIDGE_H

