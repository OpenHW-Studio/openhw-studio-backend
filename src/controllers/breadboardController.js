import { simulateBreadboard } from '../../../openhw-studio-emulator/src/breadboard/engine.js';

function normalizeInputs(inputs) {
  if (Array.isArray(inputs)) {
    return inputs;
  }
  if (!inputs || typeof inputs !== 'object') {
    return [];
  }
  return Object.entries(inputs).map(([hole, value], index) => ({
    id: `in-${index + 1}`,
    hole,
    value: value ? 1 : 0,
  }));
}

function normalizeLeds(leds) {
  if (!Array.isArray(leds)) {
    return [];
  }
  if (leds.every((led) => typeof led === 'string')) {
    return leds.map((hole, index) => ({
      id: `led-${index + 1}`,
      hole,
    }));
  }
  return leds;
}

function normalizeGates(gates) {
  if (!Array.isArray(gates)) {
    return [];
  }
  return gates.map((gate) => {
    if (!gate || typeof gate !== 'object') {
      return gate;
    }
    if ('inA' in gate || 'out' in gate) {
      return gate;
    }
    const pins = gate.pins && typeof gate.pins === 'object' ? gate.pins : {};
    return {
      type: gate.type,
      inA: pins.inA ?? pins.in,
      inB: pins.inB,
      out: pins.out,
    };
  });
}

function normalizePower(power) {
  const source = power && typeof power === 'object' ? power : {};
  return {
    vcc: Array.isArray(source.vcc) ? source.vcc : [],
    gnd: Array.isArray(source.gnd) ? source.gnd : [],
  };
}

function normalizePayload(body) {
  const payload = body && typeof body === 'object' ? body : {};
  return {
    wires: Array.isArray(payload.wires) ? payload.wires : [],
    inputs: normalizeInputs(payload.inputs),
    leds: normalizeLeds(payload.leds),
    gates: normalizeGates(payload.gates),
    power: normalizePower(payload.power),
  };
}

export function simulateBreadboardController(req, res) {
  try {
    const normalizedPayload = normalizePayload(req.body);
    const result = simulateBreadboard(normalizedPayload);
    const ledsOn = Array.isArray(result.ledStates)
      ? result.ledStates.filter((led) => led.on).map((led) => led.hole)
      : [];
    return res.json({
      ...result,
      ledsOn,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      errors: [error.message || 'Breadboard simulation failed'],
    });
  }
}
