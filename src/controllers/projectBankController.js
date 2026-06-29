import mongoose from "mongoose";
import ProjectBank from "../models/ProjectBank.js";
import { protectRoute } from "../middleware/authMiddleware.js";

const { ObjectId } = mongoose.Types;

const BOARD_ID_ALIASES = {
  arduino_uno: "arduino-uno",
  arduino_nano: "arduino-nano",
  arduino_mega: "arduino-mega",
  pico_w: "pico-w",
  picow: "pico-w",
  raspberry_pi_pico: "raspberry-pi-pico",
  raspberry_pi_pico_w: "raspberry-pi-pico-w",
  esp32_s3: "esp32-s3",
  esp32_c3: "esp32-c3",
};

const BOARD_HINTS = [
  "arduino",
  "arduino-uno",
  "arduino-nano",
  "arduino-mega",
  "pico-w",
  "pico",
  "raspberry-pi-pico-w",
  "raspberry-pi-pico",
  "esp32-s3",
  "esp32-c3",
  "esp32",
  "stm32",
];

const normalizeBoardId = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const cleaned = raw.replace(/^openhw-/, "").replace(/^wokwi-/, "").replace(/^board-/, "");
  const compact = cleaned.replace(/[_\s]+/g, "-");
  return BOARD_ID_ALIASES[cleaned] || BOARD_ID_ALIASES[compact] || compact;
};

const extractBoardIds = (items = []) => {
  const boards = [];
  for (const item of Array.isArray(items) ? items : []) {
    const candidates = [
      item?.board,
      item?.type,
      item?.id,
      item?.name,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeBoardId(candidate);
      if (normalized && BOARD_HINTS.some((hint) => normalized.includes(hint) || hint.includes(normalized))) {
        boards.push(normalized);
        break;
      }
    }
  }
  return [...new Set(boards)];
};

const extractBoardFromComponents = (components = []) => {
  const ids = extractBoardIds(components);
  if (ids.length > 0) return ids[0];
  for (const component of Array.isArray(components) ? components : []) {
    const candidate = normalizeBoardId(component?.type || component?.id || component?.name);
    if (candidate && BOARD_HINTS.some((hint) => candidate.includes(hint) || hint.includes(candidate))) {
      return candidate;
    }
  }
  return "";
};

const resolveStoredBoard = ({ board, rewardComponents = [], components = [] }) => {
  const rewardBoards = extractBoardIds(rewardComponents);
  const boardFromField = normalizeBoardId(board);
  const componentBoard = extractBoardFromComponents(components);
  return rewardBoards[0] || boardFromField || componentBoard || "";
};

const enrichProjectBankEntry = (entry) => {
  const project = entry?.toObject?.() || entry || {};
  const rewardBoards = extractBoardIds(project.rewardComponents);
  const componentBoard = extractBoardFromComponents(project.components);
  const board = normalizeBoardId(project.board) || rewardBoards[0] || componentBoard || "";
  const boards = [...new Set([board, ...rewardBoards, componentBoard].filter(Boolean))];

  return {
    ...project,
    board,
    boards,
  };
};

