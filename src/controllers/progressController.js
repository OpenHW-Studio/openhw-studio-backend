
import UserProgress from '../models/UserProgress.js'
import { computeFinalProjectXp } from '../utils/helper/gamificationScoring.js'
import {
  SPEND_OPTIONS,
  ECONOMY_RULES,
  BONUS_RULES,
  LEVEL_BANDS,
  PROJECT_RUBRICS,
  SCORING_RULES,
} from '../config/gamification.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getUserId(req) {
  return req.user?.id || req.headers['x-user-id'] || 'anonymous'
}

function sendError(res, status, message) {
  return res.status(status).json({ success: false, error: message })
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
}

function getSpendOptionByKey(optionKey) {
  return Object.values(SPEND_OPTIONS).find(opt => opt.key === optionKey) || null
}

export async function getProgress(req, res) {
  try {
    const userId = getUserId(req)
    const progress = await UserProgress.findOrCreate(userId)

    return res.json({
      success: true,
      data: {
        userId:               progress.userId,
        xp:                   progress.xp,
        coins:                progress.coins,
        level:                progress.level,
        unlockedComponents:   progress.unlockedComponents,
        completedProjects:    progress.completedProjects,
        earnedBadges:         progress.earnedBadges,
        quizAttempts:         progress.quizAttempts,
        currentStreak:        progress.currentStreak,
        longestStreak:        progress.longestStreak,
        lastActiveDate:       progress.lastActiveDate,
        createdAt:            progress.createdAt,
        updatedAt:            progress.updatedAt,
      },
    })
  } catch (err) {
    console.error('[getProgress]', err)
    return sendError(res, 500, 'Failed to fetch progress')
  }
}

export async function recordQuiz(req, res) {
  try {
    const userId = getUserId(req)
    const { componentId, score, passed } = req.body

    if (!componentId || score === undefined || passed === undefined) {
      return sendError(res, 400, 'componentId, score, and passed are required')
    }
    if (typeof score !== 'number' || score < 0 || score > 100) {
      return sendError(res, 400, 'score must be a number between 0 and 100')
    }

    const progress = await UserProgress.findOrCreate(userId)
    progress.recordQuizAttempt({ componentId, score, passed })
    progress.updateStreak()
    await progress.save()

    return res.json({
      success: true,
      data: {
        componentId,
        score,
        passed,
        totalAttempts: progress.quizAttempts.filter(a => a.componentId === componentId).length,
      },
    })
  } catch (err) {
    console.error('[recordQuiz]', err)
    return sendError(res, 500, 'Failed to record quiz attempt')
  }
}


export async function unlockComponent(req, res) {
  try {
    const userId = getUserId(req)
    const { componentId, xpReward = 0, coinReward = 0 } = req.body

    if (!componentId) {
      return sendError(res, 400, 'componentId is required')
    }

    const progress = await UserProgress.findOrCreate(userId)

    const wasNew = progress.unlockComponent(componentId)

    if (!wasNew) {
      return res.json({
        success: true,
        data: {
          componentId,
          alreadyUnlocked: true,
          xpAwarded: 0,
          coinsAwarded: 0,
          xp: progress.xp,
          coins: progress.coins,
          level: progress.level,
          unlockedComponents: progress.unlockedComponents,
        },
      })
    }

    // Award XP
    const { xp, level, leveledUp } = progress.addXP(xpReward)
    progress.coins += coinReward
    progress.updateStreak()
    await progress.save()

    return res.json({
      success: true,
      data: {
        componentId,
        alreadyUnlocked: false,
        xpAwarded: xpReward,
        coinsAwarded: coinReward,
        xp,
        coins: progress.coins,
        level,
        leveledUp,
        unlockedComponents: progress.unlockedComponents,
      },
    })
  } catch (err) {
    console.error('[unlockComponent]', err)
    return sendError(res, 500, 'Failed to unlock component')
  }
}


