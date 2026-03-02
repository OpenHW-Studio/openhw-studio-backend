import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const normalizeEmail = (rawEmail = '') => rawEmail.trim().toLowerCase();

export const signupUser = async (req, res) => {
    try {
        const { name, email, password, role } = req.body || {};

        if (!name || !email || !password) {
            return res.status(400).json({ message: 'Name, email, and password are required.' });
        }

        if (typeof password !== 'string') {
            return res.status(400).json({ message: 'Password must be a string.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
        }

        const sanitizedEmail = normalizeEmail(email);

        const existingUser = await User.findOne({ email: sanitizedEmail });
        if (existingUser) {
            return res.status(409).json({ message: 'An account with this email already exists.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const selectedRole = ['student', 'teacher', 'admin'].includes(role) ? role : undefined;

        const user = await User.create({
            name: name.trim(),
            email: sanitizedEmail,
            password: hashedPassword,
            role: selectedRole || undefined,
        });

        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
            console.error('JWT_SECRET is not configured.');
            return res.status(500).json({ message: 'Server configuration error. Please contact support.' });
        }

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
        console.error('Error during user signup:', error);
        return res.status(500).json({ message: 'Failed to register user.', error: error.message });
    }
};