const buildSearchBlob = (project) => {
  const rewardTexts = Array.isArray(project.rewardComponents)
    ? project.rewardComponents.flatMap((component) => [
        component?.id,
        component?.type,
        component?.name,
        component?.description,
      ])
    : [];
  const componentTexts = Array.isArray(project.components)
    ? project.components.flatMap((component) => [
        component?.id,
        component?.type,
        component?.label,
      ])
    : [];

  return [
    project.title,
    project.slug,
    project.description,
    project.difficulty,
    project.estimatedTime,
    project.board,
    ...(project.boards || []),
    ...(project.tags || []),
    ...rewardTexts,
    ...componentTexts,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
};

const applyProjectBankFilters = (projects, { search, board } = {}) => {
  const searchQuery = String(search || "").trim().toLowerCase();
  const boardFilter = normalizeBoardId(board);
  return projects.filter((project) => {
    if (boardFilter) {
      const projectBoards = [...new Set([
        normalizeBoardId(project.board),
        ...(project.boards || []).map(normalizeBoardId),
      ].filter(Boolean))];
      if (!projectBoards.includes(boardFilter)) return false;
    }

    if (!searchQuery) return true;
    return buildSearchBlob(project).includes(searchQuery);
  });
};

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
    const { search = "", board = "" } = req.query;
    const projects = await ProjectBank.find({ owner: user._id }).sort({ createdAt: -1 }).lean();
    const filtered = applyProjectBankFilters(projects.map(enrichProjectBankEntry), { search, board });
    return res.status(200).json({ projects: filtered });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch project bank.", error: error.message });
  }
};

export const getSharedProjectBank = async (req, res) => {
  try {
    const { search = "", board = "" } = req.query;
    const projects = await ProjectBank.find({ visibility: "published" }).sort({ createdAt: -1 }).lean();
    const filtered = applyProjectBankFilters(projects.map(enrichProjectBankEntry), { search, board });
    return res.status(200).json({ projects: filtered });
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
      board = "",
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
      board: resolveStoredBoard({ board, rewardComponents, components }),
      theory,
      quizQuestions,
      guidedSteps,
      assessment,
      rewardComponents,
      components,
      starterCode,
    });

    return res.status(201).json({ message: "Project created.", project: enrichProjectBankEntry(project) });
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
      board: resolveStoredBoard({
        board: board || projectData?.board,
        rewardComponents: projectData?.rewardComponents || [],
        components: projectData?.components || [],
      }),
      theory: projectData?.theory || [],
      quizQuestions: projectData?.quizQuestions || [],
      guidedSteps: projectData?.guidedSteps || [],
      assessment: projectData?.assessment || {},
      rewardComponents: projectData?.rewardComponents || [],
      components: projectData?.components || [],
      starterCode: projectData?.starterCode || "",
    });

    return res.status(201).json({ message: "Project imported.", project: enrichProjectBankEntry(project) });
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
      board: resolveStoredBoard({
        board: source.board,
        rewardComponents: source.rewardComponents,
        components: source.components,
      }),
      theory: source.theory,
      quizQuestions: source.quizQuestions,
      guidedSteps: source.guidedSteps,
      assessment: source.assessment,
      rewardComponents: source.rewardComponents,
      components: source.components,
      starterCode: source.starterCode,
    });

    return res.status(201).json({ message: "Project duplicated.", project: enrichProjectBankEntry(project) });
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
        if (field === "board") {
          project[field] = resolveStoredBoard({
            board: updates.board,
            rewardComponents: updates.rewardComponents || project.rewardComponents,
            components: updates.components || project.components,
          });
        } else {
          project[field] = updates[field];
        }
      }
    });

    project.board = resolveStoredBoard({
      board: project.board,
      rewardComponents: project.rewardComponents,
      components: project.components,
    });

    await project.save();

    return res.status(200).json({ message: "Project updated.", project: enrichProjectBankEntry(project) });
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

    return res.status(200).json({ message: "Project published to shared bank.", project: enrichProjectBankEntry(project) });
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

    return res.status(200).json({ message: "Project unpublished.", project: enrichProjectBankEntry(project) });
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

    return res.status(200).json({ project: enrichProjectBankEntry(project) });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch project.", error: error.message });
  }
};

export const getProjectBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const userId = req.user?._id;
    const project =
      (userId ? await ProjectBank.findOne({ owner: userId, slug }).lean() : null) ||
      await ProjectBank.findOne({ slug, visibility: "published" }).lean();

    if (!project) {
      return res.status(404).json({ message: "Project not found." });
    }

    return res.status(200).json({ project: enrichProjectBankEntry(project) });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch project.", error: error.message });
  }
};
