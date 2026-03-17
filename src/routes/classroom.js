import { Router } from "express";
import { protectRoute } from "../middleware/authMiddleware.js";
import {
  createClassroom,
  joinClassroomByCode,
  inviteStudents,
  getMyClassrooms,
  getClassroomById,
  getClassroomStudents,
  removeClassroomStudent,
  updateClassroom,
  createAssignment,
  updateAssignment,
  getAssignmentSubmissions,
  getAssignments,
  createNotice,
  updateNotice,
  getClassroomNotices,
  deleteClassroom,
  deleteAssignment,
  deleteNotice,
  createComment,
  getComments,
  deleteComment
} from "../controllers/classroomController.js";

const router = Router();

router.post("/", protectRoute, createClassroom);
router.post("/join", protectRoute, joinClassroomByCode);
router.post("/:classId/invite", protectRoute, inviteStudents);
router.get("/", protectRoute, getMyClassrooms);
router.get("/:classId/students", protectRoute, getClassroomStudents);
router.delete("/:classId/students/:studentId", protectRoute, removeClassroomStudent);

router.post("/:classId/assignments", protectRoute, createAssignment);
router.put("/:classId/assignments/:assignmentId", protectRoute, updateAssignment);
router.get("/assignments", protectRoute, getAssignments);
router.get("/:classId/assignments/:assignmentId/submissions", protectRoute, getAssignmentSubmissions);
router.delete("/:classId/assignments/:assignmentId", protectRoute, deleteAssignment);

router.post("/:classId/notices", protectRoute, createNotice);
router.put("/:classId/notices/:noticeId", protectRoute, updateNotice);
router.get("/:classId/notices", protectRoute, getClassroomNotices);
router.delete("/:classId/notices/:noticeId", protectRoute, deleteNotice);

router.post("/:classId/comments", protectRoute, createComment);
router.get("/:classId/comments", protectRoute, getComments);
router.delete("/:classId/comments/:commentId", protectRoute, deleteComment);

router.get("/:classId", protectRoute, getClassroomById);
router.put("/:classId", protectRoute, updateClassroom);
router.delete("/:classId", protectRoute, deleteClassroom);

export default router;
