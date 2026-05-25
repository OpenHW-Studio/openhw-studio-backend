import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
    adminEmail: { type: String, required: true },
    action: { type: String, required: true }, // 'login', 'logout', 'approve_component', 'restart_service', etc.
    details: { type: String },
    timestamp: { type: Date, default: Date.now },
    ip: { type: String },
    metadata: { type: Object } // Store relevant IDs like componentId or serviceName
});

const AuditLog = mongoose.model('AuditLog', auditLogSchema);
export default AuditLog;
