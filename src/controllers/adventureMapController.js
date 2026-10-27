import AdventureMap from '../models/AdventureMap.js';
import UserProgress from '../models/UserProgress.js';
import Certificate from '../models/Certificate.js';
import Class from '../models/Class.js';
import crypto from 'crypto';
import mongoose from 'mongoose';

function getUserId(req) {
  return req.user?.id || req.user?._id || req.headers['x-user-id'] || 'anonymous';
}

function getUserName(req) {
  return req.user?.name || req.user?.username || 'Community Creator';
}

function generateCertId(userId, trackCode = 'COMM') {
  const hash = crypto.createHash('sha256').update(`${userId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 8).toUpperCase();
  return `OPENHW-${trackCode}-${hash}`;
}

/**
 * GET /api/adventure-maps
 * Fetch public / filtered adventure maps
 */
export async function getAdventureMaps(req, res) {
  try {
    const { tab = 'all', board, search, page = 1, limit = 12, classroomId } = req.query;
    const userId = getUserId(req);

    const filter = { status: 'published' };

    if (classroomId && mongoose.Types.ObjectId.isValid(classroomId)) {
      filter.classroomId = new mongoose.Types.ObjectId(classroomId);
      delete filter.scope;
      delete filter.status; // allow all maps belonging to this classroom
    } else if (tab === 'official') {
      filter.isOfficial = true;
      filter.isPublic = true;
      // Never show classroom-scoped maps in public/official feed
      filter.scope = { $ne: 'classroom' };
    } else if (tab === 'community') {
      filter.isOfficial = false;
      filter.isPublic = true;
      // Never show classroom-scoped maps in community feed
      filter.scope = { $ne: 'classroom' };
    } else if (tab === 'my-maps' || tab === 'my-worlds') {
      if (!req.user && (!userId || userId === 'anonymous')) {
        return res.json({ success: true, maps: [], total: 0, page: 1, limit: parseInt(limit, 10) });
      }
      delete filter.status; // allow creator to see their own drafts
      const queryIds = [userId];
      if (mongoose.Types.ObjectId.isValid(userId)) {
        queryIds.push(new mongoose.Types.ObjectId(userId));
      }
      filter.creatorId = { $in: queryIds };
      // Creators see ALL their maps including classroom-scoped ones
    } else {
      // 'all' tab — only show public, non-classroom-scoped maps
      filter.isPublic = true;
      filter.scope = { $ne: 'classroom' };
    }

    if (board && board !== 'all') {
      filter.board = board;
    }

    if (search && search.trim()) {
      const q = search.trim();
      filter.$or = [
        { title: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
        { tags: { $in: [new RegExp(q, 'i')] } }
      ];
    }

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
    const total = await AdventureMap.countDocuments(filter);
    const maps = await AdventureMap.find(filter)
      .sort({ isOfficial: -1, playCount: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10))
      .lean();

    // Attach summary stats without heavy nested payloads
    const summarized = maps.map(m => {
      let totalMissions = 0;
      let totalIslands = 0;

      if (Array.isArray(m.worlds) && m.worlds.length > 0) {
        m.worlds.forEach(w => {
          if (Array.isArray(w.islands)) {
            totalIslands += w.islands.length;
            w.islands.forEach(isl => {
              totalMissions += Array.isArray(isl.missions) ? isl.missions.length : 0;
            });
          }
        });
      } else if (Array.isArray(m.islands)) {
        totalIslands = m.islands.length;
        m.islands.forEach(isl => {
          totalMissions += Array.isArray(isl.missions) ? isl.missions.length : 0;
        });
      }

      return {
        _id: m._id,
        id: m._id,
        title: m.title,
        slug: m.slug,
        description: m.description,
        board: m.board,
        chipArchitecture: m.chipArchitecture,
        campaignCode: m.campaignCode,
        coverImage: m.coverImage,
        badgeColor: m.badgeColor,
        isOfficial: m.isOfficial,
        isPublic: m.isPublic,
        status: m.status,
        // Scope & Classroom fields
        scope: m.scope || 'public',
        classroomId: m.classroomId || null,
        creatorName: m.creatorName,
        creatorId: m.creatorId,
        totalWorlds: Array.isArray(m.worlds) && m.worlds.length > 0 ? m.worlds.length : 1,
        totalIslands,
        totalMissions,
        hasCertificate: Boolean(m.certification?.enabled),
        playCount: m.playCount || 0,
        likesCount: m.likesCount || 0,
        createdAt: m.createdAt,
      };
    });

    return res.json({
      success: true,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / parseInt(limit, 10)),
      maps: summarized,
    });
  } catch (err) {
    console.error('getAdventureMaps error:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve adventure maps' });
  }
}

/**
 * GET /api/adventure-maps/:slugOrId
 * Fetch single adventure map with full details
 */
export async function getAdventureMapBySlugOrId(req, res) {
  try {
    const { slugOrId } = req.params;
    let map = null;

    if (slugOrId.match(/^[0-9a-fA-F]{24}$/)) {
      map = await AdventureMap.findById(slugOrId).lean();
    }
    if (!map) {
      map = await AdventureMap.findOne({ slug: slugOrId.toLowerCase() }).lean();
    }

    if (!map) {
      return res.status(404).json({ success: false, error: 'Adventure map not found' });
    }

    // Increment play count asynchronously
    AdventureMap.findByIdAndUpdate(map._id, { $inc: { playCount: 1 } }).exec();

    const userId = getUserId(req);
    const isOwnerOrAdmin = String(map.creatorId) === String(userId) || req.user?.role === 'admin';

    // Classroom-scoped map security: only teacher/creator/admin or enrolled students can view/play
    if (map.scope === 'classroom' || map.classroomId) {
      if (!req.user && (!userId || userId === 'anonymous')) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required to access this classroom adventure.'
        });
      }
      if (!isOwnerOrAdmin) {
        const classroom = await Class.findOne({
          _id: map.classroomId,
          students: userId
        }).select('_id').lean();

        if (!classroom) {
          return res.status(403).json({
            success: false,
            error: 'This adventure is exclusive to students enrolled in this classroom.'
          });
        }
      }
    }

    // Protect solution circuit if student is viewing
    if (!isOwnerOrAdmin) {
      if (Array.isArray(map.worlds)) {
        map.worlds.forEach(w => {
          (w.islands || []).forEach(isl => {
            (isl.missions || []).forEach(m => {
              if (m.projectMission?.solutionCircuit) {
                // Keep only prompt, hide raw solution
                m.projectMission.solutionCircuit = { hasSolution: true };
              }
            });
          });
        });
      }
      if (Array.isArray(map.islands)) {
        map.islands.forEach(isl => {
          (isl.missions || []).forEach(m => {
            if (m.projectMission?.solutionCircuit) {
              m.projectMission.solutionCircuit = { hasSolution: true };
            }
          });
        });
      }
    }

    return res.json({ success: true, map });
  } catch (err) {
    console.error('getAdventureMapBySlugOrId error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch adventure map' });
  }
}

/**
 * POST /api/adventure-maps
 * Create a new Adventure Map
 */
export async function createAdventureMap(req, res) {
  try {
    const userId = getUserId(req);
    const userName = getUserName(req);
    const userRole = req.user?.role;
    const body = req.body || {};

    if (!body.title || !body.title.trim()) {
      return res.status(400).json({ success: false, error: 'Campaign title is required' });
    }

    let slug = body.slug ? body.slug.trim().toLowerCase() : body.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    if (!slug) {
      slug = `custom-adventure-${Date.now()}`;
    }

    // Check slug collision
    const existing = await AdventureMap.findOne({ slug });
    if (existing) {
      slug = `${slug}-${Math.floor(1000 + Math.random() * 9000)}`;
    }

    // ── Classroom Scope Validation (teachers only) ──────────────────────────
    let scope = 'public';
    let classroomId = null;
    let resolvedIsPublic = body.isPublic !== undefined ? Boolean(body.isPublic) : true;

    if (body.classroomId && mongoose.Types.ObjectId.isValid(body.classroomId)) {
      // Only teachers (and admins) can create classroom-scoped maps
      if (userRole !== 'teacher' && userRole !== 'admin') {
        return res.status(403).json({
          success: false,
          error: 'Only teachers can create classroom-scoped adventure maps.'
        });
      }
      // Verify the teacher actually owns this classroom
      const classroom = await Class.findById(body.classroomId).select('teacher').lean();
      if (!classroom) {
        return res.status(404).json({ success: false, error: 'Classroom not found.' });
      }
      if (String(classroom.teacher) !== String(userId) && userRole !== 'admin') {
        return res.status(403).json({
          success: false,
          error: 'You can only link adventure maps to classrooms you own.'
        });
      }
      scope = 'classroom';
      classroomId = body.classroomId;
      resolvedIsPublic = false; // classroom maps are never public
    }

    const newMap = new AdventureMap({
      title: body.title.trim(),
      slug,
      description: body.description || '',
      board: body.board || 'arduino-uno',
      chipArchitecture: body.chipArchitecture || '8-BIT AVR RISC',
      campaignCode: body.campaignCode || 'COMM-01',
      coverImage: body.coverImage || '',
      badgeColor: body.badgeColor || '#10b981',
      creatorId: userId,
      creatorName: userName,
      isOfficial: userRole === 'admin' ? Boolean(body.isOfficial) : false,
      isPublic: resolvedIsPublic,
      status: body.status || 'published',
      scope,
      classroomId,
      worlds: Array.isArray(body.worlds) ? body.worlds : [],
      islands: Array.isArray(body.islands) ? body.islands : [],
      certification: body.certification || { enabled: false },
      tags: Array.isArray(body.tags) ? body.tags : []
    });

    await newMap.save();

    return res.status(201).json({
      success: true,
      message: 'Adventure map created successfully',
      map: newMap
    });
  } catch (err) {
    console.error('createAdventureMap error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to create adventure map' });
  }
}

/**
 * PUT /api/adventure-maps/:id
 * Update an existing Adventure Map
 */
export async function updateAdventureMap(req, res) {
  try {
    const { id } = req.params;
    const userId = getUserId(req);
    const userRole = req.user?.role;

    const map = await AdventureMap.findById(id);
    if (!map) {
      return res.status(404).json({ success: false, error: 'Adventure map not found' });
    }

    if (String(map.creatorId) !== String(userId) && userRole !== 'admin') {
      return res.status(403).json({ success: false, error: 'Not authorized to modify this adventure map' });
    }

    const b = req.body || {};
    if (b.title) map.title = b.title.trim();
    if (b.description !== undefined) map.description = b.description;
    if (b.board) map.board = b.board;
    if (b.chipArchitecture) map.chipArchitecture = b.chipArchitecture;
    if (b.campaignCode) map.campaignCode = b.campaignCode;
    if (b.badgeColor) map.badgeColor = b.badgeColor;
    if (b.coverImage !== undefined) map.coverImage = b.coverImage;
    if (b.status) map.status = b.status;
    if (Array.isArray(b.worlds)) map.worlds = b.worlds;
    if (Array.isArray(b.islands)) map.islands = b.islands;
    if (b.certification) map.certification = b.certification;
    if (Array.isArray(b.tags)) map.tags = b.tags;

    if (userRole === 'admin' && b.isOfficial !== undefined) {
      map.isOfficial = Boolean(b.isOfficial);
    }

    // ── Classroom scope update (teachers & admins only) ─────────────────────
    if (b.classroomId !== undefined) {
      if (userRole !== 'teacher' && userRole !== 'admin') {
        return res.status(403).json({ success: false, error: 'Only teachers can set classroom scope.' });
      }
      if (b.classroomId && mongoose.Types.ObjectId.isValid(b.classroomId)) {
        const classroom = await Class.findById(b.classroomId).select('teacher').lean();
        if (!classroom) {
          return res.status(404).json({ success: false, error: 'Classroom not found.' });
        }
        if (String(classroom.teacher) !== String(userId) && userRole !== 'admin') {
          return res.status(403).json({ success: false, error: 'You can only link to classrooms you own.' });
        }
        map.scope = 'classroom';
        map.classroomId = b.classroomId;
        map.isPublic = false; // classroom maps are private
      } else if (b.classroomId === null || b.classroomId === '') {
        // Remove classroom binding → revert to public
        map.scope = 'public';
        map.classroomId = null;
        if (b.isPublic !== undefined) map.isPublic = Boolean(b.isPublic);
        else map.isPublic = true;
      }
    } else {
      // No scope change — only update isPublic if not classroom-scoped
      if (map.scope !== 'classroom' && b.isPublic !== undefined) {
        map.isPublic = Boolean(b.isPublic);
      }
    }

    await map.save();

    return res.json({ success: true, message: 'Adventure map updated successfully', map });
  } catch (err) {
    console.error('updateAdventureMap error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to update adventure map' });
  }
}

/**
 * DELETE /api/adventure-maps/:id
 */
export async function deleteAdventureMap(req, res) {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const map = await AdventureMap.findById(id);
    if (!map) {
      return res.status(404).json({ success: false, error: 'Adventure map not found' });
    }

    if (String(map.creatorId) !== String(userId) && req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this adventure map' });
    }

    await AdventureMap.findByIdAndDelete(id);

    return res.json({ success: true, message: 'Adventure map deleted successfully' });
  } catch (err) {
    console.error('deleteAdventureMap error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete adventure map' });
  }
}

/**
 * POST /api/adventure-maps/:id/complete-mission
 * Track student progress for custom mission
 */
export async function completeAdventureMission(req, res) {
  try {
    const { id } = req.params;
    const { missionSlug, xpReward = 100 } = req.body;
    const userId = getUserId(req);

    if (!missionSlug) {
      return res.status(400).json({ success: false, error: 'missionSlug is required' });
    }

    const map = await AdventureMap.findById(id).lean();
    if (!map) {
      return res.status(404).json({ success: false, error: 'Adventure map not found' });
    }

    // Classroom scope check: must be enrolled in classroom
    if (map.scope === 'classroom' || map.classroomId) {
      const isOwnerOrAdmin = String(map.creatorId) === String(userId) || req.user?.role === 'admin';
      if (!isOwnerOrAdmin) {
        const classroom = await Class.findOne({
          _id: map.classroomId,
          students: userId
        }).select('_id').lean();
        if (!classroom) {
          return res.status(403).json({
            success: false,
            error: 'You are not enrolled in the classroom for this adventure map.'
          });
        }
      }
    }

    const progress = await UserProgress.findOrCreate(userId);
    if (!Array.isArray(progress.customAdventures)) {
      progress.customAdventures = [];
    }

    let userAdv = progress.customAdventures.find(a => String(a.mapId) === String(id) || a.mapSlug === map.slug);
    if (!userAdv) {
      userAdv = {
        mapId: map._id,
        mapSlug: map.slug,
        completedMissions: [],
        isCompleted: false,
        certificateClaimed: false,
        lastActive: new Date()
      };
      progress.customAdventures.push(userAdv);
    }

    let newlyCompleted = false;
    if (!userAdv.completedMissions.includes(missionSlug)) {
      userAdv.completedMissions.push(missionSlug);
      progress.addXP(xpReward);
      newlyCompleted = true;
    }

    // Check if user completed all missions in this map
    const allMapMissionSlugs = [];
    (map.islands || []).forEach(isl => {
      (isl.missions || []).forEach(m => {
        if (m.slug) allMapMissionSlugs.push(m.slug);
      });
    });

    const isAllDone = allMapMissionSlugs.length > 0 && allMapMissionSlugs.every(s => userAdv.completedMissions.includes(s));
    userAdv.isCompleted = isAllDone;
    userAdv.lastActive = new Date();

    await progress.save();

    return res.json({
      success: true,
      newlyCompleted,
      isMapCompleted: isAllDone,
      completedMissions: userAdv.completedMissions,
      totalMissions: allMapMissionSlugs.length
    });
  } catch (err) {
    console.error('completeAdventureMission error:', err);
    return res.status(500).json({ success: false, error: 'Failed to record mission completion' });
  }
}

/**
 * POST /api/adventure-maps/:id/claim-cert
 * Verify and claim custom certificate
 */
export async function claimAdventureCertificate(req, res) {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const map = await AdventureMap.findById(id).lean();
    if (!map) {
      return res.status(404).json({ success: false, error: 'Adventure map not found' });
    }

    // Classroom scope check: must be enrolled in classroom
    if (map.scope === 'classroom' || map.classroomId) {
      const isOwnerOrAdmin = String(map.creatorId) === String(userId) || req.user?.role === 'admin';
      if (!isOwnerOrAdmin) {
        const classroom = await Class.findOne({
          _id: map.classroomId,
          students: userId
        }).select('_id').lean();
        if (!classroom) {
          return res.status(403).json({
            success: false,
            error: 'You are not enrolled in the classroom for this adventure map.'
          });
        }
      }
    }

    if (!map.certification?.enabled) {
      return res.status(400).json({ success: false, error: 'This adventure map does not have certification enabled' });
    }

    const progress = await UserProgress.findOrCreate(userId);
    const userAdv = (progress.customAdventures || []).find(a => String(a.mapId) === String(id) || a.mapSlug === map.slug);

    const allSlugs = [];
    (map.islands || []).forEach(isl => {
      (isl.missions || []).forEach(m => {
        if (m.slug) allSlugs.push(m.slug);
      });
    });

    const isCompleted = userAdv && allSlugs.every(s => userAdv.completedMissions.includes(s));
    if (!isCompleted) {
      return res.status(400).json({
        success: false,
        error: 'You must complete all missions in this world before claiming the certificate.'
      });
    }

    const recipientName = req.user?.name || req.user?.username || 'OpenHW Engineer';
    const certId = generateCertId(userId, 'COMM');

    // Create ledger certificate
    const certDoc = new Certificate({
      certId,
      userId: String(userId),
      recipientName,
      recipientEmail: req.user?.email || '',
      track: 'arduino',
      trackCode: 'COMM',
      trackTitle: map.certification.title || map.title,
      domains: (map.islands || []).map(isl => ({
        domain: isl.name,
        skills: (isl.missions || []).map(m => m.title)
      })),
      competencies: allSlugs,
      projectsCompleted: allSlugs,
      totalProjectsRequired: allSlugs.length,
      issuedAt: new Date(),
      status: 'active'
    });

    await certDoc.save();

    userAdv.certificateClaimed = true;
    userAdv.certificateId = certId;
    await progress.save();

    return res.json({
      success: true,
      certificate: {
        certId,
        trackTitle: certDoc.trackTitle,
        recipientName: certDoc.recipientName,
        issuedAt: certDoc.issuedAt,
        issuerName: map.certification.issuerName || 'OpenHW Community Studio'
      }
    });
  } catch (err) {
    console.error('claimAdventureCertificate error:', err);
    return res.status(500).json({ success: false, error: 'Failed to claim certificate' });
  }
}
