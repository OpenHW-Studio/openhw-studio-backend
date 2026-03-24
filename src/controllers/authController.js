import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import sendEmail from "../utils/sendEmail.js";

// FORGOT PASSWORD
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    const resetLink = `${process.env.FRONTEND_URL}/reset-password/${token}`;

    const html = `
      <h2>Password Reset</h2>
      <p>Click below to reset password:</p>
      <a href="${resetLink}">Reset Password</a>
      <p>This link expires in 15 minutes</p>
    `;

    await sendEmail(email, "Reset Password", html);

    res.json({ message: "Reset link sent to email" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// RESET PASSWORD
export const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { newPassword } = req.body;

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await User.findByIdAndUpdate(decoded.id, {
      password_hash: hashedPassword
    });

    res.json({ message: "Password reset successful" });

  } catch (err) {
    res.status(400).json({ message: "Invalid or expired token" });
  }
};
