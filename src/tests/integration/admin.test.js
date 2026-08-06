import request from 'supertest';
import { expect } from 'chai';
import argon2 from 'argon2';
import app from '../helpers/app.js';
import User from '../../models/User.js';
import generateToken from '../../utils/helper/token.js';

describe('👮 Backend API Integration — Admin Authorization Guards', () => {
    let studentToken;
    let adminToken;

    beforeEach(async () => {
        await User.deleteMany({});

        const hashedPassword = await argon2.hash('SecurePassword123!');

        // 1. Create a Student user in DB and generate a token
        const student = await User.create({
            name: 'Student User',
            email: 'student@iitb.ac.in',
            password: hashedPassword,
            role: 'student'
        });
        studentToken = generateToken(student, 'student');

        // 2. Create an Admin user in DB and generate a token
        const admin = await User.create({
            name: 'Admin User',
            email: 'admin@iitb.ac.in',
            password: hashedPassword,
            role: 'admin'
        });
        adminToken = generateToken(admin, 'admin');
    });

    it('❌ Should return 401 Unauthorized if no token is provided', async () => {
        const res = await request(app)
            .get('/api/admin/components/pending');

        expect(res.status).to.equal(401);
        expect(res.body).to.have.property('message');
        expect(res.body.message).to.include('No token provided');
    });

    it('❌ Should return 403 Forbidden if a Student attempts to access admin endpoints', async () => {
        const res = await request(app)
            .get('/api/admin/components/pending')
            .set('Authorization', `Bearer ${studentToken}`);

        expect(res.status).to.equal(403);
        expect(res.body).to.have.property('message', 'Access denied: insufficient permissions');
    });

    it('✅ Should allow an Admin to access admin endpoints', async () => {
        const res = await request(app)
            .get('/api/admin/components/pending')
            .set('Authorization', `Bearer ${adminToken}`);

        // Even if there are no pending components (returns 200 with empty array/object),
        // the status should be 200 indicating authorization checks passed.
        expect(res.status).to.equal(200);
    });
});
