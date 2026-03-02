
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const normalizeEmail = (rawEmail = '') => rawEmail.trim().toLowerCase();
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isValidEmailFormat = (value = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// USER LOGIN CONTROLLER
export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1️ Check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    // 2️ Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // 3️ Generate JWT Token
    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    // 4️ Send response
    res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
      },
    });

  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }

export const signupUser = async (req, res) => {
    try {
        const { name, email, password, role } = req.body || {};

        const hasValidName = isNonEmptyString(name);
        const hasValidEmail = isNonEmptyString(email);
        const hasValidPassword = isNonEmptyString(password);

        if (!hasValidName || !hasValidEmail || !hasValidPassword) {
            return res.status(400).json({ error: 'Name, email, and password must be non-empty strings.' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
        }

        const sanitizedEmail = typeof email === 'string' ? normalizeEmail(email) : '';
        if (!isValidEmailFormat(sanitizedEmail)) {
            return res.status(400).json({ error: 'Please provide a valid email address.' });
        }

        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
            console.error('JWT_SECRET is not configured.');
            return res.status(500).json({ error: 'Server configuration error.' });
        }

        const existingUser = await User.findOne({ email: sanitizedEmail });
        if (existingUser) {
            return res.status(409).json({ error: 'An account with this email already exists.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const allowedRoles = ['student', 'teacher'];
        const selectedRole = allowedRoles.includes(role) ? role : 'student';

        const user = await User.create({
            name: name.trim(),
            email: sanitizedEmail,
            password: hashedPassword,
            role: selectedRole,
        });

        const token = jwt.sign(
            { userId: user._id, role: user.role },
            jwtSecret,
            { expiresIn: '7d' }
        );

        return res.status(201).json({
            message: 'User registered successfully.',
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                points: user.points,
                coins: user.coins,
                level: user.level,
            },
            token,
        });
    } catch (error) {
        if (error && (error.code === 11000 || error.code === 11001)) {
            return res.status(409).json({ error: 'An account with this email already exists.' });
        }
        console.error('Error during user signup:', error);
        return res.status(500).json({ error: 'Failed to register user.' });
    }
};
