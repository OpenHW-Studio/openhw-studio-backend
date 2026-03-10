import bcrypt from "bcryptjs";
import User from "../models/User.js";
import generateToken from "../utils/helper/token.js";
import { OAuth2Client } from "google-auth-library";

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);


const normalizeEmail = (rawEmail = "") => rawEmail.trim().toLowerCase();
const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;
const isValidEmailFormat = (value = "") =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const signinUser = async (req, res) => {
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

const signupUser = async (req, res) => {
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

const logoutController = async (req, res) => {
  try {
    res.cookie("jwt", "", { maxAge: 1 });
    res.status(200).json({ message: "User logged out successfully" });
  } catch (error) {
    console.log("Error in logoutController: ", error);
    res.status(500).json({ error });
  }
};

const updateUserProfile = async (req, res) => {
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

const googleLogin = async (req, res) => {
  try {
    const { access_token, role } = req.body;

    if (!access_token) {
      return res.status(400).json({ message: "Google access token is required." });
    }

    // Verify token with Google API directly using fetch or axios
    // Because frontend uses @react-oauth/google useGoogleLogin, it sends an access token, not an ID token.
    const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    if (!googleRes.ok) {
      return res.status(401).json({ message: "Invalid Google access token." });
    }

    const payload = await googleRes.json();
    const { email, name, picture } = payload;

    // Check if user exists
    let user = await User.findOne({ email });

    if (!user) {
      // If user doesn't exist, create them
      const allowedRoles = ["student", "teacher"];
      const selectedRole = allowedRoles.includes(role) ? role : "student";

      user = await User.create({
        name,
        email,
        role: selectedRole,
        password: Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8), // Dummy password since they use Google
        // Optional: save picture if your schema supports it
      });
    }

    // Generate JWT
    const token = generateToken(user);
    res.cookie("jwt", token, {
      httpOnly: true,
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      message: "Google login successful.",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        college: user.college,
        branch: user.branch,
        semester: user.semester,
        bio: user.bio,
      },
    });

  } catch (error) {
    console.error("Google Auth Error:", error);
    res.status(500).json({ message: "Google Authentication Failed", error: error.message });
  }
};

export { signinUser, signupUser, logoutController, updateUserProfile, googleLogin }