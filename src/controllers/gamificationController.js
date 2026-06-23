import UserProgress from '../models/UserProgress.js'

function getUserId(req) {
  return req.user?.id || req.headers['x-user-id'] || 'anonymous'
}

export async function getUserUnlocks(req, res) {
  try {
    const userId = getUserId(req)
    console.log('Received PUT /state for', userId, req.body.state); const progress = await UserProgress.findOrCreate(userId)
    return res.json({ 
      success: true, 
      unlockedComponentTypes: progress.unlockedComponents || [] 
    })
  } catch (err) {
    console.error('[getUserUnlocks]', err)
    return res.status(500).json({ success: false, error: 'Failed to fetch user unlocks' })
  }
}

export async function updateUserUnlocks(req, res) {
  try {
    const userId = getUserId(req)
    const { unlockedComponentTypes } = req.body
    
    // Handle wildcard case ('*' means all components unlocked)
    if (unlockedComponentTypes === '*') {
      console.log('Received PUT /state for', userId, req.body.state); const progress = await UserProgress.findOrCreate(userId)
      // Store '*' as a special marker in the array
      progress.unlockedComponents = ['*']
      await progress.save()
      
      return res.json({ 
        success: true, 
        unlockedComponentTypes: progress.unlockedComponents 
      })
    }
    
    if (!Array.isArray(unlockedComponentTypes)) {
      return res.status(400).json({ success: false, error: 'unlockedComponentTypes must be an array or string' })
    }
    
    console.log('Received PUT /state for', userId, req.body.state); const progress = await UserProgress.findOrCreate(userId)
    progress.unlockedComponents = unlockedComponentTypes
    await progress.save()
    
    return res.json({ 
      success: true, 
      unlockedComponentTypes: progress.unlockedComponents 
    })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to save user unlocks' })
  }
}

export async function getUserGamificationState(req, res) {
  try {
    const userId = getUserId(req)
    console.log('Received PUT /state for', userId, req.body.state); const progress = await UserProgress.findOrCreate(userId)
    
    return res.json({ 
      success: true, 
      state: {
        xp: progress.xp || 0,
        currentLevel: progress.level || 1,
        earnedBadges: progress.earnedBadges || [],
        completedProjects: progress.completedProjects.map(p => p.slug || p.projectId) || [],
        unlockedComponentTypes: progress.unlockedComponents || []
      }
    })
  } catch (err) {
    console.error('[getUserGamificationState]', err)
    return res.status(500).json({ success: false, error: 'Failed to fetch user gamification state' })
  }
}

export async function updateUserGamificationState(req, res) {
  try {
    const userId = getUserId(req)
    const { xp, currentLevel, earnedBadges, completedProjects, unlockedComponentTypes } = req.body.state || {}
    
    console.log('Received PUT /state for', userId, req.body.state); const progress = await UserProgress.findOrCreate(userId)
    
    if (xp !== undefined) progress.xp = xp
    if (currentLevel !== undefined) progress.level = currentLevel
    if (earnedBadges !== undefined) progress.earnedBadges = earnedBadges
    if (unlockedComponentTypes !== undefined) {
      if (unlockedComponentTypes === '*') {
         progress.unlockedComponents = ['*']
      } else if (Array.isArray(unlockedComponentTypes)) {
         progress.unlockedComponents = unlockedComponentTypes
      }
    }
    
    if (completedProjects && Array.isArray(completedProjects)) {
      // Just keep track of slugs simply for gamification mapping
      progress.completedProjects = completedProjects.map(slug => ({
        projectId: slug,
        slug: slug,
        xpEarned: 0
      }))
    }
    
    await progress.save()
    
    return res.json({ success: true, state: req.body.state })
  } catch (err) {
    console.error('[updateUserGamificationState]', err)
    return res.status(500).json({ success: false, error: 'Failed to save user gamification state' })
  }
}