/**
 * SimulatorWiFi.h  —  Self-contained WiFi shim for the ESP32 QEMU simulator
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides the WiFiClass API expected by user sketches and popular libraries
 * (Blynk, PubSubClient, HTTPClient, etc.) without requiring the real ESP-IDF
 * WiFi stack, which is not functional inside QEMU.
 *
 * All network traffic is proxied over UART1 to NetworkProxy.js on the host,
 * which performs actual TCP / TLS connections on behalf of the firmware.
 *
 * Works with ESP32 Arduino core 3.x.x (IDF 5.x based).
 *
 * ── Design notes ─────────────────────────────────────────────────────────────
 *  • WiFi status constants are plain #defines to avoid typedef conflicts with
 *    the real wl_status_t defined in ESP32 Arduino 3.x WiFi headers.
 *  • _simMtx protects the shared serial buffers accessed from both loop()
 *    (WiFiClient calls) and the Serial1 ISR / background task context.
 *  • The static storage for _connBufs uses index 1–8; index 0 is unused so
 *    connId maps directly to array index without any subtraction.
 */

#ifndef SIMULATOR_WIFI_H
#define SIMULATOR_WIFI_H

#pragma once

#include <Arduino.h>
#include <mutex>

// ─── WiFi status constants ────────────────────────────────────────────────────
// Defined as plain #defines (not enum) to avoid typedef conflict with the real
// wl_status_t that may be pulled in by other ESP32 library headers.

#ifndef WL_NO_SHIELD
#  define WL_NO_SHIELD       255
#endif
#ifndef WL_IDLE_STATUS
#  define WL_IDLE_STATUS     0
#endif
#ifndef WL_NO_SSID_AVAIL
#  define WL_NO_SSID_AVAIL   1
#endif
#ifndef WL_SCAN_COMPLETED
#  define WL_SCAN_COMPLETED  2
#endif
#ifndef WL_CONNECTED
#  define WL_CONNECTED       3
#endif
#ifndef WL_CONNECT_FAILED
#  define WL_CONNECT_FAILED  4
#endif
#ifndef WL_CONNECTION_LOST
#  define WL_CONNECTION_LOST 5
#endif
#ifndef WL_DISCONNECTED
#  define WL_DISCONNECTED    6
#endif

// Only define wl_status_t if no SDK header has already defined it
#ifndef _WL_STATUS_T_DEFINED_
#  define _WL_STATUS_T_DEFINED_
typedef uint8_t wl_status_t;
#endif

// ─── WiFi mode constants ──────────────────────────────────────────────────────
#ifndef WIFI_MODE_STA
#  define WIFI_MODE_NULL  0
#  define WIFI_MODE_STA   1
#  define WIFI_MODE_AP    2
#  define WIFI_MODE_APSTA 3
#endif
#ifndef WIFI_STA
#  define WIFI_STA    WIFI_MODE_STA
#  define WIFI_AP     WIFI_MODE_AP
#  define WIFI_AP_STA WIFI_MODE_APSTA
#  define WIFI_OFF    WIFI_MODE_NULL
#endif

// Auth mode stubs
#ifndef WIFI_AUTH_OPEN
#  define WIFI_AUTH_OPEN     0
#  define WIFI_AUTH_WPA_PSK  2
#  define WIFI_AUTH_WPA2_PSK 3
#endif

// ─── Simulated network identity ───────────────────────────────────────────────
// The host-side NetworkProxy assigns SLIRP addresses; these must match.
#define SIM_LOCAL_IP_A  10
#define SIM_LOCAL_IP_B  13
#define SIM_LOCAL_IP_C  37
#define SIM_LOCAL_IP_D  2

#define SIM_GW_IP_D     1
#define SIM_RSSI        (-55)
#define SIM_CHANNEL     6
#define SIM_UART_BAUD   115200

// ─── Maximum number of simultaneous virtual sockets ──────────────────────────
#define SIM_MAX_CONN    8

// ─── Per-connection receive buffer capacity (bytes) ──────────────────────────
// Keep this reasonably large; String re-allocation is expensive on embedded.
#define SIM_CONN_BUF_CAP  8192

// ─── WiFiClass ────────────────────────────────────────────────────────────────

class WiFiClass {
public:
    WiFiClass() = default;

