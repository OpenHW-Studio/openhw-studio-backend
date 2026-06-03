import SystemTelemetry from '../models/SystemTelemetry.js';
import VisitorPing from '../models/VisitorPing.js';

/**
 * Log a compilation attempt
 * @param {boolean} success - Whether the compile succeeded
 * @param {number} timeMs - Elapsed time in ms
 */
export async function logCompileTelemetry(success, timeMs) {
    try {
        const date = new Date().toISOString().split('T')[0];
        
        const update = {
            $inc: {
                totalCompileTimeMs: timeMs || 0,
            }
        };
        
        if (success) {
            update.$inc.compileSuccess = 1;
        } else {
            update.$inc.compileFail = 1;
        }

        await SystemTelemetry.findOneAndUpdate(
            { date },
            update,
            { upsert: true, new: true }
        );
    } catch (err) {
        console.error('[TelemetryService] Failed to log compile telemetry:', err.message);
    }
}

/**
 * Log an active visitor ping
 */
export async function logVisitorPing(sessionId, ip, lat, lng) {
    try {
        if (!sessionId) return;
        
        await VisitorPing.findOneAndUpdate(
            { sessionId },
            { 
                ip, 
                lat: lat || null, 
                lng: lng || null,
                lastSeen: new Date()
            },
            { upsert: true, new: true }
        );
    } catch (err) {
        console.error('[TelemetryService] Failed to log visitor ping:', err.message);
    }
}

/**
 * Express middleware to automatically log compile telemetry
 */
export function compileTelemetryMiddleware(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
        // Only log if it's a compile attempt (POST request to root or start endpoints)
        if (req.method === 'POST') {
            const elapsed = Date.now() - start;
            // Treat 200-level as success, everything else as failure
            const success = res.statusCode >= 200 && res.statusCode < 300;
            logCompileTelemetry(success, elapsed);
        }
    });
    next();
}

/**
 * Express route handler for /api/public/ping
 */
export async function handleVisitorPingExpress(req, res) {
    const { sessionId, lat, lng, locationStr } = req.body || {};
    // Extract IP from X-Forwarded-For if behind a proxy, otherwise req.ip
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    
    // Store locationStr in place of IP for the map label if available
    const displayLabel = locationStr || ip;
    
    if (sessionId) {
        await logVisitorPing(sessionId, displayLabel, lat, lng);
    }
    
    res.json({ success: true });
}
