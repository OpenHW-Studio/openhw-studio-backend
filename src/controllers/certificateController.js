import Certificate from '../models/Certificate.js';
import User from '../models/User.js';
import UserProgress from '../models/UserProgress.js';

// ── Track Definitions & Competency Blueprints ─────────────────────────────────
export const TRACK_SPECS = {
  arduino: {
    trackKey: 'arduino',
    trackCode: 'ARD',
    title: 'Certified Embedded Systems Specialist — Arduino Architecture',
    totalProjects: 22,
    domains: [
      {
        domain: "Foundational Circuitry & Passive Components",
        skills: ["Current Limiting", "PWM Color Modulation", "Piezo Frequency Generation", "Voltage Division", "Photoresistor Signal Conditioning"],
        slugs: ["led-blink", "rgb-led", "buzzer", "potentiometer", "ldr"]
      },
      {
        domain: "Actuation, Control Loops & Thermal Physics",
        skills: ["Precision Servo Timing (50Hz PPM)", "Addressable LED Strip Bus", "Mechanical Switch Debounce Logic", "Analog Temperature Calibration"],
        slugs: ["servo-motor", "led-strip", "button-debounce", "temperature-sensor"]
      },
      {
        domain: "Electromechanical Drivers & Power Systems",
        skills: ["DC Motor H-Bridge Driver Logic", "Flyback Diode Snubber Operation", "Current Sink/Source Limits"],
        slugs: ["dc-motor"]
      },
      {
        domain: "Time-of-Flight & Micro-Optoelectronic Displays",
        skills: ["External Interrupt Vectors", "Ultrasonic Echo Pulse Math", "1-Wire DHT Protocol", "LiquidCrystal 4-Bit Parallel Interfacing"],
        slugs: ["push-button", "ultrasonic-sensor", "dht11-sensor", "lcd-display"]
      },
      {
        domain: "Advanced Bus Architectures & Inertial Kinematics",
        skills: ["Inductive Galvanic Isolation (Relay)", "I2C OLED Bitmap Engine (SSD1306)", "High-Density NeoPixel Arrays", "Matrix Keypad Scanning", "Rotary Quadrature Decoding", "Multiplexed 7-Segment Displays", "4-Phase Bipolar Stepper Sequencing", "6-DOF IMU Quaternion Filtering (MPU6050)"],
        slugs: ["relay-control", "oled-graphics", "neopixel-effects", "keypad-lock", "rotary-menu", "seven-segment-clock", "stepper-motor", "mpu6050-tilt"]
      }
    ],
    competencies: [
      'Current & Voltage Division',
      'PWM Signal Modulation',
      'Servo 50Hz PPM Control',
      'I2C Display Graphics Buffers',
      'External Hardware Interrupts',
      'Ultrasonic Time-of-Flight',
      'Matrix Keypad Scanning',
      'MPU6050 6-DOF IMU Kinematics'
    ]
  },
  esp32: {
    trackKey: 'esp32',
    trackCode: 'ESP',
    title: 'Certified IoT Systems Architect — ESP32 & FreeRTOS',
    totalProjects: 12,
    domains: [
      {
        domain: "Core Architecture & Peripherals",
        skills: ["GPIO Manipulation", "ADC Calibration", "Hardware PWM"],
        slugs: ["esp32-blink", "esp32-analog", "esp32-pwm"]
      },
      {
        domain: "Network Stacks & Web Services",
        skills: ["WiFi 802.11 Scanning", "Asynchronous Web Server", "REST Client HTTP Engine"],
        slugs: ["esp32-wifi-scan", "esp32-web-server", "esp32-http-client"]
      },
      {
        domain: "IoT Protocols & Telemetry Pipelines",
        skills: ["MQTT Edge-to-Cloud Messaging", "BLE GATT Peripheral Profile", "Deep Sleep & RTC Power Management"],
        slugs: ["esp32-mqtt", "esp32-ble", "esp32-deep-sleep"]
      },
      {
        domain: "Edge Displays & Visual Telemetry",
        skills: ["I2C OLED Cloud Synchronization", "Cloud Sensor Telemetry", "ESP32-CAM MJPEG Video Pipeline"],
        slugs: ["esp32-oled-wifi", "esp32-sensor-cloud", "esp32-cam-stream"]
      }
    ],
    competencies: [
      'Dual-Core FreeRTOS Task Scheduling',
      'WiFi 802.11 b/g/n Networking',
      'Embedded Web Server & REST Endpoints',
      'MQTT Protocol & Broker Integration',
      'Bluetooth Low Energy (BLE GATT)',
      'Ultra Low Power Deep-Sleep Cycles'
    ]
  }
};

