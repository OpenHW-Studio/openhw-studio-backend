import mongoose from 'mongoose';
import dotenv from 'dotenv';
import AdventureMap from '../models/AdventureMap.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/openhw-studio';

const OFFICIAL_MAPS = [
  {
    title: 'Arduino Uno Odyssey',
    slug: 'arduino',
    description: 'Master core electronics, sensor interfacing, actuators, and signal protocols on the classic 8-bit AVR RISC architecture.',
    board: 'arduino-uno',
    chipArchitecture: '8-BIT AVR RISC',
    campaignCode: 'AVR-01',
    badgeColor: '#10b981',
    creatorId: new mongoose.Types.ObjectId('000000000000000000000001'),
    creatorName: 'OpenHW Studio Core',
    isOfficial: true,
    isPublic: true,
    status: 'published',
    playCount: 1540,
    tags: ['arduino', 'basics', 'circuits', 'sensors', 'actuators'],
    certification: {
      enabled: true,
      title: 'Certified Embedded Systems Specialist — Arduino Architecture',
      issuerName: 'OpenHW Studio Engineering Council',
      description: 'Awarded upon mastering foundational circuitry, PWM modulation, sensor conditioning, and multi-component bus protocols.',
      accentColor: '#10b981',
      badgeIcon: 'Award'
    },
    islands: [
      {
        id: 1,
        name: 'Circuit Basics',
        theme: 'Beginner',
        color: '#22c55e',
        islandImage: '/gamification_images/island_led.png',
        missions: [
          { id: 'm1', slug: 'led-blink', title: 'LED Blink', subtitle: 'Hello World of Electronics', difficulty: 'beginner', xpReward: 100, islandImage: '/gamification_images/island_led.png' },
          { id: 'm2', slug: 'rgb-led', title: 'RGB LED', subtitle: 'Color Mixing & PWM', difficulty: 'beginner', xpReward: 120, islandImage: '/gamification_images/island_rgb.png' },
          { id: 'm3', slug: 'buzzer', title: 'Piezo Buzzer', subtitle: 'Generating Frequencies', difficulty: 'beginner', xpReward: 120, islandImage: '/gamification_images/island_buzzer.png' },
          { id: 'm4', slug: 'potentiometer', title: 'Potentiometer', subtitle: 'Analog Voltage Division', difficulty: 'beginner', xpReward: 130, islandImage: '/gamification_images/island_potentiometer.png' },
          { id: 'm5', slug: 'ldr', title: 'Light Sensor (LDR)', subtitle: 'Photoresistor Sensing', difficulty: 'beginner', xpReward: 140, islandImage: '/gamification_images/island_ldr.png' }
        ]
      },
      {
        id: 2,
        name: 'Signal Control',
        theme: 'Intermediate',
        color: '#3b82f6',
        islandImage: '/gamification_images/island_servo.png',
        missions: [
          { id: 'm6', slug: 'servo-motor', title: 'Servo Motor', subtitle: 'Precision PPM Angles', difficulty: 'intermediate', xpReward: 150, islandImage: '/gamification_images/island_servo.png' },
          { id: 'm7', slug: 'led-strip', title: 'Addressable LED Strip', subtitle: 'NeoPixel Protocol', difficulty: 'intermediate', xpReward: 160, islandImage: '/gamification_images/island_led_strip.png' },
          { id: 'm8', slug: 'button-debounce', title: 'Button Debounce', subtitle: 'Mechanical Switch Logic', difficulty: 'intermediate', xpReward: 150, islandImage: '/gamification_images/island_button.png' },
          { id: 'm9', slug: 'temperature-sensor', title: 'Temperature Sensor', subtitle: 'Analog Calibration', difficulty: 'intermediate', xpReward: 170, islandImage: '/gamification_images/island_temperature.png' }
        ]
      },
      {
        id: 3,
        name: 'Machines & Sensors',
        theme: 'Advanced',
        color: '#f97316',
        islandImage: '/gamification_images/island_dc_motor.png',
        missions: [
          { id: 'm10', slug: 'dc-motor', title: 'DC Motor & Driver', subtitle: 'H-Bridge Driving', difficulty: 'advanced', xpReward: 200, islandImage: '/gamification_images/island_dc_motor.png' }
        ]
      },
      {
        id: 4,
        name: 'Smart Sensing',
        theme: 'Expert',
        color: '#14b8a6',
        islandImage: '/gamification_images/island_ultrasonic.png',
        missions: [
          { id: 'm11', slug: 'push-button', title: 'Interrupt Button', subtitle: 'External Vector Interrupts', difficulty: 'advanced', xpReward: 180, islandImage: '/gamification_images/island_button.png' },
          { id: 'm12', slug: 'ultrasonic-sensor', title: 'Ultrasonic Ranger', subtitle: 'Time-of-Flight Physics', difficulty: 'advanced', xpReward: 190, islandImage: '/gamification_images/island_ultrasonic.png' },
          { id: 'm13', slug: 'dht11-sensor', title: 'DHT11 Temp & Humidity', subtitle: '1-Wire Digital Signal', difficulty: 'advanced', xpReward: 210, islandImage: '/gamification_images/island_dht11.png' },
          { id: 'm14', slug: 'lcd-display', title: '16x2 LCD Display', subtitle: '4-Bit Parallel Bus', difficulty: 'advanced', xpReward: 220, islandImage: '/gamification_images/island_lcd.png' }
        ]
      },
      {
        id: 5,
        name: 'Advanced Components',
        theme: 'Master',
        color: '#ec4899',
        islandImage: '/gamification_images/island_relay.png',
        missions: [
          { id: 'm15', slug: 'relay-control', title: 'Relay Module', subtitle: 'Galvanic High Voltage Control', difficulty: 'expert', xpReward: 220, islandImage: '/gamification_images/island_relay.png' },
          { id: 'm16', slug: 'oled-graphics', title: 'I2C OLED Graphics', subtitle: 'SSD1306 Framebuffers', difficulty: 'expert', xpReward: 240, islandImage: '/gamification_images/island_oled.png' },
          { id: 'm17', slug: 'neopixel-effects', title: 'NeoPixel Animations', subtitle: 'Fast Color Physics', difficulty: 'expert', xpReward: 250, islandImage: '/gamification_images/island_led_strip.png' },
          { id: 'm18', slug: 'keypad-lock', title: '4x4 Matrix Keypad', subtitle: 'Row-Column Scanning', difficulty: 'expert', xpReward: 230, islandImage: '/gamification_images/island_keypad.png' },
          { id: 'm19', slug: 'rotary-menu', title: 'Rotary Quadrature', subtitle: '2-Phase State Decoding', difficulty: 'expert', xpReward: 250, islandImage: '/gamification_images/island_potentiometer.png' },
          { id: 'm20', slug: 'seven-segment-clock', title: '7-Segment Display', subtitle: 'Multiplexed Digits', difficulty: 'expert', xpReward: 240, islandImage: '/gamification_images/island_seven_segment.png' },
          { id: 'm21', slug: 'stepper-motor', title: 'Bipolar Stepper', subtitle: '4-Phase Sequencing', difficulty: 'expert', xpReward: 260, islandImage: '/gamification_images/island_stepper.png' },
          { id: 'm22', slug: 'mpu6050-tilt', title: '6-DOF MPU6050 IMU', subtitle: 'Gyroscope & Accelerometer', difficulty: 'expert', xpReward: 280, islandImage: '/gamification_images/island_mpu6050.png' }
        ]
      }
    ]
  },
  {
    title: 'ESP32 Connected IoT Explorer',
    slug: 'esp32',
    description: 'Build connected microcontrollers, MQTT telemetric links, web dashboards, and BLE peripherals using the dual-core 32-bit Xtensa architecture.',
    board: 'esp32',
    chipArchitecture: '32-BIT XTENSA DUAL-CORE',
    campaignCode: 'XT-D32',
    badgeColor: '#f59e0b',
    creatorId: new mongoose.Types.ObjectId('000000000000000000000001'),
    creatorName: 'OpenHW Studio Core',
    isOfficial: true,
    isPublic: true,
    status: 'published',
    playCount: 1120,
    tags: ['esp32', 'wifi', 'iot', 'mqtt', 'ble'],
    certification: {
      enabled: true,
      title: 'Certified Embedded IoT Engineer — ESP32 Architecture',
      issuerName: 'OpenHW Studio Engineering Council',
      description: 'Awarded upon mastering wireless telemetry, asynchronous web servers, low-power sleep modes, and MQTT cloud sync.',
      accentColor: '#f59e0b',
      badgeIcon: 'Award'
    },
    islands: [
      {
        id: 1,
        name: 'ESP32 Basics',
        theme: 'Easy',
        color: '#22c55e',
        islandImage: '/gamification_images/island_esp32.png',
        missions: [
          { id: 'e1', slug: 'esp32-blink', title: 'Dual-Core Blink', subtitle: 'FreeRTOS Pin Toggling', difficulty: 'beginner', xpReward: 100, islandImage: '/gamification_images/island_esp32.png' },
          { id: 'e2', slug: 'esp32-analog', title: 'ADC Precision', subtitle: '12-bit Analog Reading', difficulty: 'beginner', xpReward: 120, islandImage: '/gamification_images/island_potentiometer.png' },
          { id: 'e3', slug: 'esp32-pwm', title: 'LED Control (LEDC)', subtitle: 'Hardware Timer PWM', difficulty: 'beginner', xpReward: 130, islandImage: '/gamification_images/island_led.png' }
        ]
      },
      {
        id: 2,
        name: 'ESP32 IoT & WiFi',
        theme: 'Intermediate',
        color: '#3b82f6',
        islandImage: '/gamification_images/island_wifi.png',
        missions: [
          { id: 'e4', slug: 'esp32-wifi-scan', title: 'WiFi Network Scanner', subtitle: '802.11b/g/n Probing', difficulty: 'intermediate', xpReward: 160, islandImage: '/gamification_images/island_wifi.png' },
          { id: 'e5', slug: 'esp32-web-server', title: 'Local Web Server', subtitle: 'HTTP RESTful Dashboard', difficulty: 'intermediate', xpReward: 200, islandImage: '/gamification_images/island_wifi.png' },
          { id: 'e6', slug: 'esp32-http-client', title: 'REST API Requester', subtitle: 'JSON Cloud Ingestion', difficulty: 'intermediate', xpReward: 190, islandImage: '/gamification_images/island_wifi.png' }
        ]
      },
      {
        id: 3,
        name: 'Advanced ESP32',
        theme: 'Hard',
        color: '#f97316',
        islandImage: '/gamification_images/island_mqtt.png',
        missions: [
          { id: 'e7', slug: 'esp32-mqtt', title: 'MQTT Telemetry Broker', subtitle: 'Publish/Subscribe QoS', difficulty: 'advanced', xpReward: 220, islandImage: '/gamification_images/island_mqtt.png' },
          { id: 'e8', slug: 'esp32-ble', title: 'Bluetooth Low Energy', subtitle: 'GATT Server & Characteristics', difficulty: 'advanced', xpReward: 230, islandImage: '/gamification_images/island_ble.png' },
          { id: 'e9', slug: 'esp32-deep-sleep', title: 'ULP Deep Sleep Modes', subtitle: 'Sub-15μA Power Optimization', difficulty: 'advanced', xpReward: 250, islandImage: '/gamification_images/island_deep_sleep.png' }
        ]
      },
      {
        id: 4,
        name: 'IoT Applications',
        theme: 'Expert',
        color: '#a855f7',
        islandImage: '/gamification_images/island_cloud.png',
        missions: [
          { id: 'e10', slug: 'esp32-oled-wifi', title: 'Cloud Weather Display', subtitle: 'Live IoT OLED Feed', difficulty: 'expert', xpReward: 260, islandImage: '/gamification_images/island_oled.png' },
          { id: 'e11', slug: 'esp32-sensor-cloud', title: 'Multi-Sensor Cloud Sync', subtitle: 'Datastream Aggregator', difficulty: 'expert', xpReward: 280, islandImage: '/gamification_images/island_cloud.png' },
          { id: 'e12', slug: 'esp32-cam-stream', title: 'ESP32 Camera Streamer', subtitle: 'MJPEG Video Pipeline', difficulty: 'expert', xpReward: 300, islandImage: '/gamification_images/island_camera.png' }
        ]
      }
    ]
  }
];

async function seed() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB:', MONGO_URI);

    for (const mapData of OFFICIAL_MAPS) {
      const existing = await AdventureMap.findOne({ slug: mapData.slug });
      if (!existing) {
        await AdventureMap.create(mapData);
        console.log(`Seeded official adventure map: ${mapData.title}`);
      } else {
        console.log(`Adventure map already exists: ${mapData.slug}`);
      }
    }

    console.log('Seeding finished successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Seeding error:', err);
    process.exit(1);
  }
}

seed();
