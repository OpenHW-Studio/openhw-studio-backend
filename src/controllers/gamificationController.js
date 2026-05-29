import UserProgress from '../models/UserProgress.js'

function getUserId(req) {
  return req.user?.id || req.headers['x-user-id'] || 'anonymous'
}

export async function getUserUnlocks(req, res) {
  try {
    const userId = getUserId(req)
    const progress = await UserProgress.findOrCreate(userId)
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
      const progress = await UserProgress.findOrCreate(userId)
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
    
    const progress = await UserProgress.findOrCreate(userId)
    progress.unlockedComponents = unlockedComponentTypes
    await progress.save()
    
    return res.json({ 
      success: true, 
      unlockedComponentTypes: progress.unlockedComponents 
    })
  } catch (err) {
    console.error('[updateUserUnlocks]', err)
    return res.status(500).json({ success: false, error: 'Failed to save user unlocks' })
  }
}