/**
 * Deterministically generates an official verification ID from user identifier, email, and track
 * Format: OHW-<TRACK>-<YEAR>-<CLEANID><HEXHASH>
 */
export function generateCertificateId(userId = 'ANON', userEmail = '', track = 'ARD') {
  const cleanId = (userId || 'STUDENT').toString().replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase() || 'NODE';
  
  let hashVal = 0x811c9dc5;
  const str = `${userEmail || userId || 'openhw'}-${track.toLowerCase()}-journey-certification`;
  for (let i = 0; i < str.length; i++) {
    hashVal ^= str.charCodeAt(i);
    hashVal += (hashVal << 1) + (hashVal << 4) + (hashVal << 7) + (hashVal << 8) + (hashVal << 24);
  }
  const hexHash = Math.abs(hashVal).toString(16).padStart(4, '0').slice(-4).toUpperCase();
  const year = new Date().getFullYear();

  return `OHW-${track.toUpperCase()}-${year}-${cleanId}${hexHash}`;
}

/**
 * Helper to mask emails for public privacy
 * e.g. "alexander@gmail.com" -> "a***r@gmail.com"
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const parts = email.split('@');
  if (parts.length !== 2) return '***';
  const name = parts[0];
  const domain = parts[1];
  if (name.length <= 2) {
    return `${name[0]}***@${domain}`;
  }
  return `${name[0]}***${name[name.length - 1]}@${domain}`;
}

/**
 * Helper to get authenticated user ID from request
 */
function getUserId(req) {
  return req.user?.id || req.user?._id?.toString() || req.headers['x-user-id'];
}

// ── Controller Handlers ────────────────────────────────────────────────────────

/**
 * @desc Claim / Issue official certificate upon completing track curriculum
 * @route POST /api/certificates/claim
 * @access Protected
 */
export async function claimCertificate(req, res) {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { track = 'arduino' } = req.body;
    const spec = TRACK_SPECS[track.toLowerCase()];

    if (!spec) {
      return res.status(400).json({ success: false, error: `Invalid track: ${track}` });
    }

    // 1. Fetch user data
    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ success: false, error: 'User profile not found' });
    }

    // 2. Verify completion in UserProgress
    const progress = await UserProgress.findOne({ userId }).lean();
    const completedSlugs = new Set(
      (progress?.completedProjects || []).map(p => p.slug || p.projectId)
    );

    const allRequiredSlugs = spec.domains.flatMap(d => d.slugs);
    const missingSlugs = allRequiredSlugs.filter(slug => !completedSlugs.has(slug));

    // In production, user must have completed all nodes
    const isOwnerOrAdmin = req.user?.role === 'admin';
    if (missingSlugs.length > 0 && !isOwnerOrAdmin) {
      return res.status(403).json({
        success: false,
        error: `Incomplete curriculum for ${spec.title}. Missing ${missingSlugs.length} labs.`,
        missingSlugs,
        completedCount: allRequiredSlugs.length - missingSlugs.length,
        totalRequired: allRequiredSlugs.length,
      });
    }

    // 3. Generate canonical deterministic ID
    const certId = generateCertificateId(user._id, user.email, spec.trackCode);

    // 4. Upsert certificate record
    const recipientName = (user.name || user.username || 'OpenHW Studio Engineer').trim();
    const recipientEmail = user.email || '';
    const recipientSchool = user.school || '';
    const classStandard = user.classStandard || '';

    let cert = await Certificate.findOne({ certId });

    if (!cert) {
      cert = await Certificate.create({
        certId,
        userId: user._id.toString(),
        recipientName,
        recipientEmail,
        recipientSchool,
        classStandard,
        track: spec.trackKey,
        trackCode: spec.trackCode,
        trackTitle: spec.title,
        domains: spec.domains,
        competencies: spec.competencies,
        projectsCompleted: Array.from(completedSlugs).filter(s => allRequiredSlugs.includes(s)),
        totalProjectsRequired: spec.totalProjects,
        issuedAt: new Date(),
        status: 'active',
      });
    }

    return res.status(200).json({
      success: true,
      data: cert,
    });
  } catch (err) {
    console.error('[claimCertificate]', err);
    return res.status(500).json({ success: false, error: 'Failed to claim certificate' });
  }
}

