import Project from "../models/Project.js";

export const saveProject = async (req, res) => {
  try {
    const { projectId, name, board, components, connections, wires, code, blocklyXml, blocklyGeneratedCode, useBlocklyCode, projectFiles, openCodeTabs, activeCodeFileId, thumbnail, savedAt } = req.body;
    if (!projectId) {
      return res.status(400).json({ message: "projectId is required" });
    }
    const project = await Project.findOneAndUpdate(
      { projectId, userId: req.user._id },
      {
        userId: req.user._id,
        projectId,
        name: name || "Untitled",
        board: board || "arduino_uno",
        components: components || [],
        connections: connections || [],
        wires: wires || [],
        code: code || "",
        blocklyXml: blocklyXml || "",
        blocklyGeneratedCode: blocklyGeneratedCode || "",
        useBlocklyCode: !!useBlocklyCode,
        projectFiles: projectFiles || [],
        openCodeTabs: openCodeTabs || [],
        activeCodeFileId: activeCodeFileId || "",
        thumbnail: thumbnail || "",
        savedAt: savedAt || Date.now(),
      },
      { upsert: true, new: true }
    );
    return res.status(200).json({ success: true, project });
  } catch (error) {
    return res.status(500).json({ message: "Failed to save project", error: error.message });
  }
};

export const listProjects = async (req, res) => {
  try {
    const projects = await Project.find({ userId: req.user._id })
      .sort({ savedAt: -1 })
      .limit(50)
      .lean();
    return res.json({ success: true, projects });
  } catch (error) {
    return res.status(500).json({ message: "Failed to list projects", error: error.message });
  }
};

export const getProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await Project.findOne({ projectId, userId: req.user._id }).lean();
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    return res.json({ success: true, project });
  } catch (error) {
    return res.status(500).json({ message: "Failed to get project", error: error.message });
  }
};

export const deleteProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await Project.findOneAndDelete({ projectId, userId: req.user._id });
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    return res.json({ success: true, message: "Project deleted" });
  } catch (error) {
    return res.status(500).json({ message: "Failed to delete project", error: error.message });
  }
};

export const renameProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Name is required" });
    }
    const project = await Project.findOneAndUpdate(
      { projectId, userId: req.user._id },
      { name: name.trim(), savedAt: Date.now() },
      { new: true }
    );
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    return res.json({ success: true, project });
  } catch (error) {
    return res.status(500).json({ message: "Failed to rename project", error: error.message });
  }
};
