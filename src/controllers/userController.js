import argon2 from "argon2";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import User from "../models/User.js";
import sendEmail from "../utils/sendEmail.js";
import generateToken from "../utils/helper/token.js"


const normalizeEmail = (rawEmail = "") => rawEmail.trim().toLowerCase();
const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;
const isValidEmailFormat = (value = "") =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const pickFirstNonEmptyString = (...values) =>
  values.find((value) => isNonEmptyString(value));
const isStrongPassword = (password = "") =>
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@#$!%*?&]).{8,}$/.test(password);
const isBcryptHash = (hash = "") =>
  typeof hash === "string" && /^\$2[aby]\$/.test(hash);
const verifyPassword = async (storedHash, plainPassword) => {
  if (typeof storedHash !== "string" || !storedHash) {
    return { ok: false, needsRehash: false };
  }

  if (isBcryptHash(storedHash)) {
    const ok = await bcrypt.compare(plainPassword, storedHash);
    return { ok, needsRehash: ok };
  }

  const ok = await argon2.verify(storedHash, plainPassword);
  return { ok, needsRehash: false };
};

const serializeUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  school: user.school,
  classStandard: user.classStandard,
  bio: user.bio,
  image: user.image,
  points: user.points,
  coins: user.coins,
  level: user.level,
  badges: user.badges,
});

const signinUser = async (req, res) => {
  try {
    const { email, password, role } = req.body;
    const sanitizedEmail = normalizeEmail(email || "");
    const user = await User.findOne({ email: sanitizedEmail });

    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }
     if (role && role !== "user" && user.role !== role) {
      return res.status(400).json({ message: `Account is registered as a ${user.role}. Please select the ${user.role} role.` });
    }

    const isMatch = await argon2.compare(password, user.password);
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
      user: serializeUser(user),
      });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
}; 

const signupUser = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role,
      school,
      classStandard,
      bio,
      image,
    } = req.body || {};

    const hasValidName = isNonEmptyString(name);
    const hasValidEmail = isNonEmptyString(email);
    const hasValidPassword = isNonEmptyString(password);

    if (!hasValidName || !hasValidEmail || !hasValidPassword) {
      return res.status(400).json({
        error: "Name, email, and password must be non-empty strings.",
      });
    }