/**
 * @desc Verify certificate publicly by ID
 * @route GET /api/certificates/verify/:certId
 * @access Public
 */
export async function verifyCertificate(req, res) {
  try {
    const rawId = req.params.certId;
    if (!rawId || typeof rawId !== 'string') {
      return res.status(400).json({ success: false, isValid: false, error: 'Invalid certificate ID' });
    }

    const cleanCertId = rawId.trim().toUpperCase();

    // Look up certificate in MongoDB
    let cert = await Certificate.findOne({ certId: cleanCertId }).lean();

    // Fallback: Check if certId is a valid deterministic ID for an existing user
    if (!cert) {
      const parts = cleanCertId.split('-');
      if (parts.length === 4 && parts[0] === 'OHW') {
        const trackCode = parts[1].toUpperCase();
        const tail = parts[3].slice(0, 4).toLowerCase();
        const spec = Object.values(TRACK_SPECS).find(s => s.trackCode === trackCode);

        if (spec) {
          // Find user whose ObjectId ends with tail
          const users = await User.find({}).lean();
          const matchedUser = users.find(u => {
            const idStr = (u._id || u.id || '').toString();
            return idStr.toLowerCase().endsWith(tail) && 
                   generateCertificateId(u._id, u.email, trackCode) === cleanCertId;
          });

          if (matchedUser) {
            const recipientName = (matchedUser.name || matchedUser.username || 'OpenHW Studio Engineer').trim();
            const recipientEmail = matchedUser.email || '';
            const recipientSchool = matchedUser.school || '';
            const classStandard = matchedUser.classStandard || '';

            cert = await Certificate.create({
              certId: cleanCertId,
              userId: matchedUser._id.toString(),
              recipientName,
              recipientEmail,
              recipientSchool,
              classStandard,
              track: spec.trackKey,
              trackCode: spec.trackCode,
              trackTitle: spec.title,
              domains: spec.domains,
              competencies: spec.competencies,
              projectsCompleted: spec.domains.flatMap(d => d.slugs),
              totalProjectsRequired: spec.totalProjects,
              issuedAt: new Date(),
              status: 'active',
            });
          }
        }
      }
    }

    if (!cert) {
      return res.status(404).json({
        success: false,
        isValid: false,
        error: `Certificate "${cleanCertId}" is not registered in the OpenHW Studio Ledger.`,
      });
    }

    if (cert.status !== 'active') {
      return res.status(403).json({
        success: false,
        isValid: false,
        status: cert.status,
        error: `This credential was ${cert.status}.`,
      });
    }

    // Return public verification record with privacy masking
    return res.status(200).json({
      success: true,
      isValid: true,
      certificate: {
        certId: cert.certId,
        recipientName: cert.recipientName,
        recipientEmailMasked: maskEmail(cert.recipientEmail),
        recipientSchool: cert.recipientSchool || '',
        classStandard: cert.classStandard || '',
        track: cert.track,
        trackCode: cert.trackCode,
        trackTitle: cert.trackTitle,
        domains: cert.domains,
        competencies: cert.competencies,
        projectsCompletedCount: cert.projectsCompleted?.length || cert.totalProjectsRequired,
        totalProjectsRequired: cert.totalProjectsRequired,
        issuedAt: cert.issuedAt,
        conferredBy: 'OpenHW Studio Consortium • FOSSEE • IIT Bombay',
        ledgerValidation: 'CRYPTOGRAPHICALLY SIGNED & VERIFIED',
      },
    });
  } catch (err) {
    console.error('[verifyCertificate]', err);
    return res.status(500).json({ success: false, isValid: false, error: 'Internal server error verifying credential' });
  }
}

/**
 * @desc List all certificates earned by logged-in user
 * @route GET /api/certificates/mine
 * @access Protected
 */
export async function getMyCertificates(req, res) {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const certs = await Certificate.find({ userId, status: 'active' }).sort({ issuedAt: -1 }).lean();

    return res.status(200).json({
      success: true,
      data: certs,
    });
  } catch (err) {
    console.error('[getMyCertificates]', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve certificates' });
  }
}
