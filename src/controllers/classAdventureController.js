import mongoose from "mongoose";
import Class from "../models/Class.js";
import User from "../models/User.js";
import ClassAdventureConfig from "../models/ClassAdventureConfig.js";
import ClassAdventureProgress from "../models/ClassAdventureProgress.js";

const { ObjectId } = mongoose.Types;

const DEFAULT_CONTENT = {
  worlds: [
    { id: "world-1", title: "World 1", theme: "Beginner", color: "#22c55e", icon: "W1", order: 1 },
  ],
  projects: [],
  version: 1,
};

const isValidObjectId = (id) => ObjectId.isValid(id);

const sanitizeQuizQuestion = (question, index) => {
  const options = Array.isArray(question?.options)
    ? question.options.map((opt) => String(opt || "").trim()).filter(Boolean)
    : [];
  return {
    id: typeof question?.id === "string" && question.id.trim() ? question.id.trim() : `q-${index + 1}`,
    question: String(question?.question || "").trim() || `Question ${index + 1}`,
    options,
    correctAnswer: Number.isFinite(question?.correctAnswer) ? Number(question.correctAnswer) : 0,
    explanation: typeof question?.explanation === "string" ? question.explanation.trim() : "",
  };
};

const sanitizeGuidedStep = (step, index) => {
  return {
    id: Number.isFinite(step?.id) ? Number(step.id) : index,
    phase: ['wire', 'code', 'run'].includes(step?.phase) ? step.phase : 'wire',
    icon: typeof step?.icon === "string" ? step.icon.trim() : "🔧",
    color: typeof step?.color === "string" ? step.color.trim() : "#22c55e",
    title: typeof step?.title === "string" && step.title.trim() ? step.title.trim() : `Step ${index + 1}`,
    instruction: typeof step?.instruction === "string" ? step.instruction.trim() : "",
    tip: typeof step?.tip === "string" ? step.tip.trim() : "",
    code: typeof step?.code === "string" ? step.code.trim() : "",
  };
};

const sanitizeProject = (project, index, worldIds) => {
  const slug = String(project?.slug || "").trim() || `project-${index + 1}`;
  const worldId = typeof project?.worldId === "string" && worldIds.has(project.worldId)
    ? project.worldId
    : [...worldIds][0];

  // ── Assessment: promoted to top-level field (mirrors theory/quizQuestions pattern) ──
  // Supports both legacy `content` format and new `assessment` format
  const assessment = project?.assessment || project?.content || {}

  const guidedSteps = Array.isArray(project?.guidedSteps)
    ? project.guidedSteps.map(sanitizeGuidedStep)
    : [];

  return {
    id: String(project?.id || slug).trim(),
    slug,
    worldId,
    order: Number.isFinite(project?.order) ? Number(project.order) : index + 1,
    enabled: project?.enabled !== false,
    title: String(project?.title || slug).trim(),
    subtitle: typeof project?.subtitle === "string" ? project.subtitle.trim() : "",
    description: typeof project?.description === "string" ? project.description.trim() : "",
    prerequisite: typeof project?.prerequisite === "string" && project.prerequisite.trim() ? project.prerequisite.trim() : null,
    xpReward: Number.isFinite(project?.xpReward) ? Math.max(0, Number(project.xpReward)) : 0,
    rewardComponents: Array.isArray(project?.rewardComponents) ? project.rewardComponents : [],
    theory: Array.isArray(project?.theory) ? project.theory : [],
    quizQuestions: Array.isArray(project?.quizQuestions) ? project.quizQuestions.map(sanitizeQuizQuestion) : [],
assessment: {
      passingThreshold: Number.isFinite(assessment?.passingThreshold) ? Number(assessment.passingThreshold) : 0,
      evaluationCriteria: assessment?.evaluationCriteria && typeof assessment.evaluationCriteria === "object" ? assessment.evaluationCriteria : {},
      scoring: assessment?.scoring && typeof assessment.scoring === "object" ? assessment.scoring : {},
    },
    guidedSteps,
  };
};

export const sanitizeAdventureContent = (content = {}) => {
  const worlds = Array.isArray(content?.worlds) && content.worlds.length
    ? content.worlds.map((world, index) => ({
        id: String(world?.id || `world-${index + 1}`).trim(),
        title: String(world?.title || `World ${index + 1}`).trim(),
        theme: typeof world?.theme === "string" ? world.theme.trim() : "",
        color: typeof world?.color === "string" ? world.color.trim() : "",
        icon: typeof world?.icon === "string" ? world.icon.trim() : "",
        order: Number.isFinite(world?.order) ? Number(world.order) : index + 1,
      }))
    : DEFAULT_CONTENT.worlds;
  const worldIds = new Set(worlds.map((world) => world.id));
  const projects = Array.isArray(content?.projects)
    ? content.projects.map((project, index) => sanitizeProject(project, index, worldIds))
    : [];
  return {
    worlds,
    projects,
    version: Number.isFinite(content?.version) ? Math.max(1, Number(content.version)) : 1,
  };
};

