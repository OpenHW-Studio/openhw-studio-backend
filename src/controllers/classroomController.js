import mongoose from "mongoose";
import Class from "../models/Class.js";
import Assignment from "../models/Assignment.js";
import Notice from "../models/Notice.js";
import User from "../models/User.js";

const { ObjectId } = mongoose.Types;

const isTeacher = (user) => user?.role === "teacher";
const isValidObjectId = (id) => ObjectId.isValid(id);

const generateJoinCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const createUniqueJoinCode = async () => {
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const joinCode = generateJoinCode();
    const existing = await Class.findOne({ joinCode }).select("_id");
    if (!existing) return joinCode;
  }
  throw new Error("Failed to generate unique join code");
};

const userCanAccessClass = (classroom, user) => {
  const userId = user?._id?.toString();
  if (!userId || !classroom) return false;

  const isOwner = classroom.teacher?.toString() === userId;
  const isStudent = Array.isArray(classroom.students) &&
    classroom.students.some((studentId) => studentId.toString() === userId);

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
      return res.status(403).json({ message: "Only teachers can create classes." });
    }

    const { name } = req.body || {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ message: "Class name is required." });
    }

    const joinCode = await createUniqueJoinCode();
    const classroom = await Class.create({
      name: name.trim(),
      teacher: req.user._id,
      joinCode
    });

    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { classes: classroom._id }
    });

    return res.status(201).json({
      message: "Class created successfully.",
      classroom
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to create class.", error: error.message });
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
      return res.status(403).json({ message: "Only the class teacher can invite students." });
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
        message: "Provide at least one student via studentIds or emails."
      });
    }

    const students = await User.find({
      role: "student",
      $or: [
        ...(normalizedStudentIds.length ? [{ _id: { $in: normalizedStudentIds } }] : []),
        ...(normalizedEmails.length ? [{ email: { $in: normalizedEmails } }] : [])
      ]
    }).select("_id name email role");

    if (!students.length) {
      return res.status(404).json({ message: "No matching students found." });
    }

    const studentObjectIds = students.map((student) => student._id);

    const updatedClassroom = await Class.findByIdAndUpdate(
      classId,
      { $addToSet: { students: { $each: studentObjectIds } } },
      { new: true }
    )
      .populate("teacher", "name email role")
      .populate("students", "name email role");

    await User.updateMany(
      { _id: { $in: studentObjectIds } },
      { $addToSet: { classes: classId } }
    );

    return res.status(200).json({
      message: "Students invited successfully.",
      invitedCount: studentObjectIds.length,
      classroom: updatedClassroom
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to invite students.", error: error.message });
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
      .populate("teacher", "name email role")
      .populate("students", "name email role")
      .sort({ createdAt: -1 });

    return res.status(200).json({ classrooms });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch classrooms.", error: error.message });
  }
};

export const joinClassroomByCode = async (req, res) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({ message: "Only students can join classes using code." });
    }

    const { joinCode } = req.body || {};
    if (typeof joinCode !== "string" || !joinCode.trim()) {
      return res.status(400).json({ message: "joinCode is required." });
    }

    const normalizedJoinCode = joinCode.trim().toUpperCase();
    const classroom = await Class.findOne({ joinCode: normalizedJoinCode });
    if (!classroom) {
      return res.status(404).json({ message: "Class not found for the given join code." });
    }

    if (classroom.teacher.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: "Teacher cannot join their own class as student." });
    }

    const alreadyJoined = classroom.students.some(
      (studentId) => studentId.toString() === req.user._id.toString()
    );

    if (!alreadyJoined) {
      await Class.findByIdAndUpdate(classroom._id, {
        $addToSet: { students: req.user._id }
      });

      await User.findByIdAndUpdate(req.user._id, {
        $addToSet: { classes: classroom._id }
      });
    }

    const updatedClassroom = await Class.findById(classroom._id)
      .populate("teacher", "name email role")
      .populate("students", "name email role");

    return res.status(200).json({
      message: alreadyJoined ? "Already joined this class." : "Joined class successfully.",
      classroom: updatedClassroom
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to join classroom.", error: error.message });
  }
};

export const createAssignment = async (req, res) => {
  try {
    if (!isTeacher(req.user)) {
      return res.status(403).json({ message: "Only teachers can create assignments." });
    }

    const { classId } = req.params;
    const { title, description, templateProjectId, dueDate } = req.body || {};

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
      return res.status(403).json({ message: "Only the class teacher can create assignments." });
    }

    if (dueDate && Number.isNaN(new Date(dueDate).getTime())) {
      return res.status(400).json({ message: "Invalid dueDate format." });
    }

    const assignment = await Assignment.create({
      classId,
      title: title.trim(),
      description: typeof description === "string" ? description.trim() : undefined,
      templateProjectId: isValidObjectId(templateProjectId) ? templateProjectId : undefined,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      createdBy: req.user._id
    });

    await Class.findByIdAndUpdate(classId, {
      $addToSet: { assignments: assignment._id }
    });

    return res.status(201).json({
      message: "Assignment created successfully.",
      assignment
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to create assignment.", error: error.message });
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
        { description: { $regex: search.trim(), $options: "i" } }
      ];
    }

    if (fromDueDate || toDueDate) {
      const dueDateFilter = {};
      if (fromDueDate) {
        const parsedFrom = new Date(fromDueDate);
        if (Number.isNaN(parsedFrom.getTime())) {
          return res.status(400).json({ message: "Invalid fromDueDate format." });
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

      const classroom = await Class.findById(classId).select("teacher students");
      if (!classroom) {
        return res.status(404).json({ message: "Class not found." });
      }

      if (!userCanAccessClass(classroom, req.user)) {
        return res.status(403).json({ message: "You are not part of this class." });
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
          totalPages: Math.ceil(total / limitNumber)
        }
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
          totalPages: Math.ceil(total / limitNumber)
        }
      });
    }

    if (req.user.role === "student") {
      const classrooms = await Class.find({ students: req.user._id }).select("_id");
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
          totalPages: Math.ceil(total / limitNumber)
        }
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
        totalPages: Math.ceil(total / limitNumber)
      }
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch assignments.", error: error.message });
  }
};

export const createNotice = async (req, res) => {
  try {
    if (!isTeacher(req.user)) {
      return res.status(403).json({ message: "Only teachers can create notices." });
    }

    const { classId } = req.params;
    const { title, message } = req.body || {};

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
      return res.status(403).json({ message: "Only the class teacher can create notices." });
    }

    const notice = await Notice.create({
      classId,
      title: typeof title === "string" && title.trim() ? title.trim() : "Notice",
      message: message.trim(),
      createdBy: req.user._id
    });

    await Class.findByIdAndUpdate(classId, {
      $addToSet: { notices: notice._id }
    });

    return res.status(201).json({
      message: "Notice created successfully.",
      notice
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to create notice.", error: error.message });
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
      return res.status(403).json({ message: "You are not part of this class." });
    }

    const query = { classId };
    if (typeof search === "string" && search.trim()) {
      query.$or = [
        { title: { $regex: search.trim(), $options: "i" } },
        { message: { $regex: search.trim(), $options: "i" } }
      ];
    }

    const total = await Notice.countDocuments(query);
    const notices = await Notice.find(query)
      .populate("createdBy", "name email role")
      .skip(skip)
      .limit(limitNumber)
      .sort({ createdAt: -1 });

    return res.status(200).json({
      notices,
      pagination: {
        total,
        page: pageNumber,
        limit: limitNumber,
        totalPages: Math.ceil(total / limitNumber)
      }
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch notices.", error: error.message });
  }
};
