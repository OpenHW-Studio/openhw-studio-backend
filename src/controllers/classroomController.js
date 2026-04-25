import mongoose from "mongoose";
import Class from "../models/Class.js";
import Assignment from "../models/Assignment.js";
import Notice from "../models/Notice.js";
import Comment from "../models/Comment.js";
import Submission from "../models/Submission.js";
import User from "../models/User.js";
import { getClassroomAssetPublicPath } from "../middleware/classroomUpload.js";
//enhanced
const { ObjectId } = mongoose.Types;

const isTeacher = (user) => user?.role === "teacher";
const isValidObjectId = (id) => ObjectId.isValid(id);

const extractId = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (value._id) return value._id.toString();
    if (typeof value.toString === "function") return value.toString();
  }
  return null;
};

const generateJoinCode = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

const createUniqueJoinCode = async () => {
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const joinCode = generateJoinCode();
    const existing = await Class.findOne({ joinCode }).select("_id");
    if (!existing) return joinCode;
  }
  throw new Error("Failed to generate unique join code");
};

const userCanAccessClass = (classroom, user) => {
  const userId = extractId(user?._id || user?.id);
  if (!userId || !classroom) return false;

  const isOwner = extractId(classroom.teacher) === userId;
  const isStudent =
    Array.isArray(classroom.students) &&
    classroom.students.some((studentValue) => extractId(studentValue) === userId);

  return isOwner || isStudent;
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
};

export const createClassroom = async (req, res) => {
  try {
    if (!isTeacher(req.user)) {
      return res
        .status(403)
        .json({ message: "Only teachers can create classes." });
    }

    const { name, bio, image } = req.body || {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ message: "Class name is required." });
    }

    const joinCode = await createUniqueJoinCode();
    const classroom = await Class.create({
      name: name.trim(),
      bio: typeof bio === "string" && bio.trim() ? bio.trim() : undefined,
      image: typeof image === "string" && image.trim() ? image.trim() : undefined,
      teacher: req.user._id,
      joinCode,
    });

    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { classes: classroom._id },
    });

    return res.status(201).json({
      message: "Class created successfully.",
      classroom,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to create class.", error: error.message });
  }
};

