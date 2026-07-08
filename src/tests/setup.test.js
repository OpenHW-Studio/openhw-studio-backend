import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongoServer;

before(function () {
    console.log("=== GLOBAL BEFORE HOOK STARTING ===");
    this.timeout(60000);

    return (async () => {
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-1234567890';
        process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-key-1234567890';
        process.env.NODE_ENV = 'test';

        console.log("Starting MongoMemoryServer...");
        mongoServer = await MongoMemoryServer.create();
        const mongoUri = mongoServer.getUri();
        console.log("In-Memory MongoDB started at:", mongoUri);

        process.env.MONGO_URI = mongoUri;

        console.log("Connecting Mongoose to:", mongoUri);
        await mongoose.connect(mongoUri);
        console.log("Mongoose connected. ReadyState:", mongoose.connection.readyState);
        console.log("=== GLOBAL BEFORE HOOK COMPLETE ===");
    })();
});

after(async () => {
    console.log("=== GLOBAL AFTER HOOK STARTING ===");
    await mongoose.disconnect();
    if (mongoServer) {
        await mongoServer.stop();
    }
    console.log("=== GLOBAL AFTER HOOK COMPLETE ===");
});
