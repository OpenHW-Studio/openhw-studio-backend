import mongoose from 'mongoose';
import geoip from 'geoip-lite';
import SystemTelemetry from '../models/SystemTelemetry.js';
import VisitorPing from '../models/VisitorPing.js';

/**
 * Log a compilation attempt
 * @param {boolean} success - Whether the compile succeeded
 * @param {number} timeMs - Elapsed time in ms
 */
export async function logCompileTelemetry(success, timeMs) {
    if (mongoose.connection.readyState !== 1) return;
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
export async function logVisitorPing(data) {
    try {
        const { sessionId, ip, lat, lng, locationStr, city, country, countryCode, userAgent } = data;
        if (!sessionId) return;

        const update = {
            $set: {
                ip: ip || 'Unknown IP',
                lat: typeof lat === 'number' ? lat : (lat ? parseFloat(lat) : null),
                lng: typeof lng === 'number' ? lng : (lng ? parseFloat(lng) : null),
                locationStr: locationStr || '',
                city: city || '',
                country: country || '',
                countryCode: countryCode || '',
                userAgent: userAgent || '',
                lastSeen: new Date()
            },
            $inc: { hitCount: 1 },
            $setOnInsert: { firstSeen: new Date() }
        };
        
        await VisitorPing.findOneAndUpdate(
            { sessionId },
            update,
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
 * Performs server-side IP detection and geo-resolution via geoip-lite
 */
export async function handleVisitorPingExpress(req, res) {
    try {
        const { sessionId } = req.body || {};
        if (!sessionId) {
            return res.json({ success: false, message: 'No sessionId provided' });
        }
        
        // Extract client IP
        let rawIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                    req.headers['x-real-ip'] || 
                    req.socket.remoteAddress || 
                    req.ip || 
                    '';

        if (rawIp.startsWith('::ffff:')) {
            rawIp = rawIp.replace('::ffff:', '');
        }
        if (rawIp === '::1' || rawIp === 'localhost') {
            rawIp = '127.0.0.1';
        }

        const isLocalIp = rawIp === '127.0.0.1' || 
                          rawIp.startsWith('192.168.') || 
                          rawIp.startsWith('10.') || 
                          rawIp.startsWith('172.16.') ||
                          rawIp.startsWith('172.31.');

        let lat = null;
        let lng = null;
        let city = '';
        let country = '';
        let countryCode = '';
        let locationStr = isLocalIp ? 'Localhost / Dev' : '';

        // Server-side IP lookup using geoip-lite
        if (!isLocalIp && rawIp) {
            const geo = geoip.lookup(rawIp);
            if (geo) {
                if (geo.ll && geo.ll.length >= 2) {
                    lat = geo.ll[0];
                    lng = geo.ll[1];
                }
                city = geo.city || '';
                country = geo.country || '';
                countryCode = geo.country || '';
                locationStr = [city, country].filter(Boolean).join(', ');
            }
        }

        const userAgent = req.headers['user-agent'] || '';

        await logVisitorPing({
            sessionId,
            ip: rawIp,
            lat,
            lng,
            locationStr,
            city,
            country,
            countryCode,
            userAgent
        });
        
        res.json({ success: true });
    } catch (err) {
        console.error('[TelemetryService] Ping Error:', err.message);
        res.json({ success: false });
    }
}
