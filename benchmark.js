import fetch from 'node-fetch';
import { performance } from 'perf_hooks';

const API_URL = process.argv[2] || 'http://localhost:5001/api/compile';
const ITERATIONS = 5;

const payload = {
  code: "void setup() { pinMode(13, OUTPUT); } void loop() { digitalWrite(13, HIGH); delay(1000); digitalWrite(13, LOW); delay(1000); }",
  fqbn: "arduino:avr:uno",
  sketchName: "blink_benchmark",
  builder: "arduino-cli",
  files: []
};

async function runBenchmark() {
  console.log(`Benchmarking ${API_URL}...`);
  console.log(`Running ${ITERATIONS} iterations...`);
  
  const times = [];
  
  for (let i = 0; i < ITERATIONS; i++) {
    payload.sketchName = `blink_benchmark_${i}_${Date.now()}`;
    payload.code = `void setup() { pinMode(13, OUTPUT); } void loop() { digitalWrite(13, HIGH); delay(${1000 + i}); digitalWrite(13, LOW); delay(1000); }`;
    
    const start = performance.now();
    
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const data = await response.json();
      const end = performance.now();
      
      if (response.ok && !data.error) {
        const duration = end - start;
        times.push(duration);
        console.log(`Iteration ${i + 1}: ${duration.toFixed(2)} ms`);
      } else {
        console.error(`Iteration ${i + 1} failed:`, data.error || data);
      }
    } catch (err) {
      console.error(`Iteration ${i + 1} error:`, err.message);
    }
  }
  
  if (times.length > 0) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`\nAverage Compile Time: ${avg.toFixed(2)} ms`);
  } else {
    console.log('\nNo successful iterations to average.');
  }
}

runBenchmark();
