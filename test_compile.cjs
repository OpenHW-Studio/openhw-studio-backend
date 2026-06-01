const ws = require('ws');

fetch('http://localhost:5001/api/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        target: 'esp32',
        code: `
#include <OneWire.h>
#include <DallasTemperature.h>
OneWire ow(2);
DallasTemperature dt(&ow);
void setup() {
    Serial.begin(115200);
    Serial.println("TESTING");
    dt.begin();
    Serial.println("DONE");
}
void loop() {}
        `
    })
}).then(r => r.json()).then(d => {
    console.log("Compile started:", d);
    const client = new ws('ws://localhost:5001');
    client.on('open', () => {
        client.send(JSON.stringify({ type: 'REGISTER_SESSION', buildId: d.buildId }));
    });
    client.on('message', m => console.log("WS:", m.toString()));
    setTimeout(() => {
        console.log("Timeout, exiting.");
        process.exit();
    }, 20000);
}).catch(console.error);