if (!isStrongPassword(password)) {
  return res.status(400).json({
    error:
      "Password must be at least 8 characters long and include uppercase, lowercase, number, and special symbol.",
  });
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

    const hashedPassword = await bcrypt.hash(password,10);

    const allowedRoles = ["student", "teacher", "user"];
    const selectedRole = allowedRoles.includes(role) ? role : "student";
    const resolvedSchool = pickFirstNonEmptyString(school);
    const resolvedStandard = pickFirstNonEmptyString(classStandard);

    const user = await User.create({
      name: name.trim(),
      email: sanitizedEmail,
      password: hashedPassword,
      role: selectedRole,
      school: resolvedSchool ? resolvedSchool.trim() : undefined,
      classStandard: resolvedStandard ? resolvedStandard.trim() : undefined,
      bio: isNonEmptyString(bio) ? bio.trim() : undefined,
      image: isNonEmptyString(image) ? image.trim() : undefined,
    });
const token = generateToken(user);
    res.cookie("jwt", token, {
      httpOnly: true,
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      message: "User registered successfully.",
      user: serializeUser(user),
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
    res.cookie("jwt", "", { httpOnly: true, sameSite: "strict", maxAge: 1 });
    res.status(200).json({ message: "User logged out successfully" });
  } catch (error) {
    console.log("Error in logoutController: ", error);
    res.status(500).json({ error });
  }
};

const getUserProfile = async (req, res) => {
  try {
    // make sure to exclude sensitive fields and populate classes
    const user = await User.findById(req.user._id)
      .select("-password -resetPasswordToken -resetPasswordExpires")
      .populate("classes");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const profile = user.toObject();
    delete profile.email;

    return res.status(200).json({
      message: "User profile fetched successfully",
      user: profile,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch user profile", error: error.message });
  }
};

const updateUserProfile = async (req, res) => {
  try {
    const allowedRoles = ["student", "teacher", "admin"];
    const updatableFields = ["name", "email", "role", "school", "classStandard", "bio", "image"];
    const updates = {};

    for (const field of updatableFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates[field] = req.body[field];
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "school")) {
      updates.school = req.body.school;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "classStandard")) {
      updates.classStandard = req.body.classStandard;
    }

    if (typeof updates.name === "string") updates.name = updates.name.trim();
    if (typeof updates.email === "string") updates.email = normalizeEmail(updates.email);
    if (typeof updates.school === "string") updates.school = updates.school.trim();
    if (typeof updates.classStandard === "string") updates.classStandard = updates.classStandard.trim();
    if (typeof updates.bio === "string") updates.bio = updates.bio.trim();
    if (typeof updates.image === "string") updates.image = updates.image.trim();

    if (Object.prototype.hasOwnProperty.call(updates, "name") && !updates.name) {
      return res.status(400).json({ message: "Name is required" });
    }

    if (Object.prototype.hasOwnProperty.call(updates, "email")) {
      if (!updates.email || !isValidEmailFormat(updates.email)) {
        return res.status(400).json({ message: "A valid email is required" });
      }

      const existingUser = await User.findOne({
        email: updates.email,
        _id: { $ne: req.user._id },
      }).select("_id");

      if (existingUser) {
        return res.status(409).json({ message: "An account with this email already exists." });
      }
    }

    if (updates.role && !allowedRoles.includes(updates.role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    // Prevent privilege escalation — only an admin can grant admin role
    if (updates.role === "admin" && req.user.role !== "admin") {
      return res.status(403).json({ message: "Not authorised to assign admin role" });
    }

    const updatedUser = await User.findByIdAndUpdate(req.user._id, updates, {
      new: true,
      runValidators: true,
    }).select("-password");

    return res.status(200).json({
      message: "Profile updated successfully",
      user: serializeUser(updatedUser),
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
      const allowedRoles = ["student", "teacher", "user"];
      const selectedRole = allowedRoles.includes(role) ? role : "user";

      user = await User.create({
        name,
        email,
        role: selectedRole,
        password: crypto.randomBytes(32).toString("hex"), // Secure dummy password — Google users authenticate via OAuth
        // Optional: save picture if your schema supports it
      });
    } else {
      if (role && role !== "user" && user.role !== role) {
        return res.status(400).json({ message: `Account is registered as a ${user.role}. Please select the ${user.role} role.` });
      }
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
      user: serializeUser(user),
    });

  } catch (error) {
    console.error("Google Auth Error:", error);
    res.status(500).json({ message: "Google Authentication Failed", error: error.message });
  }
};

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: normalizeEmail(email) });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Create reset token
    const resetToken = crypto.randomBytes(20).toString('hex');

    // Hash token and set to resetPasswordToken field
    user.resetPasswordToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');

    // Set expires
    user.resetPasswordExpires = Date.now() + 10 * 60 * 1000; // 10 minutes

    await user.save();

    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password/${resetToken}`;

    const message = `You are receiving this email because you (or someone else) has requested the reset of a password. Please make a POST request to: \n\n ${resetUrl}`;

    try {
      await sendEmail({
        email: user.email,
        subject: 'Password reset token',
        message,
      });

      res.status(200).json({ success: true, data: 'Email sent' });
    } catch (err) {
      console.error(err);
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;

      await user.save();

      res.status(500).json({ message: 'Email could not be sent' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

const resetPassword = async (req, res) => {
  try {
    // Get hashed token
    const resetPasswordToken = crypto
      .createHash('sha256')
      .update(req.params.token)
      .digest('hex');

    const user = await User.findOne({
      resetPasswordToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid token' });
    }

    // Set new password
    const { password } = req.body;
    if (!isStrongPassword(password)) {
  return res.status(400).json({
    error:
      "Password must be at least 8 characters long and include uppercase, lowercase, number, and special symbol.",
  });
}

    user.password = await argon2.hash(password);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();

    res.status(200).json({
      success: true,
      message: 'Password reset successful',
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};


const registerStudent = async (req, res) => {
  try {
    // Only teachers/admins should access this
    if (req.user.role !== "teacher" && req.user.role !== "admin") {
      return res.status(403).json({ message: "Not authorized to register students" });
    }

    const { name, dob } = req.body; // dob expected as DD/MM/YYYY
    if (!name || !dob) {
      return res.status(400).json({ message: "Name and dob (DD/MM/YYYY) are required" });
    }

    const [day, month, year] = dob.split("/");
    if (!day || !month || !year || year.length !== 4) {
      return res.status(400).json({ message: "Invalid date format. Use DD/MM/YYYY" });
    }

    // Generate random username (e.g., student_ + random string) and temp password
    const username = `student_${crypto.randomBytes(4).toString("hex")}`;
    const tempPassword = crypto.randomBytes(6).toString("hex");
    const unique_id = crypto.randomBytes(2).toString("hex").toUpperCase(); // 4 chars

    const hashedPassword = await argon2.hash(tempPassword);

    const user = await User.create({
      name,
      username,
      password: hashedPassword,
      unique_id,
      dob_day: day,
      dob_month: month,
      dob_year: year,
      role: "student",
      is_first_login: true,
    });

    res.status(201).json({
      message: "Student registered successfully",
      student: {
        username,
        tempPassword,
        unique_id,
        name: user.name
      }
    });

  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const setNewPassword = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters long and include uppercase, lowercase, number, and special symbol.",
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.password = await argon2.hash(password);
    user.is_first_login = false;
    await user.save();

    res.status(200).json({ message: "Password updated successfully. You can now use your new password." });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const forgotPasswordInit = async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ message: "Username is required" });

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const formats = ["DDMMYYYY", "DDYYYYMM", "MMDDYYYY", "MMYYYYDD", "YYYYDDMM", "YYYYMMDD"];
    const selectedFormat = formats[Math.floor(Math.random() * formats.length)];

    res.status(200).json({
      message: "Please enter your Secret Credential",
      format: selectedFormat,
      instruction: `Enter your Secret Credential in the format: [UNIQUE_ID] + [${selectedFormat}] (No hyphens)`
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const forgotPasswordVerify = async (req, res) => {
  try {
    const { username, secretCredential, format } = req.body;
    if (!username || !secretCredential || !format) {
      return res.status(400).json({ message: "Username, secretCredential, and format are required" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const unique_id_input = secretCredential.substring(0, 4);
    const date_input = secretCredential.substring(4);

    if (unique_id_input !== user.unique_id) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const day = user.dob_day.padStart(2, '0');
    const month = user.dob_month.padStart(2, '0');
    const year = user.dob_year;

    let expectedDate = "";
    if (format === "DDMMYYYY") expectedDate = day + month + year;
    else if (format === "DDYYYYMM") expectedDate = day + year + month;
    else if (format === "MMDDYYYY") expectedDate = month + day + year;
    else if (format === "MMYYYYDD") expectedDate = month + year + day;
    else if (format === "YYYYDDMM") expectedDate = year + day + month;
    else if (format === "YYYYMMDD") expectedDate = year + month + day;
    else return res.status(400).json({ message: "Invalid format provided" });

    if (date_input !== expectedDate) {
      return res.status(400).json({ message: "Invalid secret credential" });
    }

    // Generate a temporary reset token similar to the standard email reset
    const resetToken = crypto.randomBytes(20).toString('hex');
    user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.resetPasswordExpires = Date.now() + 10 * 60 * 1000; // 10 mins
    await user.save();

    res.status(200).json({
      message: "Secret credential verified successfully",
      resetToken // Note: In a pure API, we give the token back here to be used in the final reset request.
    });

  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};


export {
  signinUser,
  signupUser,
  logoutController,
  getUserProfile,
  updateUserProfile,
  googleLogin,
  forgotPassword,
  resetPassword,
  registerStudent,
  setNewPassword,
  forgotPasswordInit,
  forgotPasswordVerify
}
