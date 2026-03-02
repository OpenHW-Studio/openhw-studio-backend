import bcrypt from "bcryptjs";
import User from "../models/User.js";
import generateToken from "../utils/helper/token.js";

const normalizeEmail = (rawEmail = "") => rawEmail.trim().toLowerCase();
const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;
const isValidEmailFormat = (value = "") =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    const sanitizedEmail = normalizeEmail(email || "");
    const user = await User.findOne({ email: sanitizedEmail });
    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const token = generateToken(user);
    res.cookie("jwt", token, {
      httpOnly: true,
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        college: user.college,
        branch: user.branch,
        semester: user.semester,
        bio: user.bio,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const signupUser = async (req, res) => {
  try {
    const { name, email, password, role, college, branch, semester, bio } = req.body || {};

    const hasValidName = isNonEmptyString(name);
    const hasValidEmail = isNonEmptyString(email);
    const hasValidPassword = isNonEmptyString(password);

    if (!hasValidName || !hasValidEmail || !hasValidPassword) {
      return res.status(400).json({
        error: "Name, email, and password must be non-empty strings.",
      });
    }

    if (password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters long." });
    }

    const sanitizedEmail =
      typeof email === "string" ? normalizeEmail(email) : "";
    if (!isValidEmailFormat(sanitizedEmail)) {
      return res
        .status(400)
        .json({ error: "Please provide a valid email address." });
    }

    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET is not configured.");
      return res.status(500).json({ error: "Server configuration error." });
    }

    const existingUser = await User.findOne({ email: sanitizedEmail });
    if (existingUser) {
      return res
        .status(409)
        .json({ error: "An account with this email already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const allowedRoles = ["student", "teacher"];
    const selectedRole = allowedRoles.includes(role) ? role : "student";

    const user = await User.create({
      name: name.trim(),
      email: sanitizedEmail,
      password: hashedPassword,
      role: selectedRole,
      college: isNonEmptyString(college) ? college.trim() : undefined,
      branch: isNonEmptyString(branch) ? branch.trim() : undefined,
      semester: Number.isInteger(semester) ? semester : undefined,
      bio: isNonEmptyString(bio) ? bio.trim() : undefined,
    });

    const token = generateToken(user);
    res.cookie("jwt", token, {
      httpOnly: true,
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      message: "User registered successfully.",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        college: user.college,
        branch: user.branch,
        semester: user.semester,
        bio: user.bio,
        points: user.points,
        coins: user.coins,
        level: user.level,
      },
      token,
    });
  } catch (error) {
    if (error && (error.code === 11000 || error.code === 11001)) {
      return res
        .status(409)
        .json({ error: "An account with this email already exists." });
    }
    console.error("Error during user signup:", error);
    return res.status(500).json({ error: "Failed to register user." });
  }
};

export const logoutController = async (req, res) => {
  try {
    res.cookie("jwt", "", { maxAge: 1 });
    res.status(200).json({ message: "User logged out successfully" });
  } catch (error) {
    console.log("Error in logoutController: ", error);
    res.status(500).json({ error });
  }
};

export const updateUserProfile = async (req, res) => {
  try {
    const allowedRoles = ["student", "teacher", "admin"];
    const updatableFields = ["name", "role", "college", "branch", "semester", "bio"];
    const updates = {};

    for (const field of updatableFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates[field] = req.body[field];
      }
    }

    if (typeof updates.name === "string") updates.name = updates.name.trim();
    if (typeof updates.college === "string") updates.college = updates.college.trim();
    if (typeof updates.branch === "string") updates.branch = updates.branch.trim();
    if (typeof updates.bio === "string") updates.bio = updates.bio.trim();

    if (updates.role && !allowedRoles.includes(updates.role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    if (
      Object.prototype.hasOwnProperty.call(updates, "semester") &&
      updates.semester !== undefined &&
      updates.semester !== null &&
      !Number.isInteger(updates.semester)
    ) {
      return res.status(400).json({ message: "Semester must be an integer" });
    }

    const updatedUser = await User.findByIdAndUpdate(req.user._id, updates, {
      new: true,
      runValidators: true,
    }).select("-password");

    return res.status(200).json({
      message: "Profile updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update profile", error: error.message });
  }
};