export async function completeProject(req, res) {
  try {
    const userId = getUserId(req)

    // New scoring inputs (server-trusted computation)
    const {
      projectId,
      slug,

      // normalized category scores (0-100)
      wiringScore = 0,
      pinScore = 0,
      codeScore = 0,

      // scoring metadata
      isPartialPinCredit = false,
      analogExpected = null,
      analogActual = null,

      // bonuses + penalties
      requestedBonusKeys = [], // e.g. ['silent-run', 'mode-climber']
      challengeMeta = {},      // e.g. { astSimilarityPct: 72, noiseTier: 'drift' }
      penalties = [],          // e.g. [{ key: 'hint-spam', points: 5 }]

      badgeId,
    } = req.body

    if (!projectId) {
      return sendError(res, 400, 'projectId is required')
    }

    const progress = await UserProgress.findOrCreate(userId)

    // prevent duplicate completion reward
    const already = progress.completedProjects.some(p => p.projectId === projectId)
    if (already) {
      return res.json({
        success: true,
        data: {
          projectId,
          alreadyCompleted: true,
          xpAwarded: 0,
          badgeAwarded: null,
          xp: progress.xp,
          level: progress.level,
        },
      })
    }

    // attempt number = historical attempts + 1
    const attemptNo = progress.getProjectAttemptCount(projectId) + 1

    const scoreResult = computeFinalProjectXp({
      projectId,
      wiringScore,
      pinScore,
      codeScore,
      isPartialPinCredit,
      analogExpected,
      analogActual,
      attemptNo,
      requestedBonusKeys,
      challengeMeta,
      penalties,
    })

    if (!scoreResult.ok) {
      return sendError(res, 400, scoreResult.error || 'Invalid scoring payload')
    }

    // persist completion using computed XP only
    const { alreadyCompleted, xpEarned } = progress.completeProject({
      projectId,
      slug,
      xpReward: scoreResult.finalXp,
    })

    if (alreadyCompleted) {
      return res.json({
        success: true,
        data: {
          projectId,
          alreadyCompleted: true,
          xpAwarded: 0,
          badgeAwarded: null,
          xp: progress.xp,
          level: progress.level,
        },
      })
    }

    // Add XP
    const { xp, level, leveledUp } = progress.addXP(xpEarned)

    // Track detailed attempt analytics
    progress.addProjectAttempt({
      projectId,
      attemptNo,
      wiringScore,
      pinScore,
      codeScore,
      totalAwardedXp: scoreResult.finalXp,
      penaltiesApplied: scoreResult.penaltiesApplied.map(p => p.key),
      bonusesApplied: scoreResult.bonusesApplied.map(b => b.key),
    })

    // Persist penalty history entries
    for (const p of scoreResult.penaltiesApplied) {
      progress.addPenaltyEvent({
        projectId,
        penaltyKey: p.key,
        pointsDeduct: p.points,
      })
    }

    // Update simple mastery rolling average (safe initial logic)
    const prevAttempts = progress.getProjectAttemptCount(projectId) - 1
    const blend = (oldVal, newVal) => {
      if (prevAttempts <= 0) return Math.round(newVal)
      return Math.round((oldVal * prevAttempts + newVal) / (prevAttempts + 1))
    }

    progress.mastery.wiring = blend(progress.mastery.wiring, Number(wiringScore) || 0)
    progress.mastery.pin = blend(progress.mastery.pin, Number(pinScore) || 0)
    progress.mastery.code = blend(progress.mastery.code, Number(codeScore) || 0)

    let badgeAwarded = null
    if (badgeId) {
      const isNew = progress.awardBadge(badgeId)
      if (isNew) badgeAwarded = badgeId
    }

    progress.updateStreak()
    await progress.save()

    return res.json({
      success: true,
      data: {
        projectId,
        slug,
        alreadyCompleted: false,

        // transparent scoring output
        scoring: {
          attemptNo: scoreResult.attemptNo,
          breakdown: scoreResult.breakdown,
          baseXp: scoreResult.baseXp,
          retryDecayPct: scoreResult.retryDecayPct,
          xpAfterRetry: scoreResult.xpAfterRetry,
          bonusesApplied: scoreResult.bonusesApplied,
          totalBonusXp: scoreResult.totalBonusXp,
          penaltiesApplied: scoreResult.penaltiesApplied,
          finalXp: scoreResult.finalXp,
        },

        xpAwarded: scoreResult.finalXp,
        badgeAwarded,

        xp,
        coins: progress.coins,
        level,
        leveledUp,

        mastery: progress.mastery,
        earnedBadges: progress.earnedBadges,
        completedProjects: progress.completedProjects,
      },
    })
  } catch (err) {
    console.error('[completeProject]', err)
    return sendError(res, 500, 'Failed to complete project')
  }
}

export async function awardBadge(req, res) {
  try {
    const userId = getUserId(req)
    const { badgeId } = req.body

    if (!badgeId) {
      return sendError(res, 400, 'badgeId is required')
    }

    const progress = await UserProgress.findOrCreate(userId)
    const isNew = progress.awardBadge(badgeId)
    await progress.save()

    return res.json({
      success: true,
      data: {
        badgeId,
        alreadyHeld: !isNew,
        earnedBadges: progress.earnedBadges,
      },
    })
  } catch (err) {
    console.error('[awardBadge]', err)
    return sendError(res, 500, 'Failed to award badge')
  }
}


export async function resetProgress(req, res) {
  try {
    if (process.env.NODE_ENV === 'production') {
      return sendError(res, 403, 'Reset not allowed in production')
    }

    const userId = getUserId(req)
    await UserProgress.deleteOne({ userId })
    const fresh = await UserProgress.findOrCreate(userId)

    return res.json({
      success: true,
      message: 'Progress reset',
      data: fresh,
    })
  } catch (err) {
    console.error('[resetProgress]', err)
    return sendError(res, 500, 'Failed to reset progress')
  }
}

