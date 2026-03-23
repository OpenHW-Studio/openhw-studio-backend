import {
  PROJECT_RUBRICS,
  SCORING_RULES,
  BONUS_RULES,
} from '../../config/gamification.js'

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

function toNumber(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback
}

function getCategoryFloor(weightedPoints) {
  const floor = clamp(weightedPoints, SCORING_RULES.categoryFloorMin, SCORING_RULES.categoryFloorMax)
  return Math.min(floor, weightedPoints)
}

export function computeProjectBaseXp({
  projectId,
  wiringScore = 0,
  pinScore = 0,
  codeScore = 0,
  isPartialPinCredit = false,
  analogExpected = null,
  analogActual = null,
}) {
  const rubric = PROJECT_RUBRICS[projectId]
  if (!rubric) {
    return {
      ok: false,
      error: `Unknown projectId '${projectId}'. Add it in PROJECT_RUBRICS.`,
    }
  }

  const wNorm = clamp(toNumber(wiringScore), 0, 100) / 100
  const pNormRaw = clamp(toNumber(pinScore), 0, 100)
  const cNorm = clamp(toNumber(codeScore), 0, 100) / 100

  const pNormAdjusted = isPartialPinCredit ? Math.max(pNormRaw, 50) : pNormRaw
  const pNorm = pNormAdjusted / 100

  const wWeighted = rubric.wiring * wNorm
  const pWeighted = rubric.pin * pNorm
  const cWeighted = rubric.code * cNorm

  const wFinal = Math.max(wWeighted, getCategoryFloor(rubric.wiring))
  const pFinal = Math.max(pWeighted, getCategoryFloor(rubric.pin))
  const cFinal = Math.max(cWeighted, getCategoryFloor(rubric.code))

  let analogToleranceBonus = 0
  if (rubric.analog && analogExpected !== null && analogActual !== null) {
    const expected = Number(analogExpected)
    const actual = Number(analogActual)
    if (Number.isFinite(expected) && Number.isFinite(actual) && expected !== 0) {
      const pctError = Math.abs((actual - expected) / expected) * 100
      if (pctError <= SCORING_RULES.analogTolerancePct) analogToleranceBonus = 5
    }
  }

  const baseXpRaw = wFinal + pFinal + cFinal + analogToleranceBonus
  const baseXp = Math.round(clamp(baseXpRaw, 0, rubric.base + 10))

  return {
    ok: true,
    rubric,
    breakdown: {
      wiring: Math.round(wFinal),
      pin: Math.round(pFinal),
      code: Math.round(cFinal),
      analogToleranceBonus,
    },
    baseXp,
  }
}

export function computeRetryDecay({ baseXp, attemptNo = 1 }) {
  const safeBase = Math.max(0, toNumber(baseXp))
  const safeAttempt = Math.max(1, Math.floor(toNumber(attemptNo, 1)))

  if (safeAttempt <= 1) return { decayPct: 0, xpAfterDecay: safeBase }

  const decayPct = (safeAttempt - 1) * SCORING_RULES.retryDecayPct
  const multiplier = Math.max(0, 1 - decayPct / 100)

  return {
    decayPct,
    xpAfterDecay: Math.round(safeBase * multiplier),
  }
}

export function computeBonuses({
  baseXp,
  requestedBonusKeys = [],
  challengeMeta = {},
}) {
  const safeBase = Math.max(0, toNumber(baseXp))
  const allBonusDetails = []

  for (const key of requestedBonusKeys) {
    if (key === BONUS_RULES.FIRST_ATTEMPT_ZERO_ERROR.key) {
      allBonusDetails.push({ key, xp: BONUS_RULES.FIRST_ATTEMPT_ZERO_ERROR.points })
      continue
    }

    if (key === BONUS_RULES.SILENT_RUN.key) {
      allBonusDetails.push({ key, xp: BONUS_RULES.SILENT_RUN.points })
      continue
    }

    if (key === BONUS_RULES.MODE_CLIMBER.key) {
      const similarity = Number(challengeMeta.astSimilarityPct ?? 0)
      const xp = similarity > BONUS_RULES.MODE_CLIMBER.plagiarismSimilarityPct
        ? BONUS_RULES.MODE_CLIMBER.plagiarismBonusFallback
        : BONUS_RULES.MODE_CLIMBER.points
      allBonusDetails.push({ key, xp })
      continue
    }

    if (key === BONUS_RULES.BLIND_BUILD.key) {
      allBonusDetails.push({ key, xp: BONUS_RULES.BLIND_BUILD.points })
      continue
    }

    if (key === BONUS_RULES.ONE_WIRE_LEFT.key) {
      allBonusDetails.push({ key, xp: BONUS_RULES.ONE_WIRE_LEFT.points })
      continue
    }

    if (key === BONUS_RULES.REVERSE_ENGINEERING.key) {
      allBonusDetails.push({ key, xp: BONUS_RULES.REVERSE_ENGINEERING.points })
      continue
    }

    if (key === BONUS_RULES.NOISE_INJECTION.key) {
      const tier = challengeMeta.noiseTier || 'basic'
      const tierXp = BONUS_RULES.NOISE_INJECTION.tiers[tier] ?? BONUS_RULES.NOISE_INJECTION.tiers.basic
      allBonusDetails.push({ key: `${key}:${tier}`, xp: tierXp })
      continue
    }

    if (key === BONUS_RULES.CONTRADICTION.key) {
      const firstTime = !!challengeMeta.isFirstContradictionForProject
      const multiplier = firstTime
        ? BONUS_RULES.CONTRADICTION.firstMultiplier
        : BONUS_RULES.CONTRADICTION.repeatMultiplier
      const xp = Math.round(safeBase * multiplier)
      allBonusDetails.push({ key, xp })
      continue
    }
  }

  const selected = allBonusDetails
    .sort((a, b) => b.xp - a.xp)
    .slice(0, SCORING_RULES.maxBonusStackPerAttempt)

  const totalBonusXp = selected.reduce((sum, b) => sum + b.xp, 0)

  return {
    selectedBonuses: selected,
    totalBonusXp,
  }
}

export function applyPenalties({ xpBeforePenalty, penalties = [] }) {
  let xp = Math.max(0, toNumber(xpBeforePenalty))
  const applied = []

  for (const p of penalties) {
    const points = Math.max(0, toNumber(p.points))
    if (!points) continue
    xp = Math.max(0, xp - points)
    applied.push({ key: p.key || 'unknown-penalty', points })
  }

  return {
    xpAfterPenalty: xp,
    penaltiesApplied: applied,
  }
}

export function computeFinalProjectXp(payload) {
  const base = computeProjectBaseXp(payload)
  if (!base.ok) return base

  const attemptNo = payload.attemptNo || 1
  const retry = computeRetryDecay({ baseXp: base.baseXp, attemptNo })

  const bonus = computeBonuses({
    baseXp: retry.xpAfterDecay,
    requestedBonusKeys: payload.requestedBonusKeys || [],
    challengeMeta: payload.challengeMeta || {},
  })

  const withBonus = retry.xpAfterDecay + bonus.totalBonusXp

  const penalty = applyPenalties({
    xpBeforePenalty: withBonus,
    penalties: payload.penalties || [],
  })

  return {
    ok: true,
    rubric: base.rubric,
    breakdown: base.breakdown,
    attemptNo,
    retryDecayPct: retry.decayPct,
    baseXp: base.baseXp,
    xpAfterRetry: retry.xpAfterDecay,
    bonusesApplied: bonus.selectedBonuses,
    totalBonusXp: bonus.totalBonusXp,
    penaltiesApplied: penalty.penaltiesApplied,
    finalXp: penalty.xpAfterPenalty,
  }
}