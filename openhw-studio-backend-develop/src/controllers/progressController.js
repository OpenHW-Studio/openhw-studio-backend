
import UserProgress from '../models/UserProgress.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getUserId(req) {
  return req.user?.id || req.headers['x-user-id'] || 'anonymous'
}

function sendError(res, status, message) {
  return res.status(status).json({ success: false, error: message })
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
    const { projectId, slug, xpReward = 0, badgeId } = req.body

    if (!projectId) {
      return sendError(res, 400, 'projectId is required')
    }

    const progress = await UserProgress.findOrCreate(userId)

    const { alreadyCompleted, xpEarned } = progress.completeProject({ projectId, slug, xpReward })

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

    const { xp, level, leveledUp } = progress.addXP(xpEarned)

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
        alreadyCompleted: false,
        xpAwarded: xpEarned,
        badgeAwarded,
        xp,
        coins: progress.coins,
        level,
        leveledUp,
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