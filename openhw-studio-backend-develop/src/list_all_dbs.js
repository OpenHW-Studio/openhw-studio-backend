import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function run() {
    try {
        console.log("Connecting to:", process.env.MONGO_URI);
        await mongoose.connect(process.env.MONGO_URI);
        
        // List databases
        const adminDb = mongoose.connection.db.admin();
        const dbs = await adminDb.listDatabases();
        console.log("Databases:");
        for (const dbInfo of dbs.databases) {
            console.log(`- ${dbInfo.name}`);
            // Use that database
            const connection = mongoose.createConnection(`${process.env.MONGO_URI.substring(0, process.env.MONGO_URI.lastIndexOf('/'))}/${dbInfo.name}`);
            await new Promise(resolve => connection.once('open', resolve));
            const collections = await connection.db.listCollections().toArray();
            for (const col of collections) {
                const count = await connection.db.collection(col.name).countDocuments();
                console.log(`    * ${col.name} (${count} docs)`);
            }
            await connection.close();
        }
        
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
run();
