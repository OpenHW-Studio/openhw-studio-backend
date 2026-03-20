import express from 'express'
import {
  getProgress,
  recordQuiz,
  unlockComponent,
  completeProject,
  awardBadge,
  resetProgress,
  getLeaderboard,
} from '../controllers/progressController.js'


const router = express.Router()

// ── Progress CRUD ─────────────────────────────────────────────────────────────
router.get('/',                getProgress)       
router.post('/quiz',           recordQuiz)        
router.post('/unlock',         unlockComponent)  
router.post('/complete',       completeProject)   
router.post('/badge',          awardBadge)        
router.get('/leaderboard',     getLeaderboard)    
router.put('/reset',           resetProgress)     
export default router

