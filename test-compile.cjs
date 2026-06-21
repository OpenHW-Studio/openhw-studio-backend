const axios = require('axios');
const fs = require('fs');

async function run() {
    try {
        const response = await axios.post('http://localhost:5001/api/compile', {
            code: 'void setup() { Serial.begin(115200); Serial.println("Hello from ESP32"); } void loop() {}',
            target: 'esp32'
        });
        console.log('Response:', response.data);
    } catch (e) {
        console.error('Error:', e.response ? e.response.data : e.message);
    }
}
run();