const extractId = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value._id) return value._id.toString();
  return value?.toString?.() || null;
};

const userCanAccessClass = (classroom, user) => {
  const userId = extractId(user?._id || user?.id);
  if (!classroom || !userId) return false;
  if (extractId(classroom.teacher) === userId) return true;
  return Array.isArray(classroom.students) && classroom.students.some((studentValue) => extractId(studentValue) === userId);
};

const ensureClassroomAccess = async (classId, user) => {
  if (!isValidObjectId(classId)) return { error: { status: 400, message: "Invalid classId." } };
  const classroom = await Class.findById(classId).select("teacher students");
  if (!classroom) return { error: { status: 404, message: "Class not found." } };
  if (!userCanAccessClass(classroom, user)) return { error: { status: 403, message: "You are not part of this class." } };
  return { classroom };
};

export const resolveAdventureConfig = (configDoc) => sanitizeAdventureContent(configDoc?.content || {});

export const getClassAdventureConfig = async (req, res) => {
  try {
    const { classId } = req.params;
    const { classroom, error } = await ensureClassroomAccess(classId, req.user);
    if (error) return res.status(error.status).json({ message: error.message });
    if (extractId(classroom.teacher) !== extractId(req.user?._id)) {
      return res.status(403).json({ message: "Only the class teacher can view adventure config." });
    }

    const config = await ClassAdventureConfig.findOne({ classId });
    const resolved = resolveAdventureConfig(config);
    return res.status(200).json({ config: resolved, resolved });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch adventure config.", error: error.message });
  }
};

