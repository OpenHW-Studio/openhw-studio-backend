import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import AuditLog from '../models/AuditLog.js';
import mongoose from 'mongoose';
import Project from '../models/Project.js';
import LiveSimulationSession from '../models/LiveSimulationSession.js';
import SystemConfig from '../models/systemConfig.js';

const execAsync = promisify(exec);

let cachedInfraStatus = null;
let lastInfraFetch = 0;
const CACHE_TTL = 10000; // 10 seconds

/**
 * Fetches the status of core Docker services (frontend, backend, mongodb)
 * Implements a 10s cache to prevent Docker daemon overhead.
 */
export const getInfrastructureStatus = async (req, res) => {
    const now = Date.now();
    
    // Return cached data if within TTL
    if (cachedInfraStatus && (now - lastInfraFetch < CACHE_TTL)) {
        return res.json({ success: true, services: cachedInfraStatus, cached: true });
    }

    try {
        // Command format: name,status,image,uptime,size
        // Optimized for Ubuntu/Linux environments
        const { stdout } = await execAsync("docker ps -s --format '{{.Names}}|{{.Status}}|{{.Image}}|{{.ID}}|{{.Size}}'");
        
        // Fetch resource usage (CPU/RAM)
        const { stdout: statsOut } = await execAsync("docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}'");
        const statsMap = statsOut.trim().split('\n').reduce((acc, line) => {
            const [name, cpu, mem, memPerc] = line.split('|');
            acc[name] = { cpu, mem, memPerc };
            return acc;
        }, {});

        const loadAvg = os.loadavg()[0].toFixed(2);

        const containers = stdout.trim().split('\n').filter(Boolean).map(line => {
            const [name, status, image, id, sizeInfo] = line.split('|');
            const size = sizeInfo ? sizeInfo.split(' (')[0] : '0B';
            const stats = statsMap[name] || { cpu: '0%', mem: '0B / 0B', memPerc: '0%' };
            return {
                name: name.replace(/_1$/, '').replace(/^simulator-/, ''),
                status: status.toLowerCase().includes('up') ? 'running' : 'stopped',
                version: image.split(':')[1] || 'latest',
                hash: id,
                uptime: status.replace(/^Up\s+/, ''),
                resources: {
                    ...stats,
                    storage: size,
                    load: loadAvg
                }
            };
        });

        // Ensure we include the requested services even if not found in docker ps
        const targetServices = ['frontend', 'backend', 'mongodb'];
        const services = targetServices.map(target => {
            const found = containers.find(c => c.name.includes(target));
            if (found) return found;
            return {
                name: target,
                status: 'offline',
                version: 'unknown',
                hash: 'N/A',
                uptime: '0s',
                resources: { cpu: '0%', mem: '0B', memPerc: '0%', storage: '0B', load: '0.00' }
            };
        });

        // Update cache
        cachedInfraStatus = services;
        lastInfraFetch = now;

        res.json({ success: true, services });
    } catch (error) {
        const isDockerMissing = error.message.includes('not recognized') || 
                               error.message.includes('not found') || 
                               error.code === 'ENOENT';
        
        if (!isDockerMissing) {
            console.error('Infrastructure Fetch Failed:', error.message);
        }

        // Fallback for local development environment
        const loadAvg = os.loadavg()[0].toFixed(2);
        const memUsage = process.memoryUsage();
        const memMb = (memUsage.rss / 1024 / 1024).toFixed(2);

        const localServices = [
            {
                name: 'frontend',
                status: 'running (local)',
                version: 'local-dev',
                hash: 'N/A',
                uptime: process.uptime().toFixed(0) + 's',
                resources: { cpu: 'N/A', mem: 'N/A', memPerc: 'N/A', storage: 'N/A', load: loadAvg }
            },
            {
                name: 'backend',
                status: 'running (local)',
                version: 'local-dev',
                hash: 'N/A',
                uptime: process.uptime().toFixed(0) + 's',
                resources: { cpu: 'N/A', mem: memMb + ' MB', memPerc: 'N/A', storage: 'N/A', load: loadAvg }
            },
            {
                name: 'mongodb',
                status: 'running (local)',
                version: 'local-dev',
                hash: 'N/A',
                uptime: 'N/A',
                resources: { cpu: 'N/A', mem: 'N/A', memPerc: 'N/A', storage: 'N/A', load: loadAvg }
            }
        ];

        res.json({
            success: true,
            error: 'Docker connectivity unavailable. Showing local fallback stats.',
            services: localServices
        });
    }};

let cachedLogs = null;
let lastLogFetch = 0;

/**
 * Fetches recent system and docker logs
 * Implements a 10s cache to minimize disk I/O
 */
export const getSystemLogs = async (req, res) => {
    const now = Date.now();
    if (cachedLogs && (now - lastLogFetch < CACHE_TTL)) {
        return res.json({ success: true, logs: cachedLogs, cached: true });
    }

    try {
        // Fetch last 50 lines from docker-compose if available
        let stdout = '';
        try {
            const result = await execAsync('docker compose logs --tail=50 --no-log-prefix');
            stdout = result.stdout;
        } catch (e) {
            // Docker not available, use system logs fallback
            stdout = 'Infrastructure monitoring inactive (Local Dev Mode)\nBackend: Active\nFrontend: Active\nMongoDB: Active';
        }
        
        const isDocker = stdout.includes('Active') || stdout.includes('|') || stdout.toLowerCase().includes('docker');
        
        const logs = stdout.split('\n').filter(Boolean).map(line => ({
            time: new Date().toISOString(),
            msg: line.trim(),
            type: line.toLowerCase().includes('error') ? 'error' : (isDocker ? 'docker' : 'info')
        }));

        cachedLogs = logs;
        lastLogFetch = now;

        res.json({ success: true, logs });
    } catch (error) {
        res.json({
            success: true,
            logs: [] // Return empty list instead of mock logs
        });
    }
};

