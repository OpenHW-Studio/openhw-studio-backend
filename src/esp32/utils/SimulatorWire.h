/**
 * SimulatorWire.h  --  Sim-aware Wire.h replacement  (v1.0)
 * -------------------------------------------------------------------------
 * Injected into every sketch build folder as "Wire.h" by compileController.js.
 * Arduino-CLI searches the sketch directory FIRST, so this file shadows the
 * ESP32 core's Wire.h for ALL translation units (sketch + Adafruit libraries).
 *
 * How it works:
 *   - Completely redefines TwoWire -- no inheritance from the real class.
 *   - All I2C write transactions emit a >I2C:<addr_hex>:<data_hex>< UART frame
 *     that qemuRunner.js intercepts and forwards as an I2C_TRANSACTION
 *     WebSocket event -> BackendProxyRunner -> OLED/LCD component.
 *   - All I2C read transactions (requestFrom) emit >I2C_READ:<addr>:<qty><
 *     then spin-wait (<=8 ms) for <I2C_RESP:addr:hex> injected by qemuRunner.js
 *     via the UART RX socket.
 *   - No real I2C hardware is touched -> zero QEMU timeouts / hangs.
 *
 * Shared buffers (defined in Wire.cpp, used by SimulatorBridge.h UART task):
 *   sim_wire_rx_buf   -- bytes received from frontend for the current read
 *   sim_wire_rx_len   -- how many bytes are valid
 *   sim_wire_rx_ready -- set to true by UART task after parsing <I2C_RESP:>
 */

#ifndef TwoWire_h
#define TwoWire_h

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

/* Compatibility defines expected by Adafruit_BusIO and other libraries */
#ifndef I2C_BUFFER_LENGTH
#define I2C_BUFFER_LENGTH 128
#endif
#ifndef BUFFER_LENGTH
#define BUFFER_LENGTH     128
#endif

/* ---- Shared I2C RX buffer ------------------------------------------------
 * Written by SimulatorBridge.h UART RX task (Core 0) when it parses
 * <I2C_RESP:addr:hex>. Read by requestFrom() (Core 1) via spin-wait.
 */
#define SIM_WIRE_RX_SIZE 64

extern volatile uint8_t  sim_wire_rx_buf[SIM_WIRE_RX_SIZE];
extern volatile uint8_t  sim_wire_rx_len;
extern volatile bool     sim_wire_rx_ready;

/* ---- TwoWire (sim replacement) ------------------------------------------ */

class TwoWire {
public:
    explicit TwoWire(uint8_t bus_num);
    ~TwoWire() {}

    /* Initialisation -- always succeeds (no hardware) */
    bool begin(int sda = -1, int scl = -1, uint32_t frequency = 0);
    bool begin(uint8_t slaveAddr, int sda = -1, int scl = -1, uint32_t frequency = 0);
    bool end()  { return true; }
    bool setPins(int sda, int scl);
    bool setClock(uint32_t frequency);
    void setTimeOut(uint16_t timeOutMillis);
    void setBufferSize(size_t sz);

    /* I2C master write */
    void    beginTransmission(uint8_t address);
    void    beginTransmission(int     address);
    uint8_t endTransmission(bool sendStop = true);
    uint8_t endTransmission(uint8_t sendStop);

    /* I2C master read -- all overloads funnel into requestFrom(u8,u8,bool) */
    uint8_t requestFrom(uint8_t  address, uint8_t  size, bool    sendStop = true);
    uint8_t requestFrom(uint16_t address, uint8_t  size, bool    sendStop = true);
    uint8_t requestFrom(uint8_t  address, uint8_t  size, uint8_t sendStop);
    uint8_t requestFrom(int      address, int      size, int     sendStop);
    uint8_t requestFrom(int      address, int      size);
    /* size_t variant used by some Adafruit/community libraries */
    size_t  requestFrom(uint8_t address, size_t size, bool sendStop = true) {
        return (size_t)requestFrom(address, (uint8_t)size, sendStop);
    }

    /* Stream write */
    size_t write(uint8_t data);
    size_t write(const uint8_t* data, size_t len);
    size_t write(const char* s)       { return write((const uint8_t*)s, strlen(s)); }
    size_t write(int n)               { return write((uint8_t)n); }
    size_t write(unsigned int n)      { return write((uint8_t)n); }
    size_t write(long n)              { return write((uint8_t)n); }
    size_t write(unsigned long n)     { return write((uint8_t)n); }

    /* Stream read */
    int     available();
    int     read();
    int     peek();
    void    flush() {}

    /* Slave mode callbacks (no-op in sim) */
    void onReceive(void (*cb)(int))  { (void)cb; }
    void onRequest(void (*cb)(void)) { (void)cb; }

    /* Utility / error reporting (always OK in sim) */
    size_t  getBufferSize()  { return I2C_BUFFER_LENGTH; }
    uint8_t lastError()      { return 0; }
    String  getErrorText(uint8_t err) { (void)err; return "OK"; }

private:
    uint8_t  _addr;
    uint8_t  _tx_buf[256];
    uint16_t _tx_len;
    uint8_t  _rx_pos;   /* cursor into sim_wire_rx_buf */
};

/* ---- Globals (defined in Wire.cpp) -------------------------------------- */
extern TwoWire Wire;
extern TwoWire Wire1;

/* ---- Safe I2C frame emitter (defined in SimulatorBridge.h) --------------
 * Frame MUST be in SRAM (stack/heap). Uses the serial mutex -> thread-safe.
 */
extern void sim_wire_emit(const char* frame_in_sram);

#endif /* TwoWire_h */