export const upsertClassAdventureConfig = async (req, res) => {
  try {
    const { classId } = req.params;
    const { classroom, error } = await ensureClassroomAccess(classId, req.user);
    if (error) return res.status(error.status).json({ message: error.message });
    if (extractId(classroom.teacher) !== extractId(req.user?._id)) {
      return res.status(403).json({ message: "Only the class teacher can edit adventure config." });
    }

    const content = sanitizeAdventureContent(req.body?.content || req.body?.overrides || {});
    const updated = await ClassAdventureConfig.findOneAndUpdate(
      { classId },
      {
        classId,
        content,
        createdBy: req.user._id,
        updatedBy: req.user._id,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    return res.status(200).json({
      message: "Adventure configuration saved.",
      config: resolveAdventureConfig(updated),
      resolved: resolveAdventureConfig(updated),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to save adventure config.", error: error.message });
  }
};

export const getResolvedClassAdventure = async (req, res) => {
  try {
    const { classId } = req.params;
    const { error } = await ensureClassroomAccess(classId, req.user);
    if (error) return res.status(error.status).json({ message: error.message });

    const config = await ClassAdventureConfig.findOne({ classId });
    return res.status(200).json({ resolved: resolveAdventureConfig(config) });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch class adventure.", error: error.message });
  }
};

export const getMyClassAdventureProgress = async (req, res) => {
  try {
    const { classId } = req.params;
    const { classroom, error } = await ensureClassroomAccess(classId, req.user);
    if (error) return res.status(error.status).json({ message: error.message });

    const isTeacher = extractId(classroom.teacher) === extractId(req.user?._id);
    const studentId = isTeacher && req.query.studentId ? req.query.studentId : req.user._id;
    if (isTeacher && req.query.studentId && !isValidObjectId(req.query.studentId)) {
      return res.status(400).json({ message: "Invalid studentId." });
    }

    const progress = await ClassAdventureProgress.findOne({ classId, studentId });
    return res.status(200).json({ progress });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch progress.", error: error.message });
  }
};

export const postClassAdventureProgressEvent = async (req, res) => {
  try {
    const { classId } = req.params;
    const { classroom, error } = await ensureClassroomAccess(classId, req.user);
    if (error) return res.status(error.status).json({ message: error.message });
    if (extractId(classroom.teacher) === extractId(req.user?._id)) {
      return res.status(403).json({ message: "Teachers cannot write student progress events." });
    }

    const { eventType, projectSlug, payload = {} } = req.body || {};
    if (!eventType || typeof eventType !== "string") {
      return res.status(400).json({ message: "eventType is required." });
    }
    const progress = await ClassAdventureProgress.findOneAndUpdate(
      { classId, studentId: req.user._id },
      { $setOnInsert: { classId, studentId: req.user._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    if (eventType === "STEP_COMPLETED" && typeof projectSlug === "string") {
      const stepOrder = Number(payload.stepOrder || 0);
      const current = Number(progress.stepProgressByProject.get(projectSlug) || 0);
      if (stepOrder > current) {
        progress.stepProgressByProject.set(projectSlug, stepOrder);
      }
    }

    if (eventType === "PROJECT_COMPLETED" && typeof projectSlug === "string") {
      const alreadyCompleted = progress.completedProjects.some((p) => p.projectSlug === projectSlug);
      if (!alreadyCompleted) {
        const xpEarned = Number(payload.xpEarned || 0);
        progress.completedProjects.push({ projectSlug, xpEarned });
        progress.xp += Math.max(0, xpEarned);
      }
    }

    if (eventType === "QUIZ_SUBMITTED" && typeof projectSlug === "string") {
      const score = Number(payload.score || 0);
      progress.quizAttempts.push({
        projectSlug,
        score: Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0,
        passed: Boolean(payload.passed),
      });
    }

    progress.lastActivityAt = new Date();
    await progress.save();
    return res.status(200).json({ message: "Progress event saved.", progress });
  } catch (error) {
    return res.status(500).json({ message: "Failed to save progress event.", error: error.message });
  }
};

export const getClassAdventureStudentProgress = async (req, res) => {
  try {
    const { classId } = req.params;
    const { classroom, error } = await ensureClassroomAccess(classId, req.user);
    if (error) return res.status(error.status).json({ message: error.message });
    if (extractId(classroom.teacher) !== extractId(req.user?._id)) {
      return res.status(403).json({ message: "Only the class teacher can view class progress." });
    }

    const studentIds = (classroom.students || []).map((studentId) => studentId.toString());
    const [students, progressRows] = await Promise.all([
      User.find({ _id: { $in: studentIds } }).select("_id name email image").lean(),
      ClassAdventureProgress.find({ classId, studentId: { $in: studentIds } }).lean(),
    ]);

    const progressMap = new Map(progressRows.map((row) => [row.studentId.toString(), row]));
    const rows = students.map((student) => {
      const progress = progressMap.get(student._id.toString()) || null;
      const completedProjects = progress?.completedProjects || [];
      return {
        student,
        progress: {
          xp: progress?.xp || 0,
          level: progress?.level || 1,
          completedProjectsCount: completedProjects.length,
          completedProjects,
          lastActivityAt: progress?.lastActivityAt || null,
        },
      };
    });

    return res.status(200).json({
      students: rows,
      summary: {
        totalStudents: rows.length,
        activeStudents: rows.filter((row) => row.progress.completedProjectsCount > 0).length,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch student progress.", error: error.message });
  }
};

export const unlockAdventureComponents = async (req, res) => {
  try {
    const { classId } = req.params;
    const { componentTypes } = req.body;

    const { classroom, error } = await ensureClassroomAccess(classId, req.user);
    if (error) return res.status(error.status).json({ message: error.message });

    if (extractId(classroom.teacher) === extractId(req.user?._id)) {
      return res.status(403).json({ message: "Teachers cannot modify student unlocks." });
    }

    if (!Array.isArray(componentTypes) || componentTypes.length === 0) {
      return res.status(400).json({ message: "componentTypes must be a non-empty array" });
    }

    const progress = await ClassAdventureProgress.findOneAndUpdate(
      { classId, studentId: req.user._id },
      { $setOnInsert: { classId, studentId: req.user._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    let allUnlocked = false;
    for (const type of componentTypes) {
      if (type === '*') {
        allUnlocked = true;
        break;
      }
      const componentType = String(type);
      if (componentType && !progress.unlockedComponents.includes(componentType)) {
        progress.unlockedComponents.push(componentType);
      }
    }

    if (allUnlocked) {
      progress.unlockedComponents = ['*'];
    }

    progress.lastActivityAt = new Date();
    await progress.save();

    return res.status(200).json({
      message: "Components unlocked successfully.",
      unlockedComponents: progress.unlockedComponents,
    });
  } catch (error) {
    console.error("[unlockAdventureComponents]", error);
    return res.status(500).json({ message: "Failed to unlock components.", error: error.message });
  }
};

export const getAdventureUnlocks = async (req, res) => {
  try {
    const { classId } = req.params;
    const { error } = await ensureClassroomAccess(classId, req.user);
    if (error) return res.status(error.status).json({ message: error.message });

    const progress = await ClassAdventureProgress.findOne({ classId, studentId: req.user._id });

    return res.status(200).json({
      unlockedComponents: progress?.unlockedComponents || [],
    });
  } catch (error) {
    console.error("[getAdventureUnlocks]", error);
    return res.status(500).json({ message: "Failed to fetch unlocks.", error: error.message });
  }
};
