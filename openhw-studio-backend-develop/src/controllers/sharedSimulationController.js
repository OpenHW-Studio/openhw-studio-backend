import crypto from "crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import Assignment from "../models/Assignment.js";
import Class from "../models/Class.js";

function normalizeSharedProject(body = {}) {
  return {
    shareId: crypto.randomBytes(12).toString("hex"),
    name: String(body.name || "Untitled").trim() || "Untitled",
    isPublic: body.isPublic !== false,
    board: body.board || "arduino_uno",
    components: Array.isArray(body.components) ? body.components : [],
    connections: Array.isArray(body.connections) ? body.connections : [],
    code: typeof body.code === "string" ? body.code : "",
    projectFiles: Array.isArray(body.projectFiles) ? body.projectFiles : [],
    openCodeTabs: Array.isArray(body.openCodeTabs) ? body.openCodeTabs : [],
    activeCodeFileId: typeof body.activeCodeFileId === "string" ? body.activeCodeFileId : "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function resolveRequestUser(req) {
  try {
    const authHeader = req.headers.authorization || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

    const cookieHeader = req.headers.cookie || "";
    const jwtCookie = cookieHeader
      .split(";")
      .find((cookie) => cookie.trim().startsWith("jwt="));
    const cookieToken = jwtCookie ? (jwtCookie.split("=")[1] || null) : null;

    const token = bearerToken || cookieToken;
    if (!token) return null;

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("_id");
    return user || null;
  } catch {
    return null;
  }
}

export async function createSharedSimulation(req, res) {
  console.log("[createSharedSimulation] Request user:", req.user);
  try {
    if (req.user?.role === "student") {
      const { classId, assignmentId } = req.body || {};

      if (!mongoose.isValidObjectId(classId) || !mongoose.isValidObjectId(assignmentId)) {
        return res.status(400).json({ message: "Invalid classId or assignmentId." });
      }

      const classroom = await Class.findById(classId).select("students");
      const assignment = await Assignment.findOne({ _id: assignmentId, classId }).select("_id dueDate");
      const isClassStudent = classroom?.students?.some(
        (studentId) => String(studentId) === String(req.user._id)
      );

      if (!classroom || !assignment || !isClassStudent) {
        return res.status(403).json({ message: "Students can only share assignment submissions for their classes." });
      }

      if (assignment.dueDate && new Date(assignment.dueDate) < new Date()) {
        return res.status(400).json({ message: "This assignment is closed. Submissions are no longer accepted." });
      }
    } else if (!["teacher", "user", "admin"].includes(req.user?.role)) {
      return res.status(403).json({ message: "Only teachers, users and admins can share simulator templates." });
    }

    const nextProject = normalizeSharedProject(req.body);
    if (req.user?.role === "student") {
      nextProject.isPublic = true;
    }

    await User.updateOne(
      { _id: req.user._id },
      {
        $push: {
          projects: {
            $each: [nextProject],
            $position: 0,
          },
        },
      }
    );

    return res.status(201).json({
      message: "Simulation shared successfully",
      shareId: nextProject.shareId,
      project: nextProject,
    });
  } catch (error) {
    console.error("[createSharedSimulation]", error);
    return res.status(500).json({ message: "Failed to share simulation" });
  }
}

export async function getSharedSimulation(req, res) {
  try {
    const { shareId } = req.params;
    if (!shareId) {
      return res.status(400).json({ message: "shareId is required" });
    }

    const owner = await User.findOne(
      { "projects.shareId": shareId },
      { projects: { $elemMatch: { shareId } }, name: 1 }
    ).lean();

    const project = owner?.projects?.[0];
    if (!project) {
      return res.status(404).json({ message: "Shared simulation not found" });
    }

    if (!project.isPublic) {
      const requestUser = await resolveRequestUser(req);
      if (!requestUser || String(requestUser._id) !== String(owner._id)) {
        return res.status(403).json({ message: "This shared simulation is private." });
      }
    }

    return res.json({
      project: {
        ...project,
        ownerName: owner.name || "OpenHW Studio User",
      },
    });
  } catch (error) {
    console.error("[getSharedSimulation]", error);
    return res.status(500).json({ message: "Failed to load shared simulation" });
  }
}
