import mongoose from "mongoose";
import ProjectBank from "../models/ProjectBank.js";
import { protectRoute } from "../middleware/authMiddleware.js";

const { ObjectId } = mongoose.Types;

const isValidObjectId = (id) => ObjectId.isValid(id);

const extractId = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value._id) return value._id.toString();
  return value?.toString?.() || null;
};

export const getMyProjectBank = async (req, res) => {
  try {
    const { user } = req;
    const projects = await ProjectBank.find({ owner: user._id }).sort({ createdAt: -1 });
    return res.status(200).json({ projects });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch project bank.", error: error.message });
  }
};

export const getSharedProjectBank = async (req, res) => {
  try {
    const projects = await ProjectBank.find({ visibility: "published" }).sort({ createdAt: -1 });
    return res.status(200).json({ projects });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch shared projects.", error: error.message });
  }
};

export const createProjectBankEntry = async (req, res) => {
  try {
    const { user } = req;
    const {
      slug,
      title,
      description = "",
      visibility = "personal",
      difficulty = "beginner",
      tags = [],
      estimatedTime = "30 min",
      board = "arduino",
      theory = [],
      quizQuestions = [],
      guidedSteps = [],
      assessment = {},
      rewardComponents = [],
      components = [],
      starterCode = "",
    } = req.body;

    if (!slug || !title) {
      return res.status(400).json({ message: "slug and title are required." });
    }

    const existing = await ProjectBank.findOne({ owner: user._id, slug });
    if (existing) {
      return res.status(409).json({ message: "Project with this slug already exists." });
    }

    const project = await ProjectBank.create({
      owner: user._id,
      slug,
      title,
      description,
      visibility,
      difficulty,
      tags,
      estimatedTime,
      board,
      theory,
      quizQuestions,
      guidedSteps,
      assessment,
      rewardComponents,
      components,
      starterCode,
    });

    return res.status(201).json({ message: "Project created.", project });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Project with this slug already exists." });
    }
    return res.status(500).json({ message: "Failed to create project.", error: error.message });
  }
};

export const importToProjectBank = async (req, res) => {
  try {
    const { user } = req;
    const { projectData, slug, title, description, difficulty, tags, estimatedTime, board } = req.body;

    if (!projectData) {
      return res.status(400).json({ message: "projectData is required." });
    }

    const generatedSlug = slug || projectData?.slug || `imported-${Date.now()}`;
    const generatedTitle = title || projectData?.title || "Imported Project";

    const existing = await ProjectBank.findOne({ owner: user._id, slug: generatedSlug });
    if (existing) {
      return res.status(409).json({ message: "Project with this slug already exists." });
    }

    const project = await ProjectBank.create({
      owner: user._id,
      slug: generatedSlug,
      title: generatedTitle,
      description: description || "",
      difficulty: difficulty || "beginner",
      tags: tags || [],
      estimatedTime: estimatedTime || "30 min",
      board: board || projectData?.board || "arduino",
      theory: projectData?.theory || [],
      quizQuestions: projectData?.quizQuestions || [],
      guidedSteps: projectData?.guidedSteps || [],
      assessment: projectData?.assessment || {},
      rewardComponents: projectData?.rewardComponents || [],
      components: projectData?.components || [],
      starterCode: projectData?.starterCode || "",
    });

    return res.status(201).json({ message: "Project imported.", project });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Project with this slug already exists." });
    }
    return res.status(500).json({ message: "Failed to import project.", error: error.message });
  }
};

export const duplicateProjectBankEntry = async (req, res) => {
  try {
    const { user } = req;
    const { projectId } = req.params;

    if (!isValidObjectId(projectId)) {
      return res.status(400).json({ message: "Invalid projectId." });
    }

    const source = await ProjectBank.findById(projectId);
    if (!source) {
      return res.status(404).json({ message: "Source project not found." });
    }

    const newSlug = `${source.slug}-copy-${Date.now()}`;

    const project = await ProjectBank.create({
      owner: user._id,
      slug: newSlug,
      title: `${source.title} (Copy)`,
      description: source.description,
      difficulty: source.difficulty,
      tags: source.tags,
      estimatedTime: source.estimatedTime,
      board: source.board,
      theory: source.theory,
      quizQuestions: source.quizQuestions,
      guidedSteps: source.guidedSteps,
      assessment: source.assessment,
      rewardComponents: source.rewardComponents,
      components: source.components,
      starterCode: source.starterCode,
    });

    return res.status(201).json({ message: "Project duplicated.", project });
  } catch (error) {
    return res.status(500).json({ message: "Failed to duplicate project.", error: error.message });
  }
};

