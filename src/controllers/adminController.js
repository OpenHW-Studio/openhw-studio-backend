import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import AuditLog from '../models/AuditLog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import mongoose from 'mongoose';
import Project from '../models/Project.js';
import LiveSimulationSession from '../models/LiveSimulationSession.js';
import SystemConfig from '../models/systemConfig.js';
import { getStatus as getResourcePoolStatus, reloadBudget } from '../services/resourceManager.js';
import { runCalibration } from '../services/calibrationSuite.js';

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
        const targetServices = ['frontend', 'backend', 'mongodb', 'esp32-worker', 'stm32-worker', 'health-agent'];
        const services = targetServices.map(target => {
            const found = containers.find(c => c.name.includes(target));
            if (found) {
                found.name = target; // Normalize name to service name for restart/logs
                return found;
            }
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
            },
            {
                name: 'esp32-worker',
                status: 'offline (local)',
                version: 'local-dev',
                hash: 'N/A',
                uptime: 'N/A',
                resources: { cpu: 'N/A', mem: 'N/A', memPerc: 'N/A', storage: 'N/A', load: loadAvg }
            },
            {
                name: 'stm32-worker',
                status: 'offline (local)',
                version: 'local-dev',
                hash: 'N/A',
                uptime: 'N/A',
                resources: { cpu: 'N/A', mem: 'N/A', memPerc: 'N/A', storage: 'N/A', load: loadAvg }
            },
            {
                name: 'health-agent',
                status: 'offline (local)',
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
            const projectDir = path.resolve(__dirname, '../../../');
            const result = await execAsync('docker compose logs --tail=50 --no-log-prefix', { cwd: projectDir });
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

const redactSensitiveData = (text) => {
    let redacted = text;
    // Replace typical tokens, passwords, JWT secrets.
    redacted = redacted.replace(/(password|secret|token|key|pwd)\s*[:=]\s*['"]?[^\s'"]+['"]?/gi, '$1=[REDACTED]');
    // Hide Bearer tokens
    redacted = redacted.replace(/Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/gi, 'Bearer [REDACTED]');
    return redacted;
};

/**
 * Streams live system and docker logs using Server-Sent Events (SSE)
 */
export const streamSystemLogs = (req, res) => {
    const { service } = req.query; // 'all', 'backend', 'esp32-worker', 'stm32-worker'
    
    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ time: new Date().toISOString(), type: 'info', msg: `Connected to live log stream for ${service || 'all services'}` })}\n\n`);

    const args = ['compose', 'logs', '--follow', '--tail=100', '--no-log-prefix'];
    if (service && service !== 'all') {
        args.push(service);
    }

    const projectDir = path.resolve(__dirname, '../../../');
    const child = spawn('docker', args, { cwd: projectDir });

    const handleData = (data, type) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
            const safeLine = redactSensitiveData(line);
            const msgObj = {
                time: new Date().toISOString(),
                msg: safeLine.trim(),
                type: safeLine.toLowerCase().includes('error') ? 'error' : (type === 'stderr' ? 'error' : 'docker')
            };
            res.write(`data: ${JSON.stringify(msgObj)}\n\n`);
        }
    };

    child.stdout.on('data', (data) => handleData(data, 'stdout'));
    child.stderr.on('data', (data) => handleData(data, 'stderr'));

    child.on('error', (err) => {
        console.error('Docker log stream error:', err);
        const safeError = redactSensitiveData(err.message);
        res.write(`data: ${JSON.stringify({ time: new Date().toISOString(), type: 'error', msg: 'Docker logs stream error: ' + safeError })}\n\n`);
        res.end();
    });

    child.on('close', () => {
        res.write(`data: ${JSON.stringify({ time: new Date().toISOString(), type: 'info', msg: 'Log stream closed' })}\n\n`);
        res.end();
    });

    req.on('close', () => {
        child.kill();
    });
};

/**
 * Restarts a specific Docker service
 * SECURITY: Uses strict whitelisting to prevent shell injection.
 */
export const restartService = async (req, res) => {
    const { name } = req.body;
    const allowedServices = ['frontend', 'backend', 'mongodb', 'esp32-worker', 'stm32-worker', 'health-agent'];
    
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
        const projectDir = path.resolve(__dirname, '../../../');
        await execAsync(`docker compose restart ${name}`, { cwd: projectDir });
        res.json({ success: true, message: `${name} restarted successfully.` });
    } catch (error) {
        console.error(`Failed to restart ${name}:`, error);
        res.status(500).json({ success: false, error: `Failed to restart ${name}: ${error.message}` });
    }
};

import SystemTelemetry from '../models/SystemTelemetry.js';
import VisitorPing from '../models/VisitorPing.js';

/**
 * Fetches global usage analytics for the dashboard
 */
export const getUsageAnalytics = async (req, res) => {
    try {
        const totalSimulations = await Project.countDocuments();
        
        // Fetch active sessions from the new VisitorPing model
        const activeSessions = await VisitorPing.countDocuments({
            lastSeen: { $gte: new Date(Date.now() - 15 * 60 * 1000) } // Last 15 minutes
        });

        // Top Boards used
        const boardUsage = await Project.aggregate([
            { $group: { _id: "$board", count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]);

        const topLibraries = boardUsage.map(b => ({
            name: b._id ? b._id.toUpperCase() : 'UNKNOWN',
            count: b.count
        }));

        // Fetch last 7 days of compilation telemetry
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const rawTelemetry = await SystemTelemetry.find({
            date: { $gte: sevenDaysAgo }
        }).sort({ date: 1 }).lean();

        // Calculate average compile time across the 7 days
        let totalSuccess = 0;
        let totalFail = 0;
        let grandTotalCompileTime = 0;

        const compilationHistory = rawTelemetry.map(t => {
            totalSuccess += (t.compileSuccess || 0);
            totalFail += (t.compileFail || 0);
            grandTotalCompileTime += (t.totalCompileTimeMs || 0);
            
            return {
                date: t.date,
                success: t.compileSuccess || 0,
                fail: t.compileFail || 0
            };
        });
        
        const totalCompiles = totalSuccess + totalFail;
        const avgCompileTimeMs = totalCompiles > 0 ? (grandTotalCompileTime / totalCompiles) : 0;
        const avgCompileTime = avgCompileTimeMs > 0 ? (avgCompileTimeMs / 1000).toFixed(2) + 's' : 'N/A';

        // Extract geographic regions from active pings
        const activePings = await VisitorPing.find({
            lastSeen: { $gte: new Date(Date.now() - 15 * 60 * 1000) },
            lat: { $exists: true, $ne: null },
            lng: { $exists: true, $ne: null }
        }).lean();

        // Group regions by roughly similar lat/lng to show counts on the map
        const regionMap = {};
        activePings.forEach(p => {
            const key = `${Math.round(p.lat)},${Math.round(p.lng)}`;
            if (!regionMap[key]) {
                regionMap[key] = { lat: p.lat, lng: p.lng, label: p.ip || 'Anonymous', count: 0 };
            }
            regionMap[key].count += 1;
        });

        const regions = Object.values(regionMap);

        res.json({
            success: true,
            stats: {
                totalSimulations,
                activeSessions,
                avgCompileTime,
                storageUsed: 'N/A', // Cloud storage is handled externally for now
                peakConcurrency: activeSessions, // Approximation
                topLibraries: topLibraries.length > 0 ? topLibraries : [],
                compilationHistory,
                regions
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

/**
 * Gets the current status of the unified resource manager pool (Admin Only)
 */
export const getResourceStatus = async (req, res) => {
    try {
        const status = getResourcePoolStatus();
        res.json({ success: true, ...status });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch resource pool status' });
    }
};

/**
 * Manually triggers calibration in the background (Admin Only)
 */
export const recalibrate = async (req, res) => {
    try {
        await logAdminAction(
            req.user?.email || 'unknown-admin',
            'RECALIBRATE_RESOURCES',
            'Manually triggered budget recalibration stress-test',
            {},
            req.ip
        );

        // Run calibration in background to avoid blocking request timeout
        runCalibration().then(() => {
            reloadBudget();
            console.log('[Admin] Background recalibration successfully completed.');
        }).catch(err => {
            console.error('[Admin] Background recalibration failed:', err);
        });

        res.json({ success: true, message: 'Recalibration started in the background.' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to start recalibration' });
    }
};

