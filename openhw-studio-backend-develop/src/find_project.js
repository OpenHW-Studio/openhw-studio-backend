import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const Project = mongoose.model('Project', new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    board: String,
    components: Array,
    connections: Array,
    code: String
}, { collection: 'projects' }));

async function run() {
    try {
        console.log("Connecting to:", process.env.MONGO_URI);
        await mongoose.connect(process.env.MONGO_URI);
        const projects = await Project.find({});
        console.log("Found", projects.length, "projects");
        for (const p of projects) {
            const hasL293D = p.components.some(c => c.type.includes('l293d') || c.type.includes('motor-driver'));
            if (hasL293D) {
                console.log("Project ID:", p._id, "Board:", p.board);
                console.log("Components:", JSON.stringify(p.components));
                console.log("Connections:", JSON.stringify(p.connections));
            }
        }
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
run();
