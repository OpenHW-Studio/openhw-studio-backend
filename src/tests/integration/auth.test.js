import request from 'supertest';
import { expect } from 'chai';
import mongoose from 'mongoose';
import app from '../helpers/app.js';
import User from '../../models/User.js';

describe('🔑 Backend API Integration — Authentication & Profiles', () => {
    // Clean user table before each test case
    beforeEach(async () => {
        await User.deleteMany({});
    });

    describe('POST /api/user/signup', () => {
        it('should successfully register a student user with valid credentials', async () => {
            const res = await request(app)
                .post('/api/user/signup')
                .send({
                    name: 'Viraj Shah',
                    email: 'viraj@iitb.ac.in',
                    password: 'SecurePassword123!',
                    role: 'student',
                    school: 'IIT Bombay',
                    classStandard: 'Sophomore'
                });

            expect(res.status).to.equal(201);
            expect(res.body).to.have.property('message', 'User registered successfully.');
            expect(res.body).to.have.property('token');
            expect(res.body.user).to.have.property('email', 'viraj@iitb.ac.in');
            expect(res.body.user).to.have.property('role', 'student');
            expect(res.body.user).to.not.have.property('password');
        });

        it('should fail if name, email, or password are empty or missing', async () => {
            const res = await request(app)
                .post('/api/user/signup')
                .send({
                    email: 'viraj@iitb.ac.in',
                    password: 'SecurePassword123!'
                    // Missing name
                });

            expect(res.status).to.equal(400);
            expect(res.body).to.have.property('error');
        });

        it('should fail if the password is too weak', async () => {
            const res = await request(app)
                .post('/api/user/signup')
                .send({
                    name: 'Viraj Shah',
                    email: 'viraj@iitb.ac.in',
                    password: 'weak', // weak password
                    role: 'student'
                });

            expect(res.status).to.equal(400);
            expect(res.body).to.have.property('error');
            expect(res.body.error).to.include('Password must be at least 8 characters');
        });

        it('should fail if email format is invalid', async () => {
            const res = await request(app)
                .post('/api/user/signup')
                .send({
                    name: 'Viraj Shah',
                    email: 'invalid-email-format',
                    password: 'SecurePassword123!',
                    role: 'student'
                });

            expect(res.status).to.equal(400);
            expect(res.body).to.have.property('error', 'Please provide a valid email address.');
        });

        it('should block registration of duplicate emails', async () => {
            // First user signup
            await request(app)
                .post('/api/user/signup')
                .send({
                    name: 'Viraj Shah',
                    email: 'viraj@iitb.ac.in',
                    password: 'SecurePassword123!',
                    role: 'student'
                });

            // Duplicate signup
            const res = await request(app)
                .post('/api/user/signup')
                .send({
                    name: 'Duplicate User',
                    email: 'viraj@iitb.ac.in',
                    password: 'AnotherPassword123!',
                    role: 'student'
                });

            expect(res.status).to.equal(409);
            expect(res.body).to.have.property('error', 'An account with this email already exists.');
        });
    });

    describe('POST /api/user/signin', () => {
        beforeEach(async () => {
            // Seed a student user for login testing
            await request(app)
                .post('/api/user/signup')
                .send({
                    name: 'Viraj Shah',
                    email: 'viraj@iitb.ac.in',
                    password: 'SecurePassword123!',
                    role: 'student'
                });
        });

        it('should sign in successfully with correct credentials', async () => {
            const res = await request(app)
                .post('/api/user/signin')
                .send({
                    email: 'viraj@iitb.ac.in',
                    password: 'SecurePassword123!'
                });

            expect(res.status).to.equal(200);
            expect(res.body).to.have.property('message', 'Login successful');
            expect(res.body).to.have.property('token');
            expect(res.body.user).to.have.property('email', 'viraj@iitb.ac.in');
        });

        it('should fail login if the user does not exist', async () => {
            const res = await request(app)
                .post('/api/user/signin')
                .send({
                    email: 'notfound@iitb.ac.in',
                    password: 'SecurePassword123!'
                });

            expect(res.status).to.equal(400);
            expect(res.body).to.have.property('message', 'User not found');
        });

        it('should fail login on incorrect password', async () => {
            const res = await request(app)
                .post('/api/user/signin')
                .send({
                    email: 'viraj@iitb.ac.in',
                    password: 'WrongPassword123!'
                });

            expect(res.status).to.equal(400);
            expect(res.body).to.have.property('message', 'Invalid credentials');
        });

        it('should prevent student account logging into teacher portal', async () => {
            const res = await request(app)
                .post('/api/user/signin')
                .send({
                    email: 'viraj@iitb.ac.in',
                    password: 'SecurePassword123!',
                    role: 'teacher'
                });

            expect(res.status).to.equal(403);
            expect(res.body.message).to.include('restricted to teachers');
        });
    });

    describe('GET /api/user/profile', () => {
        let studentToken;

        beforeEach(async () => {
            // Register and get token
            const res = await request(app)
                .post('/api/user/signup')
                .send({
                    name: 'Viraj Shah',
                    email: 'viraj@iitb.ac.in',
                    password: 'SecurePassword123!',
                    role: 'student'
                });
            studentToken = res.body.token;
        });

        it('should retrieve user profile when authenticated with a valid token', async () => {
            const res = await request(app)
                .get('/api/user/profile')
                .set('Authorization', `Bearer ${studentToken}`);

            expect(res.status).to.equal(200);
            expect(res.body).to.have.property('message', 'User profile fetched successfully');
            expect(res.body.user).to.have.property('name', 'Viraj Shah');
            expect(res.body.user).to.not.have.property('email'); // Profile response filters out email
        });

        it('should return 401 Unauthorized if authorization header is missing', async () => {
            const res = await request(app)
                .get('/api/user/profile');

            expect(res.status).to.equal(401);
            expect(res.body).to.have.property('message');
            expect(res.body.message).to.include('No token provided');
        });

        it('should return 401 Unauthorized if token is invalid/tampered', async () => {
            const res = await request(app)
                .get('/api/user/profile')
                .set('Authorization', 'Bearer invalidtokenhere');

            expect(res.status).to.equal(401);
            expect(res.body).to.have.property('message');
            expect(res.body.message).to.include('jwt malformed');
        });
    });

    describe('POST /api/user/logout', () => {
        let token;
        beforeEach(async () => {
            const res = await request(app)
                .post('/api/user/signup')
                .send({
                    name: 'Logout User',
                    email: 'logout@iitb.ac.in',
                    password: 'SecurePassword123!',
                    role: 'student'
                });
            token = res.body.token;
        });

        it('should clear cookies and return success status', async () => {
            const res = await request(app)
                .post('/api/user/logout')
                .set('Authorization', `Bearer ${token}`);

            expect(res.status).to.equal(200);
            expect(res.body).to.have.property('message', 'User logged out successfully');
            // Check if cookie jwt was cleared
            const setCookie = res.headers['set-cookie'];
            expect(setCookie[0]).to.include('jwt=;');
        });
    });
});
