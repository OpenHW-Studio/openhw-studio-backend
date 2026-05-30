#ifndef _SPI_H_INCLUDED
#define _SPI_H_INCLUDED

#include <Arduino.h>

#define SPI_HAS_TRANSACTION

#ifndef SPI_MODE0
#define SPI_MODE0 0x00
#endif
#ifndef SPI_MODE1
#define SPI_MODE1 0x01
#endif
#ifndef SPI_MODE2
#define SPI_MODE2 0x02
#endif
#ifndef SPI_MODE3
#define SPI_MODE3 0x03
#endif

// STM32 Blue Pill SPI1 default pins
#ifndef SS
#define SS    PA4
#endif
#ifndef MOSI
#define MOSI  PA7
#endif
#ifndef MISO
#define MISO  PA6
#endif
#ifndef SCK
#define SCK   PA5
#endif

class SPISettings {
public:
    SPISettings() : _clock(1000000), _bitOrder(MSBFIRST), _dataMode(SPI_MODE0) {}
    SPISettings(uint32_t clock, uint8_t bitOrder, uint8_t dataMode)
        : _clock(clock), _bitOrder(bitOrder), _dataMode(dataMode) {}
    uint32_t _clock;
    uint8_t _bitOrder;
    uint8_t _dataMode;
};

class SPIClass {
public:
    SPIClass() : _tx_len(0) {}
    ~SPIClass() {}

    void flush();

    void begin(uint8_t _pin = SS) { _tx_len = 0; }
    void end() { flush(); }

    void setBitOrder(uint8_t bitOrder) { (void)bitOrder; }
    void setDataMode(uint8_t dataMode) { (void)dataMode; }
    void setClockDivider(uint32_t clockDiv) { (void)clockDiv; }

    void beginTransaction(SPISettings settings) {
        flush();
    }
    void endTransaction(void) {
        flush();
    }

    void transfer(void *data, uint32_t size);
    uint8_t transfer(uint8_t data);
    uint16_t transfer16(uint16_t data);

    void transferBytes(const uint8_t *data, uint8_t *out, uint32_t size);

    void write(uint8_t data);
    void write16(uint16_t data);
    void writeBytes(const uint8_t *data, uint32_t size);
    void writePattern(const uint8_t *data, uint8_t size, uint32_t repeat);

private:
    uint8_t _tx_buf[64];
    uint8_t _tx_len;
};

extern SPIClass SPI;

extern void sim_wire_emit(const char* frame_in_sram);

#endif
