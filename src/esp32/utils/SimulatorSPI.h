#ifndef _SPI_H_INCLUDED
#define _SPI_H_INCLUDED

#include <Arduino.h>

#define SPI_HAS_TRANSACTION

#ifndef LSBFIRST
#define LSBFIRST 0
#endif
#ifndef MSBFIRST
#define MSBFIRST 1
#endif

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

#ifndef SS
#define SS    5
#endif
#ifndef MOSI
#define MOSI  23
#endif
#ifndef MISO
#define MISO  19
#endif
#ifndef SCK
#define SCK   18
#endif

#ifndef FSPI
#define FSPI  1
#endif
#ifndef HSPI
#define HSPI  2
#endif
#ifndef VSPI
#define VSPI  3
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
    explicit SPIClass(uint8_t spi_bus = HSPI)
        : _spi_num(spi_bus), _spi(nullptr), _use_hw_ss(false),
          _sck(-1), _miso(-1), _mosi(-1), _ss(-1),
          _div(0), _freq(1000000), _inTransaction(false), paramLock(nullptr),
          _tx_len(0) {}
    
    ~SPIClass() {}

    void flush();

    bool begin(int8_t sck = -1, int8_t miso = -1, int8_t mosi = -1, int8_t ss = -1);
    void end();

    void setHwCs(bool use) { _use_hw_ss = use; }
    void setSSInvert(bool invert) { (void)invert; }
    void setBitOrder(uint8_t bitOrder) { (void)bitOrder; }
    void setDataMode(uint8_t dataMode) { (void)dataMode; }
    void setFrequency(uint32_t freq) { _freq = freq; }
    void setClockDivider(uint32_t clockDiv) { _div = clockDiv; }
    uint32_t getClockDivider() { return _div; }

    void beginTransaction(SPISettings settings) {
        flush();
        _freq = settings._clock;
        _inTransaction = true;
    }
    void endTransaction(void) {
        flush();
        _inTransaction = false;
    }

    void transfer(void *data, uint32_t size);
    uint8_t transfer(uint8_t data);
    uint16_t transfer16(uint16_t data);
    uint32_t transfer32(uint32_t data);

    void transferBytes(const uint8_t *data, uint8_t *out, uint32_t size);
    void transferBits(uint32_t data, uint32_t *out, uint8_t bits);

    void write(uint8_t data);
    void write16(uint16_t data);
    void write32(uint32_t data);
    void writeBytes(const uint8_t *data, uint32_t size);
    void writePixels(const void *data, uint32_t size);
    void writePattern(const uint8_t *data, uint8_t size, uint32_t repeat);

    void *bus() { return _spi; }
    int8_t pinSS() { return _ss; }

private:
    int8_t _spi_num;
    void *_spi;
    bool _use_hw_ss;
    int8_t _sck;
    int8_t _miso;
    int8_t _mosi;
    int8_t _ss;
    uint32_t _div;
    uint32_t _freq;
    bool _inTransaction;
    void *paramLock;
    uint8_t _tx_buf[64];
    uint8_t _tx_len;
};

#if !defined(NO_GLOBAL_INSTANCES) && !defined(NO_GLOBAL_SPI)
extern SPIClass SPI;
#endif

extern void sim_wire_emit(const char* frame_in_sram);

#endif