export const inviteStudents = async (req, res) => {
  try {
    const { classId } = req.params;
    const { studentIds = [], emails = [] } = req.body || {};

    if (!isValidObjectId(classId)) {
      return res.status(400).json({ message: "Invalid classId." });
    }

    const classroom = await Class.findById(classId);
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (classroom.teacher.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Only the class teacher can invite students." });
    }

    const normalizedStudentIds = Array.isArray(studentIds)
      ? studentIds.filter((id) => typeof id === "string" && isValidObjectId(id))
      : [];
    const normalizedEmails = Array.isArray(emails)
      ? emails
          .filter((email) => typeof email === "string" && email.trim())
          .map((email) => email.trim().toLowerCase())
      : [];

    if (!normalizedStudentIds.length && !normalizedEmails.length) {
      return res.status(400).json({
        message: "Provide at least one student via studentIds or emails.",
      });
    }

    const students = await User.find({
      role: "student",
      $or: [
        ...(normalizedStudentIds.length
          ? [{ _id: { $in: normalizedStudentIds } }]
          : []),
        ...(normalizedEmails.length
          ? [{ email: { $in: normalizedEmails } }]
          : []),
      ],
    }).select("_id name email role");

    if (!students.length) {
      return res.status(404).json({ message: "No matching students found." });
    }

    const studentObjectIds = students.map((student) => student._id);

    const updatedClassroom = await Class.findByIdAndUpdate(
      classId,
      { $addToSet: { students: { $each: studentObjectIds } } },
      { new: true },
    )
      .populate("teacher", "name email role bio image")
      .populate("students", "name email role image");

    await User.updateMany(
      { _id: { $in: studentObjectIds } },
      { $addToSet: { classes: classId } },
    );

    return res.status(200).json({
      message: "Students invited successfully.",
      invitedCount: studentObjectIds.length,
      classroom: updatedClassroom,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to invite students.", error: error.message });
  }
};

export const getMyClassrooms = async (req, res) => {
  try {
    let query = {};

    if (req.user.role === "teacher") {
      query = { teacher: req.user._id };
    } else if (req.user.role === "student") {
      query = { students: req.user._id };
    }

    const classrooms = await Class.find(query)
      .populate("teacher", "name email role bio image")
      .populate("students", "name email role image")
      .sort({ createdAt: -1 });

    return res.status(200).json({ classrooms });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to fetch classrooms.", error: error.message });
  }
};

export const getClassroomById = async (req, res) => {
  try {
    const { classId } = req.params;

    if (!isValidObjectId(classId)) {
      return res.status(400).json({ message: "Invalid classId." });
    }

    const classroom = await Class.findById(classId)
      .populate("teacher", "name email role bio image")
      .populate("students", "name email role image")
      .populate("assignments")
      .populate({
        path: "notices",
        populate: { path: "createdBy", select: "name email role image" },
      });

    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (!userCanAccessClass(classroom, req.user)) {
      return res
        .status(403)
        .json({ message: "You are not part of this class." });
    }

    return res.status(200).json({ classroom });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to fetch class details.", error: error.message });
  }
};

export const getClassroomStudents = async (req, res) => {
  try {
    const { classId } = req.params;

    if (!isValidObjectId(classId)) {
      return res.status(400).json({ message: "Invalid classId." });
    }

    const classroom = await Class.findById(classId)
      .select("teacher students")
      .populate("teacher", "name email role")
      .populate("students", "name email role image");

    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (!userCanAccessClass(classroom, req.user)) {
      return res
        .status(403)
        .json({ message: "You are not part of this class." });
    }

    return res.status(200).json({
      students: classroom.students || [],
      count: classroom.students?.length || 0,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to fetch students.", error: error.message });
  }
};

export const removeClassroomStudent = async (req, res) => {
  try {
    const { classId, studentId } = req.params;

    if (!isValidObjectId(classId) || !isValidObjectId(studentId)) {
      return res.status(400).json({ message: "Invalid classId or studentId." });
    }

    const classroom = await Class.findById(classId).select("teacher students");
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (classroom.teacher.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Only the class teacher can remove students." });
    }

    const alreadyInClass = classroom.students.some(
      (studentObjectId) => studentObjectId.toString() === studentId,
    );

    if (!alreadyInClass) {
      return res.status(404).json({ message: "Student is not in this class." });
    }

    const updatedClassroom = await Class.findByIdAndUpdate(
      classId,
      { $pull: { students: studentId } },
      { new: true },
    ).populate("students", "name email role image");

    await User.findByIdAndUpdate(studentId, {
      $pull: { classes: classId },
    });

    return res.status(200).json({
      message: "Student removed from class.",
      students: updatedClassroom?.students || [],
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to remove student.", error: error.message });
  }
};

export const getAssignmentSubmissions = async (req, res) => {
  try {
    const { classId, assignmentId } = req.params;

    if (!isValidObjectId(classId) || !isValidObjectId(assignmentId)) {
      return res.status(400).json({ message: "Invalid classId or assignmentId." });
    }

    const classroom = await Class.findById(classId).select("teacher students");
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (classroom.teacher.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Only the class teacher can view submissions." });
    }

    const assignment = await Assignment.findOne({ _id: assignmentId, classId }).select(
      "_id title dueDate createdAt",
    );

    if (!assignment) {
      return res.status(404).json({ message: "Assignment not found." });
    }

    const submissions = await Submission.find({ assignmentId })
      .populate("studentId", "name email role image")
      .populate("projectId", "_id board updatedAt createdAt")
      .sort({ updatedAt: -1 });

    const classStudentCount = classroom.students?.length || 0;

    return res.status(200).json({
      assignment,
      submissions,
      stats: {
        submittedCount: submissions.length,
        classStudentCount,
        missingCount: Math.max(classStudentCount - submissions.length, 0),
      },
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to fetch assignment submissions.",
      error: error.message,
    });
  }
};

export const updateClassroom = async (req, res) => {
  try {
    const { classId } = req.params;
    const { name, bio, image } = req.body || {};

    if (!isValidObjectId(classId)) {
      return res.status(400).json({ message: "Invalid classId." });
    }

    const classroom = await Class.findById(classId);
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (classroom.teacher.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Only the class teacher can update this class." });
    }

    const updates = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ message: "Class name is required." });
      }
      updates.name = name.trim();
    }

    if (bio !== undefined) {
      updates.bio = typeof bio === "string" && bio.trim() ? bio.trim() : "";
    }

    if (image !== undefined) {
      updates.image =
        typeof image === "string" && image.trim() ? image.trim() : "";
    }

    const updatedClassroom = await Class.findByIdAndUpdate(classId, updates, {
      new: true,
      runValidators: true,
    })
      .populate("teacher", "name email role bio image")
      .populate("students", "name email role image")
      .populate("assignments")
      .populate({
        path: "notices",
        populate: { path: "createdBy", select: "name email role image" },
      });

    return res.status(200).json({
      message: "Class updated successfully.",
      classroom: updatedClassroom,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to update class.", error: error.message });
  }
};

export const joinClassroomByCode = async (req, res) => {
  try {
    if (req.user.role !== "student") {
      return res
        .status(403)
        .json({ message: "Only students can join classes using code." });
    }

    const { joinCode } = req.body || {};
    if (typeof joinCode !== "string" || !joinCode.trim()) {
      return res.status(400).json({ message: "joinCode is required." });
    }

    const normalizedJoinCode = joinCode.trim().toUpperCase();
    const classroom = await Class.findOne({ joinCode: normalizedJoinCode });
    if (!classroom) {
      return res
        .status(404)
        .json({ message: "Class not found for the given join code." });
    }

    if (classroom.teacher.toString() === req.user._id.toString()) {
      return res
        .status(400)
        .json({ message: "Teacher cannot join their own class as student." });
    }

    const alreadyJoined = classroom.students.some(
      (studentId) => studentId.toString() === req.user._id.toString(),
    );

    if (!alreadyJoined) {
      await Class.findByIdAndUpdate(classroom._id, {
        $addToSet: { students: req.user._id },
      });

      await User.findByIdAndUpdate(req.user._id, {
        $addToSet: { classes: classroom._id },
      });
    }

    const updatedClassroom = await Class.findById(classroom._id)
      .populate("teacher", "name email role bio image")
      .populate("students", "name email role image");

    return res.status(200).json({
      message: alreadyJoined
        ? "Already joined this class."
        : "Joined class successfully.",
      classroom: updatedClassroom,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to join classroom.", error: error.message });
  }
};

export const createAssignment = async (req, res) => {
  try {
    if (!isTeacher(req.user)) {
      return res
        .status(403)
        .json({ message: "Only teachers can create assignments." });
    }

    const { classId } = req.params;
    const { title, description, templateProjectId, templateShareId, templateUrl, dueDate, attachments, files, links } = req.body || {};

    if (!isValidObjectId(classId)) {
      return res.status(400).json({ message: "Invalid classId." });
    }

    if (typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ message: "Assignment title is required." });
    }

    const classroom = await Class.findById(classId);
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (classroom.teacher.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Only the class teacher can create assignments." });
    }

    if (dueDate && Number.isNaN(new Date(dueDate).getTime())) {
      return res.status(400).json({ message: "Invalid dueDate format." });
    }

    const rawAttachments = Array.isArray(attachments) ? attachments : files;
    const sanitizedAttachments = Array.isArray(rawAttachments)
      ? rawAttachments.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim())
      : [];
    const sanitizedLinks = Array.isArray(links)
      ? links.filter((link) => typeof link === "string" && link.trim()).map((link) => link.trim())
      : [];
    const sanitizedTemplateUrl = typeof templateUrl === "string" ? templateUrl.trim() : "";
    const sanitizedTemplateShareId = typeof templateShareId === "string" && templateShareId.trim()
      ? templateShareId.trim()
      : (sanitizedTemplateUrl.match(/\/simulator\/share\/([^/?#]+)/)?.[1] || "");

    const assignment = await Assignment.create({
      classId,
      title: title.trim(),
      description:
        typeof description === "string" ? description.trim() : undefined,
      templateProjectId: isValidObjectId(templateProjectId)
        ? templateProjectId
        : undefined,
      templateShareId: sanitizedTemplateShareId || undefined,
      templateUrl: sanitizedTemplateUrl || undefined,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      links: sanitizedLinks,
      attachments: sanitizedAttachments,
      createdBy: req.user._id,
    });

    await Class.findByIdAndUpdate(classId, {
      $addToSet: { assignments: assignment._id },
    });

    return res.status(201).json({
      message: "Assignment created successfully.",
      assignment,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to create assignment.", error: error.message });
  }
};

export const getAssignments = async (req, res) => {
  try {
    const { classId, page, limit, search, fromDueDate, toDueDate } = req.query;
    const pageNumber = parsePositiveInt(page, 1);
    const limitNumber = Math.min(parsePositiveInt(limit, 10), 100);
    const skip = (pageNumber - 1) * limitNumber;

    const filters = {};
    if (typeof search === "string" && search.trim()) {
      filters.$or = [
        { title: { $regex: search.trim(), $options: "i" } },
        { description: { $regex: search.trim(), $options: "i" } },
      ];
    }

    if (fromDueDate || toDueDate) {
      const dueDateFilter = {};
      if (fromDueDate) {
        const parsedFrom = new Date(fromDueDate);
        if (Number.isNaN(parsedFrom.getTime())) {
          return res
            .status(400)
            .json({ message: "Invalid fromDueDate format." });
        }
        dueDateFilter.$gte = parsedFrom;
      }
      if (toDueDate) {
        const parsedTo = new Date(toDueDate);
        if (Number.isNaN(parsedTo.getTime())) {
          return res.status(400).json({ message: "Invalid toDueDate format." });
        }
        dueDateFilter.$lte = parsedTo;
      }
      filters.dueDate = dueDateFilter;
    }

    if (classId) {
      if (!isValidObjectId(classId)) {
        return res.status(400).json({ message: "Invalid classId." });
      }

      const classroom =
        await Class.findById(classId).select("teacher students");
      if (!classroom) {
        return res.status(404).json({ message: "Class not found." });
      }

      if (!userCanAccessClass(classroom, req.user)) {
        return res
          .status(403)
          .json({ message: "You are not part of this class." });
      }

      const query = { ...filters, classId };
      const total = await Assignment.countDocuments(query);
      const assignments = await Assignment.find(query)
        .populate("createdBy", "name email role")
        .skip(skip)
        .limit(limitNumber)
        .sort({ createdAt: -1 });

      return res.status(200).json({
        assignments,
        pagination: {
          total,
          page: pageNumber,
          limit: limitNumber,
          totalPages: Math.ceil(total / limitNumber),
        },
      });
    }

    if (req.user.role === "teacher") {
      const query = { ...filters, createdBy: req.user._id };
      const total = await Assignment.countDocuments(query);
      const assignments = await Assignment.find(query)
        .populate("classId", "name joinCode")
        .skip(skip)
        .limit(limitNumber)
        .sort({ createdAt: -1 });

      return res.status(200).json({
        assignments,
        pagination: {
          total,
          page: pageNumber,
          limit: limitNumber,
          totalPages: Math.ceil(total / limitNumber),
        },
      });
    }

    if (req.user.role === "student") {
      const classrooms = await Class.find({ students: req.user._id }).select(
        "_id",
      );
      const classIds = classrooms.map((classroom) => classroom._id);

      const query = { ...filters, classId: { $in: classIds } };
      const total = await Assignment.countDocuments(query);
      const assignments = await Assignment.find(query)
        .populate("classId", "name joinCode")
        .populate("createdBy", "name email role")
        .skip(skip)
        .limit(limitNumber)
        .sort({ createdAt: -1 });

      return res.status(200).json({
        assignments,
        pagination: {
          total,
          page: pageNumber,
          limit: limitNumber,
          totalPages: Math.ceil(total / limitNumber),
        },
      });
    }

    const total = await Assignment.countDocuments(filters);
    const assignments = await Assignment.find(filters)
      .skip(skip)
      .limit(limitNumber)
      .sort({ createdAt: -1 });
    return res.status(200).json({
      assignments,
      pagination: {
        total,
        page: pageNumber,
        limit: limitNumber,
        totalPages: Math.ceil(total / limitNumber),
      },
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to fetch assignments.", error: error.message });
  }
};

export const createNotice = async (req, res) => {
  try {
    if (!isTeacher(req.user)) {
      return res
        .status(403)
        .json({ message: "Only teachers can create notices." });
    }

    const { classId } = req.params;
    const { title, message, attachments, files } = req.body || {};

    if (!isValidObjectId(classId)) {
      return res.status(400).json({ message: "Invalid classId." });
    }

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ message: "Notice message is required." });
    }

    const classroom = await Class.findById(classId);
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (classroom.teacher.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Only the class teacher can create notices." });
    }

    const rawAttachments = Array.isArray(attachments) ? attachments : files;
    const sanitizedAttachments = Array.isArray(rawAttachments)
      ? rawAttachments.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim())
      : [];

    const notice = await Notice.create({
      classId,
      title:
        typeof title === "string" && title.trim() ? title.trim() : "Notice",
      message: message.trim(),
      attachments: sanitizedAttachments,
      createdBy: req.user._id,
    });

    await Class.findByIdAndUpdate(classId, {
      $addToSet: { notices: notice._id },
    });

    return res.status(201).json({
      message: "Notice created successfully.",
      notice,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to create notice.", error: error.message });
  }
};

export const getClassroomNotices = async (req, res) => {
  try {
    const { classId } = req.params;
    const { page, limit, search } = req.query;
    const pageNumber = parsePositiveInt(page, 1);
    const limitNumber = Math.min(parsePositiveInt(limit, 10), 100);
    const skip = (pageNumber - 1) * limitNumber;

    if (!isValidObjectId(classId)) {
      return res.status(400).json({ message: "Invalid classId." });
    }

    const classroom = await Class.findById(classId).select("teacher students");
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (!userCanAccessClass(classroom, req.user)) {
      return res
        .status(403)
        .json({ message: "You are not part of this class." });
    }

    const query = { classId };
    if (typeof search === "string" && search.trim()) {
      query.$or = [
        { title: { $regex: search.trim(), $options: "i" } },
        { message: { $regex: search.trim(), $options: "i" } },
      ];
    }

    const total = await Notice.countDocuments(query);
    const notices = await Notice.find(query)
      .populate("createdBy", "name email role image")
      .skip(skip)
      .limit(limitNumber)
      .sort({ createdAt: -1 });

    return res.status(200).json({
      notices,
      pagination: {
        total,
        page: pageNumber,
        limit: limitNumber,
        totalPages: Math.ceil(total / limitNumber),
      },
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to fetch notices.", error: error.message });
  }
};

export const deleteClassroom = async (req, res) => {
  try {
    const { classId } = req.params;

    if (!isValidObjectId(classId)) {
      return res.status(400).json({ message: "Invalid classId." });
    }

    const classroom = await Class.findById(classId);
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (classroom.teacher.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Only the class teacher can delete this class." });
    }

    await Assignment.deleteMany({ classId });
    await Notice.deleteMany({ classId });

    await User.updateMany(
      { classes: classroom._id },
      { $pull: { classes: classroom._id } },
    );

    await Class.findByIdAndDelete(classId);

    return res.status(200).json({ message: "Class deleted successfully." });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to delete class.", error: error.message });
  }
};

export const deleteAssignment = async (req, res) => {
  try {
    const { classId, assignmentId } = req.params;

    if (!isValidObjectId(classId) || !isValidObjectId(assignmentId)) {
      return res.status(400).json({ message: "Invalid classId or assignmentId." });
    }

    const classroom = await Class.findById(classId);
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (classroom.teacher.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Only the class teacher can delete assignments." });
    }

    const assignment = await Assignment.findOne({ _id: assignmentId, classId });
    if (!assignment) {
      return res.status(404).json({ message: "Assignment not found." });
    }

    await Assignment.findByIdAndDelete(assignmentId);
    await Class.findByIdAndUpdate(classId, {
      $pull: { assignments: assignmentId },
    });

    return res.status(200).json({ message: "Assignment deleted successfully." });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to delete assignment.", error: error.message });
  }
};

export const deleteNotice = async (req, res) => {
  try {
    const { classId, noticeId } = req.params;

    if (!isValidObjectId(classId) || !isValidObjectId(noticeId)) {
      return res.status(400).json({ message: "Invalid classId or noticeId." });
    }

    const classroom = await Class.findById(classId);
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (classroom.teacher.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Only the class teacher can delete notices." });
    }

    const notice = await Notice.findOne({ _id: noticeId, classId });
    if (!notice) {
      return res.status(404).json({ message: "Notice not found." });
    }

    await Notice.findByIdAndDelete(noticeId);
    await Class.findByIdAndUpdate(classId, {
      $pull: { notices: noticeId },
    });

    return res.status(200).json({ message: "Notice deleted successfully." });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to delete notice.", error: error.message });
  }
};

export const updateAssignment = async (req, res) => {
  try {
    if (!isTeacher(req.user)) {
      return res
        .status(403)
        .json({ message: "Only teachers can update assignments." });
    }

    const { classId, assignmentId } = req.params;
    const { title, description, dueDate, attachments, files, links, templateShareId, templateUrl } = req.body || {};

    if (!isValidObjectId(classId) || !isValidObjectId(assignmentId)) {
      return res.status(400).json({ message: "Invalid classId or assignmentId." });
    }

    const classroom = await Class.findById(classId);
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (classroom.teacher.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Only the class teacher can update assignments." });
    }

    const assignment = await Assignment.findOne({ _id: assignmentId, classId });
    if (!assignment) {
      return res.status(404).json({ message: "Assignment not found." });
    }

    const updates = {};
    if (title !== undefined) {
      if (typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ message: "Assignment title is required." });
      }
      updates.title = title.trim();
    }
    if (description !== undefined) {
      updates.description = typeof description === "string" ? description.trim() : "";
    }
    if (dueDate !== undefined) {
      if (dueDate && Number.isNaN(new Date(dueDate).getTime())) {
        return res.status(400).json({ message: "Invalid dueDate format." });
      }
      updates.dueDate = dueDate ? new Date(dueDate) : null;
    }
    if (attachments !== undefined || files !== undefined) {
      const rawAttachments = Array.isArray(attachments) ? attachments : files;
      updates.attachments = Array.isArray(rawAttachments)
        ? rawAttachments.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim())
        : [];
    }
    if (links !== undefined) {
      updates.links = Array.isArray(links)
        ? links.filter((link) => typeof link === "string" && link.trim()).map((link) => link.trim())
        : [];
    }
    if (templateUrl !== undefined || templateShareId !== undefined) {
      const nextTemplateUrl = typeof templateUrl === "string" ? templateUrl.trim() : "";
      updates.templateUrl = nextTemplateUrl;
      updates.templateShareId = typeof templateShareId === "string" && templateShareId.trim()
        ? templateShareId.trim()
        : (nextTemplateUrl.match(/\/simulator\/share\/([^/?#]+)/)?.[1] || "");
    }

    const updatedAssignment = await Assignment.findByIdAndUpdate(
      assignmentId,
      updates,
      { new: true, runValidators: true }
    ).populate("createdBy", "name email role");

    return res.status(200).json({
      message: "Assignment updated successfully.",
      assignment: updatedAssignment,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to update assignment.", error: error.message });
  }
};

export const updateNotice = async (req, res) => {
  try {
    if (!isTeacher(req.user)) {
      return res
        .status(403)
        .json({ message: "Only teachers can update notices." });
    }

    const { classId, noticeId } = req.params;
    const { title, message, attachments, files } = req.body || {};

    if (!isValidObjectId(classId) || !isValidObjectId(noticeId)) {
      return res.status(400).json({ message: "Invalid classId or noticeId." });
    }

    const classroom = await Class.findById(classId);
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (classroom.teacher.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Only the class teacher can update notices." });
    }

    const notice = await Notice.findOne({ _id: noticeId, classId });
    if (!notice) {
      return res.status(404).json({ message: "Notice not found." });
    }

    const updates = {};
    if (title !== undefined) {
      updates.title = typeof title === "string" && title.trim() ? title.trim() : "Notice";
    }
    if (message !== undefined) {
      if (typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ message: "Notice message is required." });
      }
      updates.message = message.trim();
    }
    if (attachments !== undefined || files !== undefined) {
      const rawAttachments = Array.isArray(attachments) ? attachments : files;
      updates.attachments = Array.isArray(rawAttachments)
        ? rawAttachments.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim())
        : [];
    }

    const updatedNotice = await Notice.findByIdAndUpdate(
      noticeId,
      updates,
      { new: true, runValidators: true }
    ).populate("createdBy", "name email role image");

    return res.status(200).json({
      message: "Notice updated successfully.",
      notice: updatedNotice,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to update notice.", error: error.message });
  }
};

export const createComment = async (req, res) => {
  try {
    const { classId } = req.params;
    const { postId, postType, message } = req.body || {};

    if (!isValidObjectId(classId)) {
      return res.status(400).json({ message: "Invalid classId." });
    }

    if (!postId || !isValidObjectId(postId)) {
      return res.status(400).json({ message: "Invalid postId." });
    }

    if (!["assignment", "notice"].includes(postType)) {
      return res.status(400).json({ message: "postType must be 'assignment' or 'notice'." });
    }

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ message: "Comment message is required." });
    }

    const classroom = await Class.findById(classId).select("teacher students");
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (!userCanAccessClass(classroom, req.user)) {
      return res
        .status(403)
        .json({ message: "You are not part of this class." });
    }

    if (req.user?.role === "student" && postType !== "notice") {
      return res
        .status(403)
        .json({ message: "Students can only comment on notices." });
    }

    const targetPost = postType === "assignment"
      ? await Assignment.findOne({ _id: postId, classId }).select("_id")
      : await Notice.findOne({ _id: postId, classId }).select("_id");

    if (!targetPost) {
      return res
        .status(404)
        .json({ message: `${postType} not found in this class.` });
    }

    const comment = await Comment.create({
      classId,
      postId,
      postType,
      message: message.trim(),
      createdBy: req.user._id,
    });

    const populated = await Comment.findById(comment._id)
      .populate("createdBy", "name email role image");

    return res.status(201).json({
      message: "Comment added successfully.",
      comment: populated,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to add comment.", error: error.message });
  }
};

export const uploadClassroomAssets = async (req, res) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ message: "Unauthorized upload request." });
    }

    const files = Array.isArray(req.files) ? req.files : [];

    if (!files.length) {
      return res.status(400).json({ message: "At least one file is required." });
    }

    return res.status(201).json({
      message: "Files uploaded successfully.",
      files: files.map((file) => ({
        name: file.originalname,
        url: getClassroomAssetPublicPath(file.path),
        mimeType: file.mimetype,
        size: file.size,
      })),
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to upload classroom files.",
      error: error.message,
    });
  }
};

export const getMyAssignmentSubmission = async (req, res) => {
  try {
    const { classId, assignmentId } = req.params;

    if (!isValidObjectId(classId) || !isValidObjectId(assignmentId)) {
      return res.status(400).json({ message: "Invalid classId or assignmentId." });
    }

    const classroom = await Class.findById(classId).select("teacher students");
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (!userCanAccessClass(classroom, req.user)) {
      return res.status(403).json({ message: "You are not part of this class." });
    }

    const assignment = await Assignment.findOne({ _id: assignmentId, classId }).select(
      "_id title description dueDate createdAt links attachments files templateShareId templateUrl",
    );

    if (!assignment) {
      return res.status(404).json({ message: "Assignment not found." });
    }

    const submission = await Submission.findOne({
      assignmentId,
      studentId: req.user._id,
    })
      .populate("projectId", "_id board updatedAt createdAt");

    return res.status(200).json({
      assignment,
      submission,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to fetch submission.",
      error: error.message,
    });
  }
};

export const upsertAssignmentSubmission = async (req, res) => {
  try {
    const { classId, assignmentId } = req.params;
    const { projectId, notes, attachments, files, links, simulationShareId, simulationUrl } = req.body || {};

    if (req.user?.role !== "student") {
      return res.status(403).json({ message: "Only students can submit assignments." });
    }

    if (!isValidObjectId(classId) || !isValidObjectId(assignmentId)) {
      return res.status(400).json({ message: "Invalid classId or assignmentId." });
    }

    const classroom = await Class.findById(classId).select("teacher students");
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (!userCanAccessClass(classroom, req.user)) {
      return res.status(403).json({ message: "You are not part of this class." });
    }

    const assignment = await Assignment.findOne({ _id: assignmentId, classId }).select("_id dueDate");
    if (!assignment) {
      return res.status(404).json({ message: "Assignment not found." });
    }

    if (assignment.dueDate && new Date(assignment.dueDate) < new Date()) {
      return res.status(400).json({
        message: "This assignment is closed. Submissions are no longer accepted.",
      });
    }

    const rawAttachments = Array.isArray(attachments) ? attachments : files;
    const sanitizedAttachments = Array.isArray(rawAttachments)
      ? rawAttachments.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim())
      : [];
    const sanitizedLinks = Array.isArray(links)
      ? links.filter((link) => typeof link === "string" && link.trim()).map((link) => link.trim())
      : [];
    const sanitizedSimulationUrl = typeof simulationUrl === "string" ? simulationUrl.trim() : "";
    const sanitizedSimulationShareId = typeof simulationShareId === "string" && simulationShareId.trim()
      ? simulationShareId.trim()
      : (sanitizedSimulationUrl.match(/\/simulator\/share\/([^/?#]+)/)?.[1] || "");

    const updatePayload = {
      classId,
      assignmentId,
      studentId: req.user._id,
      projectId: isValidObjectId(projectId) ? projectId : undefined,
      simulationShareId: sanitizedSimulationShareId || undefined,
      simulationUrl: sanitizedSimulationUrl || undefined,
      notes: typeof notes === "string" ? notes.trim() : "",
      links: sanitizedLinks,
      attachments: sanitizedAttachments,
    };

    const submission = await Submission.findOneAndUpdate(
      { assignmentId, studentId: req.user._id },
      updatePayload,
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    ).populate("projectId", "_id board updatedAt createdAt");

    return res.status(200).json({
      message: "Assignment submitted successfully.",
      submission,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to submit assignment.",
      error: error.message,
    });
  }
};

export const getComments = async (req, res) => {
  try {
    const { classId } = req.params;
    const { postId, postType } = req.query;

    if (!isValidObjectId(classId)) {
      return res.status(400).json({ message: "Invalid classId." });
    }

    if (!postId || !isValidObjectId(postId)) {
      return res.status(400).json({ message: "Invalid postId." });
    }

    if (!["assignment", "notice"].includes(postType)) {
      return res.status(400).json({ message: "postType must be 'assignment' or 'notice'." });
    }

    const classroom = await Class.findById(classId).select("teacher students");
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (!userCanAccessClass(classroom, req.user)) {
      return res
        .status(403)
        .json({ message: "You are not part of this class." });
    }

    const targetPost = postType === "assignment"
      ? await Assignment.findOne({ _id: postId, classId }).select("_id")
      : await Notice.findOne({ _id: postId, classId }).select("_id");

    if (!targetPost) {
      return res
        .status(404)
        .json({ message: `${postType} not found in this class.` });
    }

    const comments = await Comment.find({ classId, postId, postType })
      .populate("createdBy", "name email role image")
      .sort({ createdAt: 1 });

    return res.status(200).json({ comments });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to fetch comments.", error: error.message });
  }
};

export const deleteComment = async (req, res) => {
  try {
    const { classId, commentId } = req.params;

    if (!isValidObjectId(classId) || !isValidObjectId(commentId)) {
      return res.status(400).json({ message: "Invalid classId or commentId." });
    }

    const classroom = await Class.findById(classId).select("teacher students");
    if (!classroom) {
      return res.status(404).json({ message: "Class not found." });
    }

    if (!userCanAccessClass(classroom, req.user)) {
      return res
        .status(403)
        .json({ message: "You are not part of this class." });
    }

    const comment = await Comment.findOne({ _id: commentId, classId });
    if (!comment) {
      return res.status(404).json({ message: "Comment not found." });
    }

    const isClassTeacher = extractId(classroom.teacher) === extractId(req.user?._id || req.user?.id);
    const isCommentOwner = comment.createdBy.toString() === req.user._id.toString();

    if (!isClassTeacher && !isCommentOwner) {
      return res
        .status(403)
        .json({ message: "You can only delete your own comments." });
    }

    await Comment.findByIdAndDelete(commentId);

    return res.status(200).json({ message: "Comment deleted successfully." });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to delete comment.", error: error.message });
  }
};
