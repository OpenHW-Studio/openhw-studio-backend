import CommunityProject from "../models/CommunityProject.js";

export const publishProject = async (req, res) => {
  try {
    const { name, description, board, components, connections, code, thumbnail } = req.body;
    if (!name) {
      return res.status(400).json({ message: "Project name is required" });
    }
    const project = await CommunityProject.create({
      name,
      description: description || "",
      board: board || "arduino_uno",
      components: components || [],
      connections: connections || [],
      code: code || "",
      thumbnail: thumbnail || "",
      publishedBy: req.user._id,
      publishedByName: req.user.name || "Unknown",
    });
    return res.status(201).json({ success: true, project });
  } catch (error) {
    return res.status(500).json({ message: "Failed to publish project", error: error.message });
  }
};

export const listCommunityProjects = async (req, res) => {
  try {
    const projects = await CommunityProject.find()
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return res.json({ success: true, projects });
  } catch (error) {
    return res.status(500).json({ message: "Failed to list projects", error: error.message });
  }
};

export const updateProjectName = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Project name is required" });
    }
    const project = await CommunityProject.findById(id);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    if (project.publishedBy.toString() !== req.user._id.toString() && req.user.role !== "admin") {
      return res.status(403).json({ message: "Not authorized" });
    }
    project.name = name.trim();
    await project.save();
    return res.json({ success: true, project });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update project", error: error.message });
  }
};

export const unpublishProject = async (req, res) => {
  try {
    const { id } = req.params;
    const project = await CommunityProject.findById(id);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    if (project.publishedBy.toString() !== req.user._id.toString() && req.user.role !== "admin") {
      return res.status(403).json({ message: "Not authorized to unpublish this project" });
    }
    await CommunityProject.findByIdAndDelete(id);
    return res.json({ success: true, message: "Project unpublished" });
  } catch (error) {
    return res.status(500).json({ message: "Failed to unpublish project", error: error.message });
  }
};
