import { expect } from 'chai';
import mongoose from 'mongoose';
import User from '../../models/User.js';
import Class from '../../models/Class.js';
import Assignment from '../../models/Assignment.js';
import Submission from '../../models/Submission.js';

describe('🗄️ Database Models Schema Validation Tests', () => {
    // Clear all collections before each test to ensure complete isolation
    beforeEach(async () => {
        await User.deleteMany({});
        await Class.deleteMany({});
        await Assignment.deleteMany({});
        await Submission.deleteMany({});
    });

    describe('👤 User Model Validation', () => {
        // Required Fields Tests
        it('should fail validation when required fields are missing', async () => {
            // Arrange
            const user = new User({});

            // Act & Assert
            try {
                await user.validate();
                throw new Error('Validation succeeded on empty User object');
            } catch (err) {
                expect(err.name).to.equal('ValidationError');
                expect(err.errors).to.have.property('name');
            }
        });

        // Default values
        it('should assign correct default values for coins, points, level, etc.', async () => {
            // Arrange
            const user = new User({
                name: 'Viraj Shah',
                email: 'viraj@iitb.ac.in'
            });

            // Act
            await user.validate();

            // Assert
            expect(user.role).to.equal('student');
            expect(user.is_first_login).to.be.true;
            expect(user.points).to.equal(0);
            expect(user.coins).to.equal(0);
            expect(user.level).to.equal(1);
            expect(user.badges).to.be.an('array').that.is.empty;
            expect(user.projects).to.be.an('array').that.is.empty;
        });

        // Enum checks
        it('should reject invalid roles and accept valid ones', async () => {
            // Arrange
            const invalidUser = new User({
                name: 'Hacker',
                email: 'hacker@iitb.ac.in',
                role: 'superadmin' // Invalid role enum
            });

            const validStudent = new User({
                name: 'Student',
                email: 'student@iitb.ac.in',
                role: 'student'
            });

            const validTeacher = new User({
                name: 'Teacher',
                email: 'teacher@iitb.ac.in',
                role: 'teacher'
            });

            // Act & Assert
            try {
                await invalidUser.validate();
                throw new Error('Validation succeeded on invalid role enum');
            } catch (err) {
                expect(err.name).to.equal('ValidationError');
                expect(err.errors.role.message).to.include('is not a valid enum value');
            }

            await validStudent.validate();
            await validTeacher.validate();
        });

        // Uniqueness constraint
        it('should enforce unique email constraint', async () => {
            // Arrange
            const user1 = new User({
                name: 'User One',
                email: 'duplicate@iitb.ac.in'
            });
            const user2 = new User({
                name: 'User Two',
                email: 'duplicate@iitb.ac.in' // Same email
            });

            // Act & Assert
            await user1.save();
            try {
                await user2.save();
                throw new Error('Saved duplicate email address successfully');
            } catch (err) {
                expect(err.code).to.equal(11000); // MongoDB duplicate key code
            }
        });

        // Type casting checks
        it('should fail validation (CastError) when an array is passed to the string name field', async () => {
            // Arrange
            const user = new User({
                name: ['Viraj', 'Shah'], // Array passed to string
                email: 'casting@iitb.ac.in'
            });

            // Act & Assert
            try {
                await user.validate();
                throw new Error('Validation succeeded on array value for string field');
            } catch (err) {
                expect(err.name).to.equal('ValidationError');
                expect(err.errors).to.have.property('name');
                expect(err.errors.name.name).to.equal('CastError');
            }
        });
    });

    describe('🏫 Class Model Validation', () => {
        let teacherId;

        beforeEach(async () => {
            const teacher = await User.create({
                name: 'Teacher Name',
                email: 'teacher@iitb.ac.in',
                role: 'teacher'
            });
            teacherId = teacher._id;
        });

        it('should fail validation when required fields are missing', async () => {
            // Arrange
            const classObj = new Class({});

            // Act & Assert
            try {
                await classObj.validate();
                throw new Error('Validation succeeded on empty Class object');
            } catch (err) {
                expect(err.name).to.equal('ValidationError');
                expect(err.errors).to.have.property('name');
                expect(err.errors).to.have.property('teacher');
                expect(err.errors).to.have.property('joinCode');
            }
        });

        it('should reject invalid teacher ObjectId reference', async () => {
            // Arrange
            const classObj = new Class({
                name: 'CS 101',
                teacher: 'not-a-valid-object-id',
                joinCode: 'CS101A'
            });

            // Act & Assert
            try {
                await classObj.validate();
                throw new Error('Validation succeeded with invalid teacher ObjectId');
            } catch (err) {
                expect(err.name).to.equal('ValidationError');
                expect(err.errors).to.have.property('teacher');
                expect(err.errors.teacher.name).to.equal('CastError');
            }
        });

        it('should successfully save a valid Classroom', async () => {
            // Arrange
            const classObj = new Class({
                name: 'Embedded Systems',
                teacher: teacherId,
                joinCode: 'EMB101'
            });

            // Act
            await classObj.validate();
            const savedClass = await classObj.save();

            // Assert
            expect(savedClass._id).to.exist;
            expect(savedClass.joinCode).to.equal('EMB101');
            expect(savedClass.students).to.be.an('array').that.is.empty;
        });

        it('should enforce unique joinCode constraint', async () => {
            // Arrange
            const class1 = new Class({
                name: 'Class One',
                teacher: teacherId,
                joinCode: 'UNIQUE123'
            });
            const class2 = new Class({
                name: 'Class Two',
                teacher: teacherId,
                joinCode: 'UNIQUE123' // Duplicate
            });

            // Act & Assert
            await class1.save();
            try {
                await class2.save();
                throw new Error('Saved duplicate joinCode successfully');
            } catch (err) {
                expect(err.code).to.equal(11000);
            }
        });
    });

    describe('📝 Assignment Model Validation', () => {
        let teacherId;
        let classId;

        beforeEach(async () => {
            const teacher = await User.create({
                name: 'Teacher Name',
                email: 'teacher@iitb.ac.in',
                role: 'teacher'
            });
            teacherId = teacher._id;

            const classObj = await Class.create({
                name: 'Embedded Systems',
                teacher: teacherId,
                joinCode: 'EMB101'
            });
            classId = classObj._id;
        });

        it('should fail validation when required fields are missing', async () => {
            // Arrange
            const assignment = new Assignment({});

            // Act & Assert
            try {
                await assignment.validate();
                throw new Error('Validation succeeded on empty Assignment object');
            } catch (err) {
                expect(err.name).to.equal('ValidationError');
                expect(err.errors).to.have.property('title');
                expect(err.errors).to.have.property('classId');
                expect(err.errors).to.have.property('createdBy');
            }
        });

        it('should successfully save a valid Assignment with default values', async () => {
            // Arrange
            const assignment = new Assignment({
                title: 'Blink LED Homework',
                classId: classId,
                createdBy: teacherId
            });

            // Act
            await assignment.validate();
            const saved = await assignment.save();

            // Assert
            expect(saved._id).to.exist;
            expect(saved.isAutogradingEnabled).to.be.false;
            expect(saved.attachments).to.be.an('array').that.is.empty;
        });
    });

    describe('📤 Submission Model Validation', () => {
        let studentId;
        let teacherId;
        let classId;
        let assignmentId;

        beforeEach(async () => {
            const student = await User.create({
                name: 'Student Name',
                email: 'student@iitb.ac.in',
                role: 'student'
            });
            studentId = student._id;

            const teacher = await User.create({
                name: 'Teacher Name',
                email: 'teacher@iitb.ac.in',
                role: 'teacher'
            });
            teacherId = teacher._id;

            const classObj = await Class.create({
                name: 'Embedded Systems',
                teacher: teacherId,
                joinCode: 'EMB101'
            });
            classId = classObj._id;

            const assignment = await Assignment.create({
                title: 'Blink LED Homework',
                classId: classId,
                createdBy: teacherId
            });
            assignmentId = assignment._id;
        });

        it('should fail validation when required fields are missing', async () => {
            // Arrange
            const submission = new Submission({});

            // Act & Assert
            try {
                await submission.validate();
                throw new Error('Validation succeeded on empty Submission object');
            } catch (err) {
                expect(err.name).to.equal('ValidationError');
                expect(err.errors).to.have.property('assignmentId');
                expect(err.errors).to.have.property('studentId');
                expect(err.errors).to.have.property('classId');
            }
        });

        it('should enforce unique compound index of assignmentId and studentId', async () => {
            // Arrange
            const submission1 = new Submission({
                assignmentId: assignmentId,
                studentId: studentId,
                classId: classId,
                simulationShareId: 'SHARE1'
            });
            const submission2 = new Submission({
                assignmentId: assignmentId,
                studentId: studentId, // Same student
                classId: classId,
                simulationShareId: 'SHARE2'
            });

            // Act & Assert
            await submission1.save();
            try {
                await submission2.save();
                throw new Error('Saved duplicate student submission for same assignment');
            } catch (err) {
                expect(err.code).to.equal(11000); // Duplicate key
            }
        });

        it('should successfully save a valid Submission', async () => {
            // Arrange
            const submission = new Submission({
                assignmentId: assignmentId,
                studentId: studentId,
                classId: classId,
                notes: 'Here is my solution code.'
            });

            // Act
            await submission.validate();
            const saved = await submission.save();

            // Assert
            expect(saved._id).to.exist;
            expect(saved.notes).to.equal('Here is my solution code.');
        });
    });
});
