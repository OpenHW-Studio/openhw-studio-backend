import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import AuditLog from '../models/AuditLog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import mongoose from 'mongoose';
import User from '../models/User.js';
import Project from '../models/Project.js';
import LiveSimulationSession from '../models/LiveSimulationSession.js';
import SystemConfig from '../models/systemConfig.js';
import { getStatus as getResourcePoolStatus, reloadBudget } from '../services/resourceManager.js';
import fs from 'fs';

const execAsync = promisify(exec);

let cachedInfraStatus = null;
let lastInfraFetch = 0;
const CACHE_TTL = 10000; // 10 seconds



// Helper to reliably construct docker compose command based on environment
const getComposeArgs = (...extraArgs) => {
    const projectDir = path.resolve(__dirname, '../../');
    const isDev = fs.existsSync(path.resolve(projectDir, 'docker-compose.yml'));
    
    const baseArgs = ['compose'];
    if (!isDev) {
        baseArgs.push('-f', 'docker-compose.prod.yml');
    }
    
    // We don't know the exact project name on the host (could be 'backend', 'app', etc).
    // But since docker-compose.prod.yml explicitly sets container_names, we can use those names 
    // to find the project name if we query Docker directly. However, it's easier to just let docker-compose 
    // figure it out if we pass the right project name, or we can just fetch logs manually.
    
    return [...baseArgs, ...extraArgs];
};

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
            const projectDir = path.resolve(__dirname, '../../');
            
            // Try to discover the exact project name used to deploy the stack
            let projectName = '';
            try {
                const { stdout: projOut } = await execAsync(`docker inspect openhw-backend -f '{{ index .Config.Labels "com.docker.compose.project" }}'`);
                projectName = projOut.trim();
            } catch (err) {
                // Ignore if container not found
            }

            let composeArgs = [];
            if (projectName) {
                composeArgs = getComposeArgs('-p', projectName, 'logs', '--no-color', '--tail=50');
            } else {
                composeArgs = getComposeArgs('logs', '--no-color', '--tail=50');
            }
            
            // execAsync throws on non-zero exit, so we must handle it, but we also want stderr if it succeeds.
            const result = await execAsync(`docker ${composeArgs.join(' ')}`, { cwd: projectDir });
            stdout = (result.stdout + '\n' + result.stderr).trim();
        } catch (e) {
            // If docker compose logs exits with error, it might still have partial output in e.stdout/e.stderr
            if (e.stdout || e.stderr) {
                stdout = ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
            } else {
                stdout = 'Infrastructure monitoring inactive (Local Dev Mode)\nBackend: Active\nFrontend: Active\nMongoDB: Active';
            }
        }
        
        const isDocker = stdout.includes('Active') || stdout.includes('|') || stdout.toLowerCase().includes('docker');
        
        const logs = stdout.split('\n').filter(Boolean).map(line => {
            let msgType = 'info';
            let cleanMsg = line.trim();
            
            if (isDocker) {
                const match = line.match(/^([a-zA-Z0-9-_]+)\s+\|\s+(.*)/);
                if (match) {
                    const containerName = match[1].toLowerCase();
                    cleanMsg = match[2].trim();
                    if (containerName.includes('frontend')) msgType = 'frontend';
                    else if (containerName.includes('backend')) msgType = 'backend';
                    else if (containerName.includes('mongo')) msgType = 'mongodb';
                    else if (containerName.includes('stm32')) msgType = 'stm32-worker';
                    else if (containerName.includes('esp32')) msgType = 'esp32-worker';
                    else if (containerName.includes('health')) msgType = 'health-agent';
                    else msgType = containerName;
                } else {
                    msgType = 'docker';
                }
            }

            if (cleanMsg.toLowerCase().includes('error')) {
                msgType = 'error';
            }

            return {
                time: new Date().toISOString(),
                msg: cleanMsg,
                type: msgType
            };
        });

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
    res.setHeader('X-Accel-Buffering', 'no'); // Important for NGINX to allow SSE
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ time: new Date().toISOString(), type: 'info', msg: `Connected to live log stream for ${service || 'all services'}` })}\n\n`);

    let streamClosed = false;
    const safeWrite = (data) => {
        if (!streamClosed && !res.writableEnded) {
            res.write(data);
        }
    };

    const extraArgs = ['logs', '--follow', '--tail=100'];
    if (service && service !== 'all') {
        extraArgs.push(service);
    }
    
    const args = getComposeArgs(...extraArgs);
    const projectDir = path.resolve(__dirname, '../../');

    // Check if docker is installed
    execAsync('docker -v').then(() => {
        const child = spawn('docker', args, { cwd: projectDir });

        const handleData = (data, type) => {
            const lines = data.toString().split('\n').filter(Boolean);
            for (const line of lines) {
                const safeLine = redactSensitiveData(line);
                let msgType = type === 'stderr' ? 'error' : 'docker';
                let cleanMsg = safeLine;
                
                // Try to extract container prefix (e.g., "frontend-1  | message")
                const match = safeLine.match(/^([a-zA-Z0-9-_]+)\s+\|\s+(.*)/);
                if (match) {
                    const containerName = match[1].toLowerCase();
                    cleanMsg = match[2];
                    if (containerName.includes('frontend')) msgType = 'frontend';
                    else if (containerName.includes('backend')) msgType = 'backend';
                    else if (containerName.includes('mongo')) msgType = 'mongodb';
                    else if (containerName.includes('stm32')) msgType = 'stm32-worker';
                    else if (containerName.includes('esp32')) msgType = 'esp32-worker';
                    else if (containerName.includes('health')) msgType = 'health-agent';
                    else msgType = containerName;
                }
                
                if (cleanMsg.toLowerCase().includes('error')) {
                    msgType = 'error';
                }

                const msgObj = {
                    time: new Date().toISOString(),
                    msg: cleanMsg.trim(),
                    type: msgType
                };
                safeWrite(`data: ${JSON.stringify(msgObj)}\n\n`);
            }
        };

        child.stdout.on('data', (data) => handleData(data, 'stdout'));
        child.stderr.on('data', (data) => handleData(data, 'stderr'));

        child.on('error', (err) => {
            console.error('Docker log stream error:', err);
            const safeError = redactSensitiveData(err.message);
            safeWrite(`data: ${JSON.stringify({ time: new Date().toISOString(), type: 'error', msg: 'Docker logs stream error: ' + safeError })}\n\n`);
            streamClosed = true;
            res.end();
        });

        child.on('close', (code) => {
            if (streamClosed) return;
            safeWrite(`data: ${JSON.stringify({ time: new Date().toISOString(), type: 'info', msg: `Log stream closed (exit code: ${code})` })}\n\n`);
            // Do NOT call res.end() here! If we close the connection, the browser's EventSource 
            // will immediately try to reconnect, causing an infinite SSE Error loop in the console.
            // Instead, just keep the connection alive with a periodic heartbeat.
            const idleInterval = setInterval(() => {
                safeWrite(`data: ${JSON.stringify({ time: new Date().toISOString(), type: 'info', msg: 'Stream idle' })}\n\n`);
            }, 10000);

            req.on('close', () => {
                clearInterval(idleInterval);
                streamClosed = true;
            });
        });

        req.on('close', () => {
            streamClosed = true;
            child.kill();
        });
    }).catch((err) => {
        // Fallback for Local Dev Mode (No Docker) or if docker command is missing
        const mockInterval = setInterval(() => {
            safeWrite(`data: ${JSON.stringify({ time: new Date().toISOString(), type: 'info', msg: 'Infrastructure monitoring inactive (Local Dev Mode)' })}\n\n`);
        }, 10000); // Ping every 10 seconds to keep connection alive

        req.on('close', () => {
            clearInterval(mockInterval);
            streamClosed = true;
        });
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
        const projectDir = path.resolve(__dirname, '../../');
        const composeCmd = getComposeArgs('restart', name).join(' ');
        await execAsync(`docker ${composeCmd}`, { cwd: projectDir });
        res.json({ success: true, message: `${name} restarted successfully.` });
    } catch (error) {
        console.error(`Failed to restart ${name}:`, error);
        res.status(500).json({ success: false, error: `Failed to restart ${name}: ${error.message}` });
    }
};

import SystemTelemetry from '../models/SystemTelemetry.js';
import VisitorPing from '../models/VisitorPing.js';

/**
 * Fetches global usage analytics and comprehensive visitor metrics for the admin dashboard
 */
export const getUsageAnalytics = async (req, res) => {
    try {
        const totalSimulations = await Project.countDocuments();
        
        const now = Date.now();
        const fifteenMinAgo = new Date(now - 15 * 60 * 1000);
        const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

        // Fetch counts across different timeframes
        const [
            activeSessions,
            todayVisitors,
            weekVisitors,
            monthVisitors,
            allTimeVisitors
        ] = await Promise.all([
            VisitorPing.countDocuments({ lastSeen: { $gte: fifteenMinAgo } }),
            VisitorPing.countDocuments({ lastSeen: { $gte: twentyFourHoursAgo } }),
            VisitorPing.countDocuments({ lastSeen: { $gte: sevenDaysAgo } }),
            VisitorPing.countDocuments({ lastSeen: { $gte: thirtyDaysAgo } }),
            VisitorPing.countDocuments({})
        ]);

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
        const sevenDaysDateStr = new Date(sevenDaysAgo).toISOString().split('T')[0];
        const rawTelemetry = await SystemTelemetry.find({
            date: { $gte: sevenDaysDateStr }
        }).sort({ date: 1 }).lean();

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

        // Fetch recent visitor documents (up to 150)
        const rawVisitors = await VisitorPing.find({})
            .sort({ lastSeen: -1 })
            .limit(150)
            .lean();

        const visitorList = rawVisitors.map(v => {
            const isLive = v.lastSeen && (new Date(v.lastSeen).getTime() >= fifteenMinAgo.getTime());
            return {
                id: v._id,
                sessionId: v.sessionId,
                ip: v.ip || 'Unknown IP',
                city: v.city || '',
                country: v.country || '',
                countryCode: v.countryCode || '',
                locationStr: v.locationStr || (v.city && v.country ? `${v.city}, ${v.country}` : (v.country || v.city || 'Unknown Location')),
                lat: v.lat || null,
                lng: v.lng || null,
                hitCount: v.hitCount || 1,
                userAgent: v.userAgent || '',
                firstSeen: v.firstSeen || v.createdAt || v.lastSeen,
                lastSeen: v.lastSeen,
                isLive: !!isLive
            };
        });

        // Group regions with valid coordinates for map markers
        const regionMap = {};
        rawVisitors.forEach(p => {
            if (p.lat != null && p.lng != null && !isNaN(p.lat) && !isNaN(p.lng)) {
                // Approximate grouping by 0.5 degrees for cluster proximity
                const latKey = (Math.round(p.lat * 2) / 2).toFixed(1);
                const lngKey = (Math.round(p.lng * 2) / 2).toFixed(1);
                const key = `${latKey},${lngKey}`;
                const isLive = p.lastSeen && (new Date(p.lastSeen).getTime() >= fifteenMinAgo.getTime());

                if (!regionMap[key]) {
                    const label = p.locationStr || (p.city && p.country ? `${p.city}, ${p.country}` : (p.country || p.ip || 'Global Node'));
                    regionMap[key] = {
                        id: key,
                        lat: p.lat,
                        lng: p.lng,
                        label,
                        city: p.city || '',
                        country: p.country || '',
                        count: 0,
                        activeCount: 0,
                        ips: new Set(),
                        lastSeen: p.lastSeen
                    };
                }
                regionMap[key].count += 1;
                if (isLive) regionMap[key].activeCount += 1;
                if (p.ip) regionMap[key].ips.add(p.ip);
                if (new Date(p.lastSeen) > new Date(regionMap[key].lastSeen)) {
                    regionMap[key].lastSeen = p.lastSeen;
                }
            }
        });

        const regions = Object.values(regionMap).map(r => ({
            ...r,
            uniqueIps: r.ips.size,
            ips: Array.from(r.ips).slice(0, 5) // preview top 5 IPs
        }));

        // Geographic country & city breakdowns
        const countryMap = {};
        const cityMap = {};
        rawVisitors.forEach(v => {
            const country = v.country || 'Unknown';
            countryMap[country] = (countryMap[country] || 0) + 1;

            if (v.city) {
                const cityLabel = v.country ? `${v.city}, ${v.country}` : v.city;
                cityMap[cityLabel] = (cityMap[cityLabel] || 0) + 1;
            }
        });

        const topCountries = Object.entries(countryMap)
            .map(([name, count]) => ({ name, count, percentage: rawVisitors.length > 0 ? Math.round((count / rawVisitors.length) * 100) : 0 }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const topCities = Object.entries(cityMap)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        // Compute 14-day visitor & pageview timeline
        const timelineMap = {};
        for (let i = 13; i >= 0; i--) {
            const d = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            timelineMap[d] = { date: d, visitors: 0, hits: 0 };
        }

        const deviceStats = { desktop: 0, mobile: 0, tablet: 0 };
        const browserStats = { chrome: 0, firefox: 0, safari: 0, edge: 0, other: 0 };

        rawVisitors.forEach(v => {
            const dateStr = v.lastSeen ? new Date(v.lastSeen).toISOString().split('T')[0] : null;
            if (dateStr && timelineMap[dateStr]) {
                timelineMap[dateStr].visitors += 1;
                timelineMap[dateStr].hits += (v.hitCount || 1);
            }

            // UserAgent parsing
            const ua = (v.userAgent || '').toLowerCase();
            if (/mobile|android|iphone|ipod/i.test(ua)) {
                deviceStats.mobile += 1;
            } else if (/ipad|tablet/i.test(ua)) {
                deviceStats.tablet += 1;
            } else {
                deviceStats.desktop += 1;
            }

            if (/edg\//i.test(ua)) {
                browserStats.edge += 1;
            } else if (/chrome|crios/i.test(ua)) {
                browserStats.chrome += 1;
            } else if (/firefox|fxios/i.test(ua)) {
                browserStats.firefox += 1;
            } else if (/safari/i.test(ua)) {
                browserStats.safari += 1;
            } else {
                browserStats.other += 1;
            }
        });

        const visitorTimeline = Object.values(timelineMap);

        // ─── Registered User Role Analytics (Student, Teacher, User, Admin) ─
        const [
            allTimeUsersByRole,
            todayUsersByRole,
            weekUsersByRole,
            monthUsersByRole,
            registrationTimelineRaw
        ] = await Promise.all([
            User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
            User.aggregate([{ $match: { createdAt: { $gte: twentyFourHoursAgo } } }, { $group: { _id: "$role", count: { $sum: 1 } } }]),
            User.aggregate([{ $match: { createdAt: { $gte: sevenDaysAgo } } }, { $group: { _id: "$role", count: { $sum: 1 } } }]),
            User.aggregate([{ $match: { createdAt: { $gte: thirtyDaysAgo } } }, { $group: { _id: "$role", count: { $sum: 1 } } }]),
            User.aggregate([
                { $match: { createdAt: { $gte: new Date(now - 14 * 24 * 60 * 60 * 1000) } } },
                {
                    $group: {
                        _id: {
                            date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                            role: "$role"
                        },
                        count: { $sum: 1 }
                    }
                }
            ])
        ]);

        const formatRoleCounts = (arr) => {
            const res = { student: 0, teacher: 0, user: 0, admin: 0, total: 0 };
            arr.forEach(item => {
                const role = item._id || 'user';
                if (res[role] !== undefined) {
                    res[role] = item.count;
                } else {
                    res.user += item.count;
                }
                res.total += item.count;
            });
            return res;
        };

        const registeredUsers = {
            allTime: formatRoleCounts(allTimeUsersByRole),
            today: formatRoleCounts(todayUsersByRole),
            week: formatRoleCounts(weekUsersByRole),
            month: formatRoleCounts(monthUsersByRole),
        };

        // Format 14-day registration timeline
        const regTimelineMap = {};
        for (let i = 13; i >= 0; i--) {
            const d = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            regTimelineMap[d] = { date: d, student: 0, teacher: 0, user: 0, total: 0 };
        }

        registrationTimelineRaw.forEach(item => {
            const date = item._id?.date;
            const role = item._id?.role || 'user';
            if (date && regTimelineMap[date]) {
                if (regTimelineMap[date][role] !== undefined) {
                    regTimelineMap[date][role] += item.count;
                } else {
                    regTimelineMap[date].user += item.count;
                }
                regTimelineMap[date].total += item.count;
            }
        });

        registeredUsers.timeline = Object.values(regTimelineMap);

        res.json({
            success: true,
            stats: {
                totalSimulations,
                activeSessions,
                todayVisitors,
                weekVisitors,
                monthVisitors,
                allTimeVisitors,
                avgCompileTime,
                storageUsed: 'N/A',
                peakConcurrency: activeSessions,
                topLibraries: topLibraries.length > 0 ? topLibraries : [],
                compilationHistory,
                regions,
                visitorList,
                topCountries,
                topCities,
                visitorTimeline,
                deviceStats,
                browserStats,
                registeredUsers
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
            'Manually triggered budget recalibration stress-test via Health Agent',
            {},
            req.ip
        );

        // Run calibration in background via Health Agent
        fetch('http://openhw-health-agent:8080/api/calibrate', { method: 'POST' })
            .then(() => {
                console.log('[Admin] Health Agent recalibration triggered successfully.');
                // We don't reload budget immediately since it runs async in the agent.
                // It can be reloaded later or polled.
            })
            .catch(err => {
                console.error('[Admin] Failed to trigger Health Agent recalibration:', err.message);
            });

        res.json({ success: true, message: 'Recalibration started in the Health Agent.' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to start recalibration' });
    }
};

const SCRIPTS_FILE = path.join('/app/data', 'calibration_scripts.json');

export const getCalibrationScripts = async (req, res) => {
    try {
        if (!fs.existsSync(SCRIPTS_FILE)) {
            return res.json({ success: true, data: {} });
        }
        const data = fs.readFileSync(SCRIPTS_FILE, 'utf8');
        res.setHeader('Content-Disposition', 'attachment; filename=calibration_scripts.json');
        res.setHeader('Content-Type', 'application/json');
        res.send(data);
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to read scripts' });
    }
};

export const updateCalibrationScripts = async (req, res) => {
    try {
        if (!req.files || !req.files.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }
        const fileContent = fs.readFileSync(req.files.file.tempFilePath, 'utf8');
        // Validate JSON
        JSON.parse(fileContent);
        
        fs.writeFileSync(SCRIPTS_FILE, fileContent);
        
        await logAdminAction(
            req.user?.email || 'unknown-admin',
            'UPDATE_CALIBRATION_SCRIPTS',
            'Updated calibration_scripts.json',
            {},
            req.ip
        );
        
        res.json({ success: true, message: 'Calibration scripts updated successfully.' });
    } catch (error) {
        res.status(400).json({ success: false, error: 'Invalid JSON or failed to save file' });
    }
};

export const getHostStatus = async (req, res) => {
    try {
        const isDocker = process.env.ROLE === 'main';
        const healthAgentUrl = isDocker ? 'http://openhw-health-agent:8080' : 'http://127.0.0.1:8080';
        
        const response = await fetch(`${healthAgentUrl}/api/status`);
        const data = await response.json();
        res.json({ success: true, host: data });
    } catch (error) {
        console.warn('[Admin] Failed to fetch host status from health agent (are you running locally on Windows?). Returning mock data.');
        
        // Return N/A data for local Windows development so the UI still renders but is obviously inactive
        const mockData = {
            cpu: "N/A",
            load_avg: "N/A",
            total_mem: "N/A",
            used_mem: "N/A",
            mem_pct: "N/A",
            total_disk: "N/A",
            free_disk: "0",
            uptime: "N/A (Local Dev)"
        };
        
        res.json({ success: true, host: mockData, isMock: true });
    }
};
