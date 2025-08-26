const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// Centralized admin authentication middleware
const requireAdminAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
        return res.status(401).json({ success: false, error: 'Authorization header required' });
    }

    // Parse Bearer token
    const parts = authHeader.trim().split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
        return res.status(401).json({ success: false, error: 'Invalid authorization format. Use: Bearer <token>' });
    }

    const token = parts[1];
    const expectedToken = process.env.API_KEY;

    if (!expectedToken) {
        console.error('API_KEY environment variable not set');
        return res.status(500).json({ success: false, error: 'Server configuration error' });
    }

    // CRITICAL: Check lengths before timingSafeEqual to prevent exceptions
    if (token.length !== expectedToken.length) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }

    // Timing-safe comparison
    if (!crypto.timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(expectedToken, 'utf8'))) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }

    req.isAdmin = true;
    req.adminToken = token;
    next();
};

// Rate limiting for admin endpoints
const adminRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: { success: false, error: 'Too many requests from this IP' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Audit logging for admin actions (with comprehensive masking)
const logAdminAction = (req, res, next) => {
    const originalSend = res.send;
    
    res.send = function(data) {
        // Comprehensive masking of sensitive data
        const maskSensitiveData = (obj) => {
            if (!obj || typeof obj !== 'object') return obj;
            
            const masked = { ...obj };
            
            // Normalized sensitive fields set (lowercase, no duplicates)
            const sensitiveFields = new Set([
                'password', 'token', 'api_key', 'secret', 'authorization',
                'cookie', 'session', 'auth', 'key', 'credential',
                'x-api-key', 'x-auth-token', 'x-access-token', 'x-refresh-token',
                'x-csrf-token', 'x-xsrf-token', 'x-requested-with', 'x-forwarded-proto',
                'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-server',
                'x-original-url', 'x-rewrite-url', 'x-script-name', 'x-path-info',
                'x-http-method-override', 'x-http-method', 'x-method-override',
                'x-ajax-request', 'x-requested-by', 'x-requested-for',
                'x-requested-from', 'x-requested-via', 'x-requested-through',
                'x-requested-using'
            ]);
            
            // Sensitive substrings that should trigger full masking
            const sensitiveSubstrings = [
                'password', 'secret', 'key', 'token', 'auth', 'credential',
                'wallet', 'address', 'private', 'seed', 'mnemonic', 'phrase'
            ];
            
            // Per-route allowlists for better observability
            const routeAllowlists = {
                '/api/refund-requests': [
                    'action', 'limit', 'offset', 'status', 'orderId', 'userId',
                    'reason', 'processedBy', 'processedAt', 'page', 'sort'
                ],
                '/api/referrals': [
                    'action', 'limit', 'offset', 'userId', 'amount', 'status',
                    'referrerId', 'referredId', 'dateCreated', 'page', 'sort'
                ],
                '/api/stickers': [
                    'action', 'limit', 'offset', 'set', 'type', 'emoji',
                    'sticker_id', 'file_unique_id', 'page', 'sort', 'search'
                ],
                '/api/users': [
                    'action', 'limit', 'offset', 'userId', 'username', 'status',
                    'isActive', 'lastSeen', 'page', 'sort', 'filter'
                ]
            };
            
            // Get current route for allowlist
            const currentRoute = req.path;
            const routeAllowlist = routeAllowlists[currentRoute] || [];
            
            // Mask headers - only log safe headers
            if (masked.headers) {
                const safeHeaders = {};
                const safeHeaderKeys = new Set([
                    'user-agent', 'accept', 'content-type', 'content-length',
                    'host', 'origin', 'referer'
                ]);
                
                for (const [key, value] of Object.entries(masked.headers)) {
                    const lowerKey = key.toLowerCase();
                    
                    // Only include safe headers
                    if (safeHeaderKeys.has(lowerKey)) {
                        safeHeaders[key] = value;
                    } else if (sensitiveFields.has(lowerKey)) {
                        // Mask sensitive headers
                        safeHeaders[key] = '***MASKED***';
                    }
                }
                masked.headers = safeHeaders;
            }
            
            // Mask body - use per-route allowlist or default masking
            if (masked.body) {
                const safeBody = {};
                
                for (const [key, value] of Object.entries(masked.body)) {
                    const lowerKey = key.toLowerCase();
                    const strValue = value?.toString() || '';
                    
                    // Check if field is in route allowlist
                    if (routeAllowlist.includes(key) || routeAllowlist.includes(lowerKey)) {
                        // For sensitive fields in allowlist, mask the value but keep the field
                        if (['walletaddress', 'wallet_address', 'txid', 'tx_id', 'userid', 'user_id'].includes(lowerKey)) {
                            safeBody[key] = strValue.length > 8 ? 
                                strValue.substring(0, 4) + '...' + strValue.substring(strValue.length - 4) : 
                                '***MASKED***';
                        } else {
                            safeBody[key] = value;
                        }
                    } else if (sensitiveFields.has(lowerKey)) {
                        safeBody[key] = '***MASKED***';
                    } else {
                        // Check for sensitive substrings in unknown fields
                        const hasSensitiveSubstring = sensitiveSubstrings.some(substr => 
                            lowerKey.includes(substr) || strValue.toLowerCase().includes(substr)
                        );
                        
                        if (hasSensitiveSubstring) {
                            safeBody[key] = '***SENSITIVE_FIELD_MASKED***';
                        } else {
                            // For unknown fields, use strict truncation
                            const maxLength = 10; // Reduced from 20 for security
                            if (strValue.length > maxLength) {
                                safeBody[key] = `[${typeof value}] ${strValue.substring(0, maxLength)}...`;
                            } else {
                                safeBody[key] = `[${typeof value}] ${strValue}`;
                            }
                        }
                    }
                }
                masked.body = safeBody;
            }
            
            return masked;
        };
        
        // Log admin actions (without sensitive data)
        const logData = maskSensitiveData({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.path,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            statusCode: res.statusCode,
            adminToken: req.adminToken ? 
                req.adminToken.substring(0, 4) + '...' + req.adminToken.substring(req.adminToken.length - 4) : 
                'unknown',
            headers: req.headers,
            body: req.body
        });
        
        console.log('Admin Action:', JSON.stringify(logData));
        
        originalSend.call(this, data);
    };
    
    next();
};

module.exports = { requireAdminAuth, adminRateLimit, logAdminAction };