import express from 'express'
import {
  getProgress,
  recordQuiz,
  unlockComponent,
  completeProject,
  awardBadge,
  resetProgress,
  getLeaderboard,
  spendPoints, // add
  getGamificationCatalog,
  recordChallengeAttempt,
  getProgressAnalytics,
} from '../controllers/progressController.js'

const router = express.Router()

// ── Progress CRUD ─────────────────────────────────────────────────────────────
router.get('/',                getProgress)       
router.post('/quiz',           recordQuiz)        
router.post('/unlock',         unlockComponent)  
router.post('/complete',       completeProject)   
router.post('/badge',          awardBadge)      
router.post('/spend',          spendPoints)  
router.post('/challenge/attempt', recordChallengeAttempt)
router.get('/analytics',           getProgressAnalytics)
router.get('/catalog',         getGamificationCatalog)
router.get('/leaderboard',     getLeaderboard)    
router.put('/reset',           resetProgress)     
export default router