export const updateProjectBankEntry = async (req, res) => {
  try {
    const { user } = req;
    const { projectId } = req.params;
    const updates = req.body;

    if (!isValidObjectId(projectId)) {
      return res.status(400).json({ message: "Invalid projectId." });
    }

    const project = await ProjectBank.findOne({ _id: projectId, owner: user._id });
    if (!project) {
      return res.status(404).json({ message: "Project not found or not owned by you." });
    }

    const allowedFields = [
      "title", "description", "visibility", "difficulty", "tags", "estimatedTime", "board",
      "theory", "quizQuestions", "guidedSteps", "assessment", "rewardComponents",
      "components", "starterCode"
    ];

    allowedFields.forEach(field => {
      if (updates[field] !== undefined) {
        project[field] = updates[field];
      }
    });

    await project.save();

    return res.status(200).json({ message: "Project updated.", project });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Project slug conflicts with another project." });
    }
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: "Project update failed validation.", details: error.message });
    }
    return res.status(500).json({ message: "Failed to update project.", error: error.message });
  }
};

export const deleteProjectBankEntry = async (req, res) => {
  try {
    const { user } = req;
    const { projectId } = req.params;

    if (!isValidObjectId(projectId)) {
      return res.status(400).json({ message: "Invalid projectId." });
    }

    const project = await ProjectBank.findOneAndDelete({ _id: projectId, owner: user._id });
    if (!project) {
      return res.status(404).json({ message: "Project not found or not owned by you." });
    }

    return res.status(200).json({ message: "Project deleted." });
  } catch (error) {
    return res.status(500).json({ message: "Failed to delete project.", error: error.message });
  }
};

export const publishProjectBankEntry = async (req, res) => {
  try {
    const { user } = req;
    const { projectId } = req.params;

    if (!isValidObjectId(projectId)) {
      return res.status(400).json({ message: "Invalid projectId." });
    }

    const project = await ProjectBank.findOne({ _id: projectId, owner: user._id });
    if (!project) {
      return res.status(404).json({ message: "Project not found or not owned by you." });
    }

    project.visibility = "published";
    await project.save();

    return res.status(200).json({ message: "Project published to shared bank.", project });
  } catch (error) {
    return res.status(500).json({ message: "Failed to publish project.", error: error.message });
  }
};

export const unpublishProjectBankEntry = async (req, res) => {
  try {
    const { user } = req;
    const { projectId } = req.params;

    if (!isValidObjectId(projectId)) {
      return res.status(400).json({ message: "Invalid projectId." });
    }

    const project = await ProjectBank.findOne({ _id: projectId, owner: user._id });
    if (!project) {
      return res.status(404).json({ message: "Project not found or not owned by you." });
    }

    project.visibility = "personal";
    await project.save();

    return res.status(200).json({ message: "Project unpublished.", project });
  } catch (error) {
    return res.status(500).json({ message: "Failed to unpublish project.", error: error.message });
  }
};

export const getProjectById = async (req, res) => {
  try {
    const { projectId } = req.params;

    if (!isValidObjectId(projectId)) {
      return res.status(400).json({ message: "Invalid projectId." });
    }

    const project = await ProjectBank.findById(projectId).lean();
    if (!project) {
      return res.status(404).json({ message: "Project not found." });
    }

    return res.status(200).json({ project });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch project.", error: error.message });
  }
};

export const getProjectBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const project = await ProjectBank.findOne({ slug }).lean();

    if (!project) {
      return res.status(404).json({ message: "Project not found." });
    }

    return res.status(200).json({ project });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch project.", error: error.message });
  }
};