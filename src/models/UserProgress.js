import mongoose from 'mongoose'
import { LEVEL_BANDS } from '../config/gamification.js'

const QuizAttemptSchema = new mongoose.Schema({
  componentId:  { type: String, required: true },
  score:        { type: Number, required: true }, // 0–100
  passed:       { type: Boolean, required: true },
  attemptedAt:  { type: Date, default: Date.now },
}, { _id: false })

const CompletedProjectSchema = new mongoose.Schema({
  projectId:    { type: String, required: true },
  slug:         { type: String },
  xpEarned:     { type: Number, default: 0 },
  completedAt:  { type: Date, default: Date.now },
}, { _id: false })

const ProjectAttemptSchema = new mongoose.Schema({
  projectId:        { type: String, required: true },
  attemptNo:        { type: Number, default: 1 },
  wiringScore:      { type: Number, default: 0 }, // 0-100 normalized
  pinScore:         { type: Number, default: 0 }, // 0-100 normalized
  codeScore:        { type: Number, default: 0 }, // 0-100 normalized
  totalAwardedXp:   { type: Number, default: 0 },
  penaltiesApplied: { type: [String], default: [] },
  bonusesApplied:   { type: [String], default: [] },
  attemptedAt:      { type: Date, default: Date.now },
}, { _id: false })

const ChallengeAttemptSchema = new mongoose.Schema({
  projectId:    { type: String, required: true },
  challengeKey: { type: String, required: true }, // contradiction, blind-build, etc.
  tier:         { type: String, default: null },  // for noise-injection
  awardedXp:    { type: Number, default: 0 },
  success:      { type: Boolean, default: false },
  attemptedAt:  { type: Date, default: Date.now },
}, { _id: false })

const HintUsageSchema = new mongoose.Schema({
  projectId:   { type: String, required: true },
  optionKey:   { type: String, required: true }, // spend option key
  costPaid:    { type: Number, default: 0 },
  refunded:    { type: Number, default: 0 },
  usedAt:      { type: Date, default: Date.now },
}, { _id: false })

const PenaltyEventSchema = new mongoose.Schema({
  projectId:    { type: String, required: true },
  penaltyKey:   { type: String, required: true }, // short-circuit, hint-spam, etc.
  pointsDeduct: { type: Number, default: 0 },
  createdAt:    { type: Date, default: Date.now },
}, { _id: false })

const DailySpendSchema = new mongoose.Schema({
  dateKey:    { type: String, default: null }, // YYYY-MM-DD
  spendCount: { type: Number, default: 0 },
}, { _id: false })

const UserProgressSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    xp: {
      type: Number,
      default: 0,
      min: 0,
    },

    coins: {
      type: Number,
      default: 0,
      min: 0,
    },

    level: {
      type: Number,
      default: 1,
      min: 1,
    },

    unlockedComponents: {
      type: [String],
      default: [],
    },

    quizAttempts: {
      type: [QuizAttemptSchema],
      default: [],
    },

    completedProjects: {
      type: [CompletedProjectSchema],
      default: [],
    },

    earnedBadges: {
      type: [String],
      default: [],
    },

    currentStreak: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },
    lastActiveDate: { type: Date, default: null },

    // NEW: mastery tracks (0-100)
    mastery: {
      wiring: { type: Number, default: 0, min: 0, max: 100 },
      pin:    { type: Number, default: 0, min: 0, max: 100 },
      code:   { type: Number, default: 0, min: 0, max: 100 },
    },

    // NEW: attempt and economy history
    projectAttempts: {
      type: [ProjectAttemptSchema],
      default: [],
    },

    challengeAttempts: {
      type: [ChallengeAttemptSchema],
      default: [],
    },

    hintUsage: {
      type: [HintUsageSchema],
      default: [],
    },

    penaltyHistory: {
      type: [PenaltyEventSchema],
      default: [],
    },

    dailySpend: {
      type: DailySpendSchema,
      default: () => ({ dateKey: null, spendCount: 0 }),
    },

    // NEW: mode flag for economy multipliers
    modeSettings: {
      isExamMode: { type: Boolean, default: false },
      isPracticeMode: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
)

// ─── Virtuals ──────────────────────��──────────────────────────────────────────

UserProgressSchema.virtual('completedProjectCount').get(function () {
  return this.completedProjects.length
})

UserProgressSchema.virtual('unlockedComponentCount').get(function () {
  return this.unlockedComponents.length
})

