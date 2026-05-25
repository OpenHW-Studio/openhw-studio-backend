
import mongoose from 'mongoose'


const QuizAttemptSchema = new mongoose.Schema({
  componentId:  { type: String, required: true },
  score:        { type: Number, required: true },      // 0–100
  passed:       { type: Boolean, required: true },
  attemptedAt:  { type: Date, default: Date.now },
}, { _id: false })

const CompletedProjectSchema = new mongoose.Schema({
  projectId:    { type: String, required: true },
  slug:         { type: String },
  xpEarned:    { type: Number, default: 0 },
  completedAt:  { type: Date, default: Date.now },
}, { _id: false })


const UserProgressSchema = new mongoose.Schema(
  {
    // User reference — use your auth system's user ID
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

    // ── Components ───────────────────────────────────────────────────────────
    unlockedComponents: {
      type: [String],   // array of component IDs e.g. ['led', 'resistor']
      default: [],
    },
    quizAttempts: {
      type: [QuizAttemptSchema],
      default: [],
    },

    // ── Projects ─────────────────────────────────────────────────────────────
    completedProjects: {
      type: [CompletedProjectSchema],
      default: [],
    },

    // ── Badges ───────────────────────────────────────────────────────────────
    earnedBadges: {
      type: [String],   // badge IDs e.g. ['led-master', 'blink-champion']
      default: [],
    },

    // ── Streaks ──────────────────────────────────────────────────────────────
    currentStreak: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },
    lastActiveDate: { type: Date, default: null },
  },
  {
    timestamps: true,   
    versionKey: false,
  }
)

// ─── Virtuals ─────────────────────────────────────────────────────────────────

UserProgressSchema.virtual('completedProjectCount').get(function () {
  return this.completedProjects.length
})

UserProgressSchema.virtual('unlockedComponentCount').get(function () {
  return this.unlockedComponents.length
})

// ─── Instance methods ─────────────────────────────────────────────────────────

/**
 * Add XP and auto-update level based on thresholds.
 * Returns { xp, level, leveledUp }
 */
UserProgressSchema.methods.addXP = function (amount) {
  this.xp += amount

  const LEVEL_THRESHOLDS = [0, 100, 250, 500, 850, 1300, 1900, 2600, 3500, 4600, 6000]
  const prevLevel = this.level

  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 1; i--) {
    if (this.xp >= LEVEL_THRESHOLDS[i]) {
      this.level = i + 1
      break
    }
  }

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

  if (diffDays === 0) return          // already active today
  if (diffDays === 1) {               // consecutive day
    this.currentStreak += 1
    if (this.currentStreak > this.longestStreak) this.longestStreak = this.currentStreak
  } else {                            // streak broken
    this.currentStreak = 1
  }
  this.lastActiveDate = today
}


UserProgressSchema.statics.findOrCreate = async function (userId) {
  let progress = await this.findOne({ userId })
  if (!progress) {
    progress = await this.create({ userId })
  }
  return progress
}


export default mongoose.model('UserProgress', UserProgressSchema)