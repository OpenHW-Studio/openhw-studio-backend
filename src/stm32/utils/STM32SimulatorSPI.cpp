#include "SPI.h"
#include <Arduino.h>

SPIClass SPI;

static inline char _nibble(uint8_t n) {
    n &= 0x0F;
    return (char)(n < 10 ? ('0' + n) : ('a' + n - 10));
}

static void _write_bulk(const uint8_t* data, uint32_t size);

void SPIClass::flush() {
    if (_tx_len == 0) return;
    _write_bulk(_tx_buf, _tx_len);
    _tx_len = 0;
}

void SPIClass::write(uint8_t data) {
    _tx_buf[_tx_len++] = data;
    if (_tx_len >= 64) {
        flush();
    }
}

void SPIClass::write16(uint16_t data) {
    write((uint8_t)(data >> 8));
    write((uint8_t)data);
}

uint8_t SPIClass::transfer(uint8_t data) {
    write(data);
    return 0xFF;
}

uint16_t SPIClass::transfer16(uint16_t data) {
    write((uint8_t)(data >> 8));
    write((uint8_t)data);
    return 0xFFFF;
}

static void _write_bulk(const uint8_t* data, uint32_t size) {
    if (!data || size == 0) return;

    uint32_t offset = 0;
    while (offset < size) {
        uint32_t chunk_size = size - offset;
        if (chunk_size > 128) chunk_size = 128;

        char frame[280];
        int pos = 0;

        frame[pos++] = '>';
        frame[pos++] = 'S';
        frame[pos++] = 'P';
        frame[pos++] = 'I';
        frame[pos++] = 'B';
        frame[pos++] = 'U';
        frame[pos++] = 'F';
        frame[pos++] = ':';

        for (uint32_t i = 0; i < chunk_size; i++) {
            uint8_t b = data[offset + i];
            frame[pos++] = _nibble(b >> 4);
            frame[pos++] = _nibble(b);
        }

        frame[pos++] = '<';
        frame[pos] = '\0';

        sim_wire_emit(frame);
        offset += chunk_size;
    }
}

void SPIClass::transfer(void *data, uint32_t size) {
    flush();
    _write_bulk((const uint8_t*)data, size);
}

void SPIClass::transferBytes(const uint8_t *data, uint8_t *out, uint32_t size) {
    flush();
    _write_bulk(data, size);
    if (out) {
        memset(out, 0xFF, size);
    }
}

void SPIClass::writeBytes(const uint8_t *data, uint32_t size) {
    flush();
    _write_bulk(data, size);
}

void SPIClass::writePattern(const uint8_t *data, uint8_t size, uint32_t repeat) {
    flush();
    if (!data || size == 0 || repeat == 0) return;

    uint8_t buf[128];
    uint32_t buf_pos = 0;

    for (uint32_t r = 0; r < repeat; r++) {
        for (uint8_t i = 0; i < size; i++) {
            buf[buf_pos++] = data[i];
            if (buf_pos == 128) {
                _write_bulk(buf, 128);
                buf_pos = 0;
            }
        }
    }

    if (buf_pos > 0) {
        _write_bulk(buf, buf_pos);
    }
}
