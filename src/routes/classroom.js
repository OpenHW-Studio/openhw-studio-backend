import { Router } from "express";
import { protectRoute } from "../middleware/authMiddleware.js";
import {
  createClassroom,
  inviteStudents,
  getMyClassrooms,
  createAssignment,
  getAssignments,
  createNotice,
  getClassroomNotices
} from "../controllers/classroomController.js";

const router = Router();

router.post("/", protectRoute, createClassroom);
router.post("/:classId/invite", protectRoute, inviteStudents);
router.get("/", protectRoute, getMyClassrooms);

router.post("/:classId/assignments", protectRoute, createAssignment);
router.get("/assignments", protectRoute, getAssignments);

router.post("/:classId/notices", protectRoute, createNotice);
router.get("/:classId/notices", protectRoute, getClassroomNotices);

export default router;