export async function getLeaderboard(req, res) {
  try {
    const top = await UserProgress
      .find({}, { userId: 1, xp: 1, level: 1, earnedBadges: 1, completedProjects: 1 })
      .sort({ xp: -1 })
      .limit(10)
      .lean()

    return res.json({ success: true, data: top })
  } catch (err) {
    console.error('[getLeaderboard]', err)
    return sendError(res, 500, 'Failed to fetch leaderboard')
  }
}

export async function getGamificationCatalog(req, res) {
  try {
    return res.json({
      success: true,
      data: {
        levels: LEVEL_BANDS,
        scoringRules: SCORING_RULES,
        projectRubrics: PROJECT_RUBRICS,
        bonusRules: BONUS_RULES,
        spendOptions: Object.values(SPEND_OPTIONS),
        economyRules: ECONOMY_RULES,
      },
    })
  } catch (err) {
    console.error('[getGamificationCatalog]', err)
    return sendError(res, 500, 'Failed to fetch gamification catalog')
  }
}

export async function recordChallengeAttempt(req, res) {
  try {
    const userId = getUserId(req)
    const {
      projectId,
      challengeKey,   // e.g. contradiction, noise-injection, mode-climber
      tier = null,    // for noise-injection: basic|drift|cascaded
      success = true,
      awardedXp = 0,  // optional manual award (safe-guarded below)
      meta = {},      // optional metadata
    } = req.body

    if (!projectId || !challengeKey) {
      return sendError(res, 400, 'projectId and challengeKey are required')
    }

    const progress = await UserProgress.findOrCreate(userId)

    // Optional conservative cap to avoid abuse when awardedXp is passed directly
    const safeXp = Math.max(0, Math.min(Number(awardedXp) || 0, 300))

    // store challenge attempt history
    progress.addChallengeAttempt({
      projectId,
      challengeKey,
      tier,
      awardedXp: safeXp,
      success: !!success,
    })

    // if success + xp > 0, award XP
    let xpUpdate = { xp: progress.xp, level: progress.level, leveledUp: false }
    if (success && safeXp > 0) {
      xpUpdate = progress.addXP(safeXp)
    }

    progress.updateStreak()
    await progress.save()

    return res.json({
      success: true,
      data: {
        projectId,
        challengeKey,
        tier,
        success: !!success,
        awardedXp: success ? safeXp : 0,
        xp: xpUpdate.xp,
        level: xpUpdate.level,
        leveledUp: xpUpdate.leveledUp,
        challengeAttempts: progress.challengeAttempts,
        meta,
      },
    })
  } catch (err) {
    console.error('[recordChallengeAttempt]', err)
    return sendError(res, 500, 'Failed to record challenge attempt')
  }
}

export async function getProgressAnalytics(req, res) {
  try {
    const userId = getUserId(req)
    const progress = await UserProgress.findOrCreate(userId)

    const totalProjectAttempts = progress.projectAttempts.length
    const totalChallengeAttempts = progress.challengeAttempts.length
    const totalHintUsage = progress.hintUsage.length
    const totalPenalties = progress.penaltyHistory.length

    // per-project aggregation
    const attemptsByProject = {}
    for (const a of progress.projectAttempts) {
      if (!attemptsByProject[a.projectId]) {
        attemptsByProject[a.projectId] = {
          projectId: a.projectId,
          attempts: 0,
          avgWiring: 0,
          avgPin: 0,
          avgCode: 0,
          totalXpAwarded: 0,
        }
      }
      const row = attemptsByProject[a.projectId]
      row.attempts += 1
      row.avgWiring += Number(a.wiringScore || 0)
      row.avgPin += Number(a.pinScore || 0)
      row.avgCode += Number(a.codeScore || 0)
      row.totalXpAwarded += Number(a.totalAwardedXp || 0)
    }

    for (const key of Object.keys(attemptsByProject)) {
      const row = attemptsByProject[key]
      row.avgWiring = Math.round(row.avgWiring / row.attempts)
      row.avgPin = Math.round(row.avgPin / row.attempts)
      row.avgCode = Math.round(row.avgCode / row.attempts)
    }

    // challenge breakdown
    const challengeBreakdown = {}
    for (const c of progress.challengeAttempts) {
      const k = c.challengeKey
      if (!challengeBreakdown[k]) {
        challengeBreakdown[k] = {
          challengeKey: k,
          attempts: 0,
          successCount: 0,
          totalXp: 0,
        }
      }
      challengeBreakdown[k].attempts += 1
      if (c.success) challengeBreakdown[k].successCount += 1
      challengeBreakdown[k].totalXp += Number(c.awardedXp || 0)
    }

    // spend breakdown
    const spendBreakdown = {}
    for (const h of progress.hintUsage) {
      const k = h.optionKey
      if (!spendBreakdown[k]) {
        spendBreakdown[k] = {
          optionKey: k,
          uses: 0,
          totalCostPaid: 0,
          totalRefunded: 0,
        }
      }
      spendBreakdown[k].uses += 1
      spendBreakdown[k].totalCostPaid += Number(h.costPaid || 0)
      spendBreakdown[k].totalRefunded += Number(h.refunded || 0)
    }

    return res.json({
      success: true,
      data: {
        userId: progress.userId,
        level: progress.level,
        xp: progress.xp,
        coins: progress.coins,
        streak: {
          current: progress.currentStreak,
          longest: progress.longestStreak,
          lastActiveDate: progress.lastActiveDate,
        },
        mastery: progress.mastery,

        totals: {
          totalProjectAttempts,
          totalChallengeAttempts,
          totalHintUsage,
          totalPenalties,
          completedProjects: progress.completedProjects.length,
          unlockedComponents: progress.unlockedComponents.length,
          badges: progress.earnedBadges.length,
        },

        attemptsByProject: Object.values(attemptsByProject),
        challengeBreakdown: Object.values(challengeBreakdown),
        spendBreakdown: Object.values(spendBreakdown),

        dailySpend: progress.dailySpend,
        modeSettings: progress.modeSettings,
      },
    })
  } catch (err) {
    console.error('[getProgressAnalytics]', err)
    return sendError(res, 500, 'Failed to fetch progress analytics')
  }
}

