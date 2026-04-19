import mongoose from "mongoose";
import {
  assertLiveSessionAccess,
  createLiveSimulationSession,
  serializeLiveSimulationSession,
} from "../services/liveSimulationService.js";

const normalizeSnapshotPayload = (body = {}) => ({
  name: body.name,
  board: body.board,
  components: body.components,
  connections: body.connections,
  code: body.code,
  projectFiles: body.projectFiles,
  openCodeTabs: body.openCodeTabs,
  activeCodeFileId: body.activeCodeFileId,
});

export async function createLiveSimulation(req, res) {
  try {
    if (req.user?.role !== "teacher") {
      return res.status(403).json({ message: "Only teachers can start a live simulation." });
    }

    const { classId } = req.body || {};
    if (!mongoose.isValidObjectId(classId)) {
      return res.status(400).json({ message: "A valid classId is required." });
    }

    const session = await createLiveSimulationSession({
      classId,
      teacher: req.user,
      snapshot: normalizeSnapshotPayload(req.body),
    });

    return res.status(201).json({
      message: "Live simulation started successfully.",
      session: await serializeLiveSimulationSession(session.sessionCode),
    });
  } catch (error) {
    console.error("[createLiveSimulation]", error);
    return res.status(error?.status || 500).json({
      message: error?.message || "Failed to start live simulation.",
    });
  }
}

export async function getLiveSimulation(req, res) {
  try {
    const { sessionCode } = req.params;
    await assertLiveSessionAccess(sessionCode, req.user);
    const session = await serializeLiveSimulationSession(sessionCode);

    if (!session) {
      return res.status(404).json({ message: "Live simulation session not found." });
    }

    return res.json({ session });
  } catch (error) {
    console.error("[getLiveSimulation]", error);
    return res.status(error?.status || 500).json({
      message: error?.message || "Failed to load live simulation.",
    });
  }
}
