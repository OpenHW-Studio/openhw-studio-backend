/**
 * STM32SimulatorWire.h  --  Sim-aware Wire.h replacement for STM32
 * -------------------------------------------------------------------------
 */

#ifndef TwoWire_h
#define TwoWire_h

#include <Arduino.h>

#ifndef I2C_BUFFER_LENGTH
#define I2C_BUFFER_LENGTH 128
#endif
#ifndef BUFFER_LENGTH
#define BUFFER_LENGTH     128
#endif

#define SIM_WIRE_RX_SIZE 64

extern "C" {
    extern volatile uint8_t  sim_wire_rx_buf[SIM_WIRE_RX_SIZE];
    extern volatile uint8_t  sim_wire_rx_len;
    extern volatile bool     sim_wire_rx_ready;
}

class TwoWire {
public:
    explicit TwoWire(uint8_t bus_num);
    ~TwoWire() {}

    bool begin(int sda = -1, int scl = -1, uint32_t frequency = 0);
    bool begin(uint8_t slaveAddr, int sda = -1, int scl = -1, uint32_t frequency = 0);
    bool end()  { return true; }
    bool setPins(int sda, int scl);
    bool setClock(uint32_t frequency);
    void setTimeOut(uint16_t timeOutMillis);
    void setBufferSize(size_t sz);

    void    beginTransmission(uint8_t address);
    void    beginTransmission(int     address);
    uint8_t endTransmission(bool sendStop = true);
    uint8_t endTransmission(uint8_t sendStop);

    uint8_t requestFrom(uint8_t  address, uint8_t  size, bool    sendStop = true);
    uint8_t requestFrom(uint16_t address, uint8_t  size, bool    sendStop = true);
    uint8_t requestFrom(uint8_t  address, uint8_t  size, uint8_t sendStop);
    uint8_t requestFrom(int      address, int      size, int     sendStop);
    uint8_t requestFrom(int      address, int      size);
    size_t  requestFrom(uint8_t address, size_t size, bool sendStop = true) {
        return (size_t)requestFrom(address, (uint8_t)size, sendStop);
    }

    size_t write(uint8_t data);
    size_t write(const uint8_t* data, size_t len);
    size_t write(const char* s)       { return write((const uint8_t*)s, strlen(s)); }
    size_t write(int n)               { return write((uint8_t)n); }
    size_t write(unsigned int n)      { return write((uint8_t)n); }
    size_t write(long n)              { return write((uint8_t)n); }
    size_t write(unsigned long n)     { return write((uint8_t)n); }

    int     available();
    int     read();
    int     peek();
    void    flush() {}

    void onReceive(void (*cb)(int))  { (void)cb; }
    void onRequest(void (*cb)(void)) { (void)cb; }

    size_t  getBufferSize()  { return I2C_BUFFER_LENGTH; }
    uint8_t lastError()      { return 0; }
    String  getErrorText(uint8_t err) { (void)err; return "OK"; }

private:
    uint8_t  _addr;
    uint8_t  _tx_buf[1028];
    uint16_t _tx_len;
    uint8_t  _rx_pos;
};

extern TwoWire Wire;
extern TwoWire Wire1;

extern void sim_wire_emit(const char* frame_in_sram);

#endif /* TwoWire_h */