/**
 * Restarts a specific Docker service
 * SECURITY: Uses strict whitelisting to prevent shell injection.
 */
export const restartService = async (req, res) => {
    const { name } = req.body;
    const allowedServices = ['frontend', 'backend', 'mongodb'];
    
    if (!name || !allowedServices.includes(name)) {
        return res.status(403).json({ error: 'Invalid or restricted service name.' });
    }

    try {
        // SECURITY: log action before executing
        await logAdminAction(
            req.user?.email || 'unknown-admin',
            'RESTART_SERVICE',
            `Requested restart for ${name}`,
            { service: name },
            req.ip
        );

        // SECURITY: Using execAsync with a whitelisted name is safe, 
        // but ideally we'd use a more direct docker-api in production.
        await execAsync(`docker compose restart ${name}`);
        res.json({ success: true, message: `${name} restarted successfully.` });
    } catch (error) {
        console.error(`Failed to restart ${name}:`, error);
        res.status(500).json({ success: false, error: `Failed to restart ${name}: ${error.message}` });
    }
};

/**
 * Fetches global usage analytics for the dashboard
 */
export const getUsageAnalytics = async (req, res) => {
    try {
        const totalSimulations = await Project.countDocuments();
        const activeSessions = await LiveSimulationSession.countDocuments({
            updatedAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) } // Sessions updated in last 30 mins
        });

        // Top Boards used (since I don't have library tracking yet)
        const boardUsage = await Project.aggregate([
            { $group: { _id: "$board", count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]);

        const topLibraries = boardUsage.map(b => ({
            name: b._id.toUpperCase(),
            count: b.count
        }));

        // Compilation success/fail real data would go here.
        // For now, we return an empty history if no logs exist.
        const compilationHistory = [];

        const sessions = await LiveSimulationSession.find({
            updatedAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) }
        }).select('lat lng teacherName').lean();

        const regions = sessions
            .filter(s => s.lat && s.lng)
            .map(s => ({
                lat: s.lat,
                lng: s.lng,
                label: s.teacherName || 'Anonymous',
                count: 1
            }));

        res.json({
            success: true,
            stats: {
                totalSimulations,
                activeSessions,
                avgCompileTime: 'N/A',
                storageUsed: 'N/A',
                peakConcurrency: 'N/A',
                topLibraries: topLibraries.length > 0 ? topLibraries : [],
                compilationHistory,
                regions: regions.length > 0 ? regions : []
            }
        });
    } catch (error) {
        console.error('Analytics Error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
};

/**
 * Fetches the audit history of admin actions
 */
export const getAuditHistory = async (req, res) => {
    try {
        const logs = await AuditLog.find().sort({ timestamp: -1 }).limit(100);
        res.json({ success: true, logs });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch audit history' });
    }
};

/**
 * Logs a new admin action (called internally)
 */
export const logAdminAction = async (adminEmail, action, details, metadata = {}, ip = '') => {
    try {
        await AuditLog.create({
            adminEmail,
            action,
            details,
            metadata,
            ip,
            timestamp: new Date()
        });
    } catch (e) {
        console.error('Audit Logging Failed:', e);
    }
};

/**
 * Public health check for the landing page.
 * Returns safe metadata without requiring auth.
 */
export const getPublicSystemStatus = async (req, res) => {
    try {
        // Reuse cached infra status if available
        let services = cachedInfraStatus;
        
        const activeSessions = await LiveSimulationSession.countDocuments({
            updatedAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) }
        });

        const maintenance = await SystemConfig.findOne({ key: 'maintenance_mode' });
        const isMaintenance = maintenance ? maintenance.value : false;

        const frontend = (services || []).find(s => s.name === 'frontend') || { version: 'N/A', status: 'unknown' };
        const backend = (services || []).find(s => s.name === 'backend') || { version: 'N/A', status: 'unknown' };

        res.json({
            success: true,
            status: {
                frontend: frontend.version,
                backend: isMaintenance ? 'Maintenance' : (backend.status === 'running' ? 'Operational' : 'Restricted'),
                database: 'Connected', 
                load: 'Normal',
                sessions: isMaintenance ? 0 : activeSessions,
                env: 'Production',
                maintenance: isMaintenance
            }
        });
    } catch (error) {
        res.json({
            success: true,
            status: {
                frontend: 'N/A',
                backend: 'Unknown',
                database: 'Disconnected', 
                load: 'N/A',
                sessions: 0,
                env: 'Production'
            }
        });
    }
};

/**
 * Toggles Maintenance Mode (Admin Only)
 */
export const toggleMaintenanceMode = async (req, res) => {
    const { enabled } = req.body;
    try {
        await SystemConfig.findOneAndUpdate(
            { key: 'maintenance_mode' },
            { $set: { value: !!enabled, updatedAt: new Date() } },
            { upsert: true, new: true }
        );

        await logAdminAction(
            req.user?.email || 'unknown-admin',
            'TOGGLE_MAINTENANCE',
            `Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'}`,
            { enabled },
            req.ip
        );

        res.json({ success: true, enabled });
    } catch (error) {
        res.status(500).json({ error: 'Failed to toggle maintenance mode' });
    }
};

/**
 * Gets Maintenance Status (Public)
 */
export const getMaintenanceStatus = async (req, res) => {
    try {
        const config = await SystemConfig.findOne({ key: 'maintenance_mode' });
        res.json({ success: true, enabled: config ? config.value : false });
    } catch (error) {
        res.json({ success: true, enabled: false }); // Fallback to live if DB fails
    }
};
