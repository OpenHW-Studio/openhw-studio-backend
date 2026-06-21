import WebSocket from 'ws';
import fetch from 'node-fetch';

const API = 'http://localhost:5000/api';
const WS_URL = 'ws://localhost:5000';

const CODE = `
void setup() {
  Serial.begin(115200);
  Serial.println("Hello!");
}
void loop() {
  delay(500);
}
`;

async function main() {
  console.log('[TEST] Sending compile request...');
  let buildId;
  try {
    const res = await fetch(`${API}/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: CODE, target: 'esp32' })
    });
    const data = await res.json();
    buildId = data.buildId;
    console.log('[TEST] Got buildId:', buildId, 'Status:', res.status);
    if (!buildId) {
      console.error('[TEST] No buildId returned:', JSON.stringify(data));
      process.exit(1);
    }
  } catch (err) {
    console.error('[TEST] Compile request failed:', err.message);
    process.exit(1);
  }

  console.log('[TEST] Opening WebSocket...');
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[TEST] WS open, registering session...');
    ws.send(JSON.stringify({ type: 'REGISTER_SESSION', buildId }));
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const ts = new Date().toISOString().substring(11, 23);
    console.log(`[${ts}] MSG: ${msg.type}`, msg.message || msg.text || msg.code || '');

    if (msg.type === 'QEMU_ERROR' || msg.type === 'SESSION_NOT_FOUND' || msg.type === 'COMPILE_ERROR') {
      console.log('[TEST] ❌ Session ended early:', msg.type, msg.message || msg.output || '');
      ws.close();
    }

    if (msg.type === 'FIRMWARE_READY') {
      console.log('[TEST] ✅ Firmware is READY! Simulation running.');
      setTimeout(() => {
        console.log('[TEST] Test complete — closing.');
        ws.close();
      }, 3000);
    }
  });

  ws.on('error', (err) => console.error('[TEST] WS Error:', err.message));
  ws.on('close', () => {
    console.log('[TEST] WS closed.');
    process.exit(0);
  });

  setTimeout(() => {
    console.log('[TEST] Timed out after 3 minutes');
    ws.close();
    process.exit(1);
  }, 180000);
}

main();
