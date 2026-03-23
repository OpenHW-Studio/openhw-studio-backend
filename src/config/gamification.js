export const LEVEL_BANDS = [
  { level: 1, minXp: 0, maxXp: 300 },
  { level: 2, minXp: 301, maxXp: 700 },
  { level: 3, minXp: 701, maxXp: 1300 },
  { level: 4, minXp: 1301, maxXp: 2000 },
  { level: 5, minXp: 2001, maxXp: Number.MAX_SAFE_INTEGER },
]

export const PROJECT_RUBRICS = {
  'led-blink':        { base: 100, wiring: 20, pin: 30, code: 50, analog: false },
  'rgb-led':          { base: 100, wiring: 35, pin: 45, code: 20, analog: false },
  'buzzer':           { base: 100, wiring: 20, pin: 25, code: 55, analog: false },
  'button-debounce':  { base: 100, wiring: 40, pin: 15, code: 45, analog: false },
  'ldr-sensor':       { base: 100, wiring: 45, pin: 20, code: 35, analog: true },
  'temperature-sensor': { base: 100, wiring: 15, pin: 50, code: 35, analog: true },
  'dc-motor-l298n':   { base: 100, wiring: 55, pin: 15, code: 30, analog: false },
  'servo-motor':      { base: 100, wiring: 20, pin: 30, code: 50, analog: false },
  'led-strip':        { base: 100, wiring: 30, pin: 30, code: 40, analog: false },
  'potentiometer':    { base: 100, wiring: 20, pin: 40, code: 40, analog: true },
  'esp32-wifi-led':   { base: 100, wiring: 15, pin: 20, code: 65, analog: false },
  'esp32-pwm-motor':  { base: 100, wiring: 30, pin: 15, code: 55, analog: false },
  'esp32-sensor-log': { base: 100, wiring: 20, pin: 25, code: 55, analog: true },
}

export const SCORING_RULES = {
  categoryFloorMin: 10,     // floor band lower bound
  categoryFloorMax: 15,     // floor band upper bound
  analogTolerancePct: 5,    // ±5%
  retryDecayPct: 10,        // per retry attempt
  maxBonusStackPerAttempt: 2,
  streakBonuses: { day3: 10, day7: 20 },
}

export const BONUS_RULES = {
  FIRST_ATTEMPT_ZERO_ERROR: { key: 'first-attempt-zero-error', points: 20 },
  SILENT_RUN:               { key: 'silent-run', points: 15 },
  MODE_CLIMBER:             { key: 'mode-climber', points: 25, minAstDiffPct: 30, plagiarismSimilarityPct: 80, plagiarismBonusFallback: 5 },
  BLIND_BUILD:              { key: 'blind-build', points: 30 },
  ONE_WIRE_LEFT:            { key: 'one-wire-left', points: 25 },
  REVERSE_ENGINEERING:      { key: 'reverse-engineering', points: 50 },
  NOISE_INJECTION:          { key: 'noise-injection', tiers: { basic: 15, drift: 35, cascaded: 50 } },
  CONTRADICTION:            { key: 'contradiction', firstMultiplier: 2.0, repeatMultiplier: 1.5, flatFallback: 40 },
}

export const SPEND_OPTIONS = {
  ERROR_TYPE_REVEAL:     { key: 'error-type-reveal', cost: 10, unlockLevel: 1 },
  COMPONENT_WHISPER:     { key: 'component-whisper', cost: 15, unlockLevel: 1 },
  WRONG_WIRE_HIGHLIGHT:  { key: 'wrong-wire-highlight', cost: 15, unlockLevel: 1 },
  PIN_CATEGORY_HINT:     { key: 'pin-category-hint', cost: 20, unlockLevel: 1 },
  WHAT_IF_PROBE:         { key: 'what-if-probe', cost: 20, unlockLevel: 2 },
  X_RAY_VISION:          { key: 'x-ray-vision', cost: 25, unlockLevel: 2 },
  SERIAL_MONITOR_GHOST:  { key: 'serial-monitor-ghost', cost: 25, unlockLevel: 2, throttlePerProjectPerDay: 1 },
  BLOCK_MODE_BRIDGE:     { key: 'block-mode-bridge', cost: 30, unlockLevel: 2 },
  CIRCUIT_TIME_MACHINE:  { key: 'circuit-time-machine', cost: 30, unlockLevel: 2 },
  SIGNAL_INJECT:         { key: 'signal-inject', cost: 30, unlockLevel: 3, masteryGate: { code: 60 } },
  EARLY_COMPONENT_UNLOCK:{ key: 'early-component-unlock', cost: 60, unlockLevel: 2 },
  DEAD_ZONE_CHALLENGE:   { key: 'dead-zone-challenge', cost: 40, unlockLevel: 3 },
  DIAGNOSIS_PACK:        { key: 'diagnosis-pack', cost: 20, unlockLevel: 1, oneTimePerProject: true },
}

export const ECONOMY_RULES = {
  softDailySpendCount: 3,
  softDailySurcharge: 10,
  refundOnLearnPct: 30,
  refundWindowSeconds: 120,
  examModeMultiplier: 2.0,
  practiceModeDiscountPct: 20,
}