// ─── Instance methods ─────────────────────────────────────────────────────────

UserProgressSchema.methods.recomputeLevel = function () {
  let computed = 1
  for (const band of LEVEL_BANDS) {
    if (this.xp >= band.minXp && this.xp <= band.maxXp) {
      computed = band.level
      break
    }
  }
  this.level = computed
  return this.level
}

/**
 * Add XP and update level using LEVEL_BANDS config.
 * Returns { xp, level, leveledUp }
 */
UserProgressSchema.methods.addXP = function (amount = 0) {
  const safeAmount = Number.isFinite(amount) ? amount : 0
  const prevLevel = this.level

  this.xp = Math.max(0, this.xp + safeAmount)
  this.recomputeLevel()

  return { xp: this.xp, level: this.level, leveledUp: this.level > prevLevel }
}

UserProgressSchema.methods.unlockComponent = function (componentId) {
  if (this.unlockedComponents.includes(componentId)) return false
  this.unlockedComponents.push(componentId)
  return true
}

UserProgressSchema.methods.recordQuizAttempt = function ({ componentId, score, passed }) {
  this.quizAttempts.push({ componentId, score, passed, attemptedAt: new Date() })
}

UserProgressSchema.methods.completeProject = function ({ projectId, slug, xpReward }) {
  const already = this.completedProjects.some(p => p.projectId === projectId)
  if (already) return { alreadyCompleted: true, xpEarned: 0 }

  this.completedProjects.push({ projectId, slug, xpEarned: xpReward })
  return { alreadyCompleted: false, xpEarned: xpReward }
}

UserProgressSchema.methods.awardBadge = function (badgeId) {
  if (this.earnedBadges.includes(badgeId)) return false
  this.earnedBadges.push(badgeId)
  return true
}

UserProgressSchema.methods.updateStreak = function () {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  if (!this.lastActiveDate) {
    this.currentStreak = 1
    this.lastActiveDate = today
    if (this.longestStreak < 1) this.longestStreak = 1
    return
  }

  const last = new Date(this.lastActiveDate)
  last.setHours(0, 0, 0, 0)
  const diffDays = Math.floor((today - last) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return
  if (diffDays === 1) {
    this.currentStreak += 1
    if (this.currentStreak > this.longestStreak) this.longestStreak = this.currentStreak
  } else {
    this.currentStreak = 1
  }
  this.lastActiveDate = today
}

// NEW helper: track project attempt detail
UserProgressSchema.methods.addProjectAttempt = function (attempt) {
  this.projectAttempts.push({
    projectId: attempt.projectId,
    attemptNo: attempt.attemptNo || 1,
    wiringScore: attempt.wiringScore || 0,
    pinScore: attempt.pinScore || 0,
    codeScore: attempt.codeScore || 0,
    totalAwardedXp: attempt.totalAwardedXp || 0,
    penaltiesApplied: attempt.penaltiesApplied || [],
    bonusesApplied: attempt.bonusesApplied || [],
    attemptedAt: new Date(),
  })
}

// NEW helper: challenge history
UserProgressSchema.methods.addChallengeAttempt = function (entry) {
  this.challengeAttempts.push({
    projectId: entry.projectId,
    challengeKey: entry.challengeKey,
    tier: entry.tier ?? null,
    awardedXp: entry.awardedXp || 0,
    success: !!entry.success,
    attemptedAt: new Date(),
  })
}

// NEW helper: hint usage history
UserProgressSchema.methods.addHintUsage = function (entry) {
  this.hintUsage.push({
    projectId: entry.projectId,
    optionKey: entry.optionKey,
    costPaid: entry.costPaid || 0,
    refunded: entry.refunded || 0,
    usedAt: new Date(),
  })
}

// NEW helper: penalty history
UserProgressSchema.methods.addPenaltyEvent = function (entry) {
  this.penaltyHistory.push({
    projectId: entry.projectId,
    penaltyKey: entry.penaltyKey,
    pointsDeduct: entry.pointsDeduct || 0,
    createdAt: new Date(),
  })
}

// NEW helper: count attempts by project
UserProgressSchema.methods.getProjectAttemptCount = function (projectId) {
  return this.projectAttempts.filter(a => a.projectId === projectId).length
}

UserProgressSchema.statics.findOrCreate = async function (userId) {
  let progress = await this.findOne({ userId })
  if (!progress) {
    progress = await this.create({ userId })
  }
  return progress
}

export default mongoose.model('UserProgress', UserProgressSchema)