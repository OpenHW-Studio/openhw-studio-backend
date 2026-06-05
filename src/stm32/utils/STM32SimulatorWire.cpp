/**
 * STM32SimulatorWire.cpp    TwoWire sim implementation for STM32
 * Copied into sketch build folder as "Wire.cpp" by compileController.js.
 *
 * No FreeRTOS on STM32 Arduino — uses yield() / blocking delay instead.
 */

#include "Wire.h"
#include <Arduino.h>

// Shared RX buffer (written by STM32SimulatorBridge.h UART RX processing)
volatile uint8_t  sim_wire_rx_buf[SIM_WIRE_RX_SIZE] = {};
volatile uint8_t  sim_wire_rx_len   = 0;
volatile bool     sim_wire_rx_ready = false;

// Global Wire instances
TwoWire Wire(0);
TwoWire Wire1(1);

// Nibble helper
static inline char _nibble(uint8_t n) {
    n &= 0x0F;
    return (char)(n < 10 ? ('0' + n) : ('a' + n - 10));
}

// Constructor / init
TwoWire::TwoWire(uint8_t bus_num)
    : _addr(0), _tx_len(0), _rx_pos(0)
{
    (void)bus_num;
}

bool TwoWire::begin(int sda, int scl, uint32_t frequency)          { return true; }
bool TwoWire::begin(uint8_t slaveAddr, int sda, int scl, uint32_t frequency) { return true; }
bool TwoWire::setPins(int sda, int scl)                            { return true; }
bool TwoWire::setClock(uint32_t frequency)                          { return true; }
void TwoWire::setTimeOut(uint16_t timeOutMillis)                    { }
void TwoWire::setBufferSize(size_t sz)                              { (void)sz; }

// Master write

void TwoWire::beginTransmission(uint8_t address) {
    _addr   = address;
    _tx_len = 0;
}

void TwoWire::beginTransmission(int address) {
    beginTransmission((uint8_t)address);
}

size_t TwoWire::write(uint8_t data) {
    if (_tx_len < 1028) _tx_buf[_tx_len++] = data;
    return 1;
}

size_t TwoWire::write(const uint8_t* data, size_t len) {
    for (size_t i = 0; i < len && _tx_len < 1028; i++) {
        _tx_buf[_tx_len++] = data[i];
    }
    return len;
}

uint8_t TwoWire::endTransmission(bool sendStop) {
    // Build >I2C:<addr_hex>:<data_hex>< in stack memory
    // Maximum frame size: 6 (header) + 2 (addr) + 1 (:) + 2056 (1028 bytes*2) + 1 (<) + 1 (\0) = 2067
    char frame[2100];
    int pos = 0;

    frame[pos++] = '>';
    frame[pos++] = 'I'; frame[pos++] = '2'; frame[pos++] = 'C'; frame[pos++] = ':';
    frame[pos++] = _nibble(_addr >> 4);
    frame[pos++] = _nibble(_addr);
    frame[pos++] = ':';

    for (uint16_t i = 0; i < _tx_len; i++) {
        frame[pos++] = _nibble(_tx_buf[i] >> 4);
        frame[pos++] = _nibble(_tx_buf[i]);
    }

    frame[pos++] = '<';
    frame[pos]   = '\0';

    sim_wire_emit(frame);

    _tx_len = 0;
    return 0; // 0 = success (TwoWire convention)
}

uint8_t TwoWire::endTransmission(uint8_t sendStop) {
    return endTransmission((bool)sendStop);
}

// Master read

uint8_t TwoWire::requestFrom(uint8_t address, uint8_t size, bool sendStop) {
    // Build >I2C_READ:<addr_hex>:<qty_hex>< in stack memory
    char frame[20];
    int pos = 0;

    frame[pos++] = '>';
    frame[pos++] = 'I'; frame[pos++] = '2'; frame[pos++] = 'C'; frame[pos++] = '_';
    frame[pos++] = 'R'; frame[pos++] = 'E'; frame[pos++] = 'A'; frame[pos++] = 'D'; frame[pos++] = ':';
    frame[pos++] = _nibble(address >> 4);
    frame[pos++] = _nibble(address);
    frame[pos++] = ':';
    frame[pos++] = _nibble(size >> 4);
    frame[pos++] = _nibble(size);
    frame[pos++] = '<';
    frame[pos]   = '\0';

    sim_wire_emit(frame);

    // Clear ready flag, then spin-wait 12ms for UART processing to fill buffer
    sim_wire_rx_ready = false;
    sim_wire_rx_len   = 0;
    _rx_pos           = 0;

    const uint32_t deadline = millis() + 12;
    while (millis() < deadline) {
        yield(); // calls _process_serial_input() via our yield() override
        if (sim_wire_rx_ready) break;
        delay(1);
    }

    if (!sim_wire_rx_ready) return 0;
    _rx_pos = 0;
    return sim_wire_rx_len;
}

uint8_t TwoWire::requestFrom(uint16_t address, uint8_t size, bool sendStop) {
    return requestFrom((uint8_t)address, size, sendStop);
}
uint8_t TwoWire::requestFrom(uint8_t address, uint8_t size, uint8_t sendStop) {
    return requestFrom(address, size, (bool)sendStop);
}
uint8_t TwoWire::requestFrom(int address, int size, int sendStop) {
    return requestFrom((uint8_t)address, (uint8_t)size, (bool)sendStop);
}
uint8_t TwoWire::requestFrom(int address, int size) {
    return requestFrom((uint8_t)address, (uint8_t)size, true);
}

// Stream read

int TwoWire::available() {
    return (int)(sim_wire_rx_len - _rx_pos);
}

int TwoWire::read() {
    if (_rx_pos >= sim_wire_rx_len) return -1;
    return (int)sim_wire_rx_buf[_rx_pos++];
}

int TwoWire::peek() {
    if (_rx_pos >= sim_wire_rx_len) return -1;
    return (int)sim_wire_rx_buf[_rx_pos];
}