    // ── begin() — immediately returns WL_CONNECTED ────────────────────────────
    // Boots UART1 proxy on first call only; subsequent calls are idempotent.
    wl_status_t begin(const char* ssid   = nullptr,
                      const char* pass   = nullptr,
                      int32_t     channel = 0,
                      const uint8_t* bssid = nullptr,
                      bool        connect  = true) {
        _ssid   = ssid ? ssid : "SimNet";
        _status = WL_CONNECTED;

        if (!_proxyReady) {
            Serial1.begin(SIM_UART_BAUD);
            _proxyReady = true;
            _sendFrame(0, "WIFI_READY", "1");
        }
        return static_cast<wl_status_t>(_status);
    }

    wl_status_t begin(const String& ssid, const String& pass) {
        return begin(ssid.c_str(), pass.c_str());
    }
    wl_status_t begin(const String& ssid) {
        return begin(ssid.c_str(), nullptr);
    }

    void disconnect(bool /*wifiOff*/ = false) { _status = WL_DISCONNECTED; }

    // ── Status ────────────────────────────────────────────────────────────────
    wl_status_t status()      const { return static_cast<wl_status_t>(_status); }
    bool        isConnected() const { return _status == WL_CONNECTED; }

    // ── Addressing ────────────────────────────────────────────────────────────
    IPAddress localIP()    const { return IPAddress(SIM_LOCAL_IP_A, SIM_LOCAL_IP_B, SIM_LOCAL_IP_C, SIM_LOCAL_IP_D); }
    IPAddress gatewayIP()  const { return IPAddress(SIM_LOCAL_IP_A, SIM_LOCAL_IP_B, SIM_LOCAL_IP_C, SIM_GW_IP_D); }
    IPAddress subnetMask() const { return IPAddress(255, 255, 255, 0); }
    IPAddress dnsIP(uint8_t /*i*/ = 0) const { return IPAddress(8, 8, 8, 8); }

    // ── Identity ──────────────────────────────────────────────────────────────
    String   SSID()       const { return _ssid; }
    int32_t  RSSI()       const { return SIM_RSSI; }
    int32_t  channel()    const { return SIM_CHANNEL; }
    String   macAddress() const { return String("DE:AD:BE:EF:00:01"); }

    uint8_t* BSSID(uint8_t* buf = nullptr) {
        static uint8_t mac[6] = {0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01};
        if (buf) { memcpy(buf, mac, 6); return buf; }
        return mac;
    }

    // ── Mode / config stubs ───────────────────────────────────────────────────
    bool mode(uint8_t)              { return true; }
    bool enableSTA(bool)            { return true; }
    bool enableAP(bool)             { return false; }
    bool setAutoReconnect(bool)     { return true; }
    bool setAutoConnect(bool)       { return true; }
    bool setHostname(const char*)   { return true; }
    bool setSleep(bool)             { return true; }
    bool setTxPower(int)            { return true; }

    // ── Scan stubs ────────────────────────────────────────────────────────────
    int8_t  scanNetworks(bool = false, bool = false,
                         bool = false, uint32_t = 300, uint8_t = 0) { return 0; }
    int16_t scanComplete() { return 0; }
    void    scanDelete()   {}

    // ── AP / SmartConfig stubs ────────────────────────────────────────────────
    bool softAP(const char*, const char* = nullptr,
                int = 1, int = 0, int = 4)           { return false; }
    bool softAPdisconnect(bool = false)               { return false; }
    bool beginSmartConfig()                           { return false; }
    bool stopSmartConfig()                            { return false; }
    bool smartConfigDone()                            { return false; }

    // ── Internal proxy frame helpers ──────────────────────────────────────────
    // These are public (accessed by WiFiClient / WiFiServer shims via the
    // WiFiClass:: scope) but should not be called directly from user code.

    /**
     * _sendFrame(connId, cmd, payload)
     * Writes a single framed message to UART1 (NetworkProxy.js reads it).
     * Format: SOH <connId>:<cmd>:<payload> ETX \n
     * Thread-safe via _simMtx.
     */
    static void _sendFrame(uint8_t id, const char* cmd, const char* payload) {
        std::lock_guard<std::mutex> lock(_simMtx);
        Serial1.write(0x01);
        Serial1.print(id);
        Serial1.write(':');
        Serial1.print(cmd);
        Serial1.write(':');
        Serial1.print(payload);
        Serial1.write(0x02);
        Serial1.write('\n');
        Serial1.flush();
    }

    /**
     * _pumpSerial()
     * Drain UART1 RX into per-connection buffers and the inbound client queue.
     * Frame format from proxy: STX <connId>:<data> EOT \n
     * Thread-safe via _simMtx.
     */
    static void _pumpSerial() {
        std::lock_guard<std::mutex> lock(_simMtx);
        while (Serial1.available()) {
            const char c = static_cast<char>(Serial1.read());
            _inBuf += c;

            if (c == '\n') {
                const int s = _inBuf.indexOf(char(0x03));
                const int e = _inBuf.indexOf(char(0x04));

                if (s >= 0 && e > s) {
                    const String frame = _inBuf.substring(s + 1, e);
                    _inBuf.clear();

                    const int col = frame.indexOf(':');
                    if (col < 1) continue;

                    const uint8_t id = static_cast<uint8_t>(frame.substring(0, col).toInt());
                    const String  pl = frame.substring(col + 1);

                    if (id == 0 && pl.startsWith("INCOMING_CLIENT:")) {
                        const uint8_t nid = static_cast<uint8_t>(pl.substring(16).toInt());
                        if (_clientQueueLen < SIM_MAX_CONN) {
                            _clientQueue[_clientQueueLen++] = nid;
                        }
                    } else if (id >= 1 && id <= SIM_MAX_CONN) {
                        // Guard buffer capacity to prevent heap exhaustion
                        if (static_cast<int>(_connBufs[id].length()) < SIM_CONN_BUF_CAP) {
                            _connBufs[id] += pl;
                            _connBufs[id] += '\n';
                        }
                    }
                } else {
                    _inBuf.clear(); // Discard corrupt / partial frame
                }
            }
        }
    }

    /**
     * _popFrame(id, out)
     * Extract the next newline-delimited response frame for connection id.
     * Returns true if a frame was available, false otherwise.
     */
    static bool _popFrame(uint8_t id, String& out) {
        _pumpSerial();
        std::lock_guard<std::mutex> lock(_simMtx);

        if (id < 1 || id > SIM_MAX_CONN) return false;

        const int nl = _connBufs[id].indexOf('\n');
        if (nl < 0) return false;

        out = _connBufs[id].substring(0, nl);
        _connBufs[id] = _connBufs[id].substring(nl + 1);
        return true;
    }

    /**
     * _popIncomingClient()
     * Dequeue the next inbound client connId, or 0 if none pending.
     */
    static uint8_t _popIncomingClient() {
        _pumpSerial();
        std::lock_guard<std::mutex> lock(_simMtx);

        if (_clientQueueLen == 0) return 0;

        const uint8_t id = _clientQueue[0];
        // Shift the queue left (queue depth ≤ 8, shift cost is negligible)
        for (int i = 1; i < _clientQueueLen; ++i) _clientQueue[i - 1] = _clientQueue[i];
        --_clientQueueLen;
        return id;
    }

private:
    uint8_t _status     = WL_DISCONNECTED;
    bool    _proxyReady = false;
    String  _ssid;

    // Shared static state (all WiFiClient instances share one UART1 channel)
    static std::mutex  _simMtx;
    static String      _inBuf;
    static String      _connBufs[SIM_MAX_CONN + 1]; // index 1–8
    static uint8_t     _clientQueue[SIM_MAX_CONN];
    static uint8_t     _clientQueueLen;
};

// ─── Static storage definitions ───────────────────────────────────────────────
std::mutex  WiFiClass::_simMtx;
String      WiFiClass::_inBuf;
String      WiFiClass::_connBufs[SIM_MAX_CONN + 1];
uint8_t     WiFiClass::_clientQueue[SIM_MAX_CONN];
uint8_t     WiFiClass::_clientQueueLen = 0;

// ─── Global singleton (Arduino convention) ────────────────────────────────────
// Declared extern first so other headers can forward-declare it.
extern WiFiClass WiFi;
WiFiClass WiFi;

// Pull in WiFiClient so libraries that #include "WiFi.h" and expect WiFiClient
// to be available automatically do not have to add a separate #include.
#include "WiFiClient.h"

#endif // SIMULATOR_WIFI_H
