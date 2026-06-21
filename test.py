import urllib.request
import json

data = json.dumps({
    "code": "void setup() { Serial.begin(115200); Serial.println(\"Hello from ESP32\"); } void loop() {}",
    "target": "esp32",
    "isFrontendEsp32": False
}).encode('utf-8')

req = urllib.request.Request('http://localhost:5001/api/compile', data=data, headers={'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(req) as response:
        print(response.read().decode('utf-8'))
except urllib.error.URLError as e:
    print(e.read().decode('utf-8'))
