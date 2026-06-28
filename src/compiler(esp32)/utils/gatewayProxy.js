import net from 'net';
import WebSocket from 'ws';

export default class GatewayProxy {
    constructor(buildId, sessionId, wssUrl, onReady) {
        this.buildId = buildId;
        this.sessionId = sessionId;
        this.wssUrl = wssUrl; // e.g. ws://localhost:5099
        this._onReady = onReady;
        this._server = null;
        this._qemuSocket = null;
        this._ws = null;
        this._destroyed = false;
        this._port = 0;
    }

    start() {
        this._server = net.createServer((socket) => {
            if (this._qemuSocket) {
                socket.destroy();
                return;
            }
            console.log(`[GatewayProxy:${this.buildId.substring(0,8)}] QEMU Ethernet connected.`);
            this._qemuSocket = socket;

            // Connect to Go Gateway WebSocket
            const wsUrl = `${this.wssUrl}/api/network-gateway?sessionId=${this.sessionId}`;
            this._ws = new WebSocket(wsUrl);

            this._ws.on('open', () => {
                console.log(`[GatewayProxy:${this.buildId.substring(0,8)}] Connected to Go Gateway: ${wsUrl}`);
            });

            this._ws.on('message', (data) => {
                // If it's the welcome message (JSON), ignore it. 
                // The gateway sends a JSON string first, then binary frames.
                if (typeof data === 'string' || (data instanceof Buffer && data[0] === '{'.charCodeAt(0))) {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.type === 'aloha') return;
                    } catch (e) {}
                }

                // If it's a binary frame, forward to QEMU.
                // QEMU expects: uint32 length + frame bytes.
                if (data instanceof Buffer && this._qemuSocket && !this._qemuSocket.destroyed) {
                    const lenBuf = Buffer.alloc(4);
                    lenBuf.writeUInt32BE(data.length, 0);
                    this._qemuSocket.write(lenBuf);
                    this._qemuSocket.write(data);
                }
            });

            this._ws.on('close', () => {
                console.log(`[GatewayProxy] WS Closed`);
                if (this._qemuSocket) this._qemuSocket.destroy();
            });

            this._ws.on('error', (err) => {
                console.error(`[GatewayProxy] WS Error: ${err.message}`);
                if (this._qemuSocket) this._qemuSocket.destroy();
            });

            // Read from QEMU and send to WebSocket
            // QEMU sends: uint32 length + frame bytes.
            let rxBuf = Buffer.alloc(0);
            socket.on('data', (data) => {
                rxBuf = Buffer.concat([rxBuf, data]);

                while (rxBuf.length >= 4) {
                    const frameLen = rxBuf.readUInt32BE(0);
                    if (rxBuf.length >= 4 + frameLen) {
                        const frame = rxBuf.slice(4, 4 + frameLen);
                        rxBuf = rxBuf.slice(4 + frameLen);
                        
                        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
                            this._ws.send(frame);
                        }
                    } else {
                        break; // wait for more data
                    }
                }
            });

            socket.on('close', () => {
                console.log(`[GatewayProxy] QEMU disconnected.`);
                this._qemuSocket = null;
                if (this._ws) {
                    this._ws.close();
                    this._ws = null;
                }
            });

            socket.on('error', (err) => {
                console.error(`[GatewayProxy] QEMU socket error: ${err.message}`);
            });
        });

        this._server.listen(0, '127.0.0.1', () => {
            this._port = this._server.address().port;
            console.log(`[GatewayProxy:${this.buildId.substring(0,8)}] Listening on port ${this._port}`);
            if (this._onReady) this._onReady(this._port);
        });
    }

    stop() {
        this._destroyed = true;
        if (this._server) this._server.close();
        if (this._qemuSocket) this._qemuSocket.destroy();
        if (this._ws) this._ws.close();
    }
}