export async function spendPoints(req, res) {
  try {
    const userId = getUserId(req)
    const { projectId, optionKey } = req.body

    if (!projectId || !optionKey) {
      return sendError(res, 400, 'projectId and optionKey are required')
    }

    const option = getSpendOptionByKey(optionKey)
    if (!option) {
      return sendError(res, 400, `Unknown spend option '${optionKey}'`)
    }

    const progress = await UserProgress.findOrCreate(userId)

    // level unlock check
    if (progress.level < option.unlockLevel) {
      return sendError(
        res,
        403,
        `Option '${optionKey}' unlocks at level ${option.unlockLevel}`
      )
    }

    // initialize/reset daily spend bucket
    const todayKey = getTodayKey()
    if (!progress.dailySpend || progress.dailySpend.dateKey !== todayKey) {
      progress.dailySpend = { dateKey: todayKey, spendCount: 0 }
    }

    let finalCost = option.cost

    // soft daily surcharge (after first 3 spends)
    if (progress.dailySpend.spendCount >= ECONOMY_RULES.softDailySpendCount) {
      finalCost += ECONOMY_RULES.softDailySurcharge
    }

    // mode multipliers
    if (progress.modeSettings?.isExamMode) {
      finalCost = Math.round(finalCost * ECONOMY_RULES.examModeMultiplier)
    } else if (progress.modeSettings?.isPracticeMode) {
      finalCost = Math.max(
        1,
        Math.round(finalCost * (1 - ECONOMY_RULES.practiceModeDiscountPct / 100))
      )
    }

    if (progress.coins < finalCost) {
      return sendError(res, 400, `Insufficient coins. Required ${finalCost}, available ${progress.coins}`)
    }

    // throttle rule for serial-monitor-ghost (1 per project/day)
    if (option.key === 'serial-monitor-ghost') {
      const usedToday = progress.hintUsage.some(h =>
        h.projectId === projectId &&
        h.optionKey === option.key &&
        new Date(h.usedAt).toISOString().slice(0, 10) === todayKey
      )
      if (usedToday) {
        return sendError(res, 429, 'Serial Monitor Ghost can be used only once per project per day')
      }
    }

    // one-time per project for diagnosis pack
    if (option.key === 'diagnosis-pack') {
      const alreadyUsed = progress.hintUsage.some(h =>
        h.projectId === projectId && h.optionKey === option.key
      )
      if (alreadyUsed) {
        return sendError(res, 409, 'Diagnosis Pack is one-time per project')
      }
    }

    // deduct
    progress.coins -= finalCost
    progress.dailySpend.spendCount += 1

    // log usage
    progress.addHintUsage({
      projectId,
      optionKey: option.key,
      costPaid: finalCost,
      refunded: 0,
    })

    progress.updateStreak()
    await progress.save()

    return res.json({
      success: true,
      data: {
        projectId,
        optionKey: option.key,
        baseCost: option.cost,
        finalCost,
        remainingCoins: progress.coins,
        dailySpend: progress.dailySpend,
        modeSettings: progress.modeSettings,
      },
    })
  } catch (err) {
    console.error('[spendPoints]', err)
    return sendError(res, 500, 'Failed to spend points')
  }
}