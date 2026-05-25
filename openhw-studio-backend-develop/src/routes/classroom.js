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
  getMyAssignmentSubmission,
  upsertAssignmentSubmission,
  getAssignments,
  createNotice,
  updateNotice,
  getClassroomNotices,
  deleteClassroom,
  deleteAssignment,
  deleteNotice,
  uploadClassroomAssets,
  createComment,
  getComments,
  deleteComment
} from "../controllers/classroomController.js";
import { classroomUpload } from "../middleware/classroomUpload.js";

const router = Router();

router.post("/", protectRoute, createClassroom);
router.post("/join", protectRoute, joinClassroomByCode);
router.post("/:classId/invite", protectRoute, inviteStudents);
router.post("/uploads", protectRoute, classroomUpload.array("files", 10), uploadClassroomAssets);
router.get("/", protectRoute, getMyClassrooms);
router.get("/:classId/students", protectRoute, getClassroomStudents);
router.delete("/:classId/students/:studentId", protectRoute, removeClassroomStudent);

router.post("/:classId/assignments", protectRoute, createAssignment);
router.put("/:classId/assignments/:assignmentId", protectRoute, updateAssignment);
router.get("/assignments", protectRoute, getAssignments);
router.get("/:classId/assignments/:assignmentId/submissions", protectRoute, getAssignmentSubmissions);
router.get("/:classId/assignments/:assignmentId/submission", protectRoute, getMyAssignmentSubmission);
router.post("/:classId/assignments/:assignmentId/submission", protectRoute, upsertAssignmentSubmission);
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
