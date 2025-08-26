const crypto = require('crypto');

// Secure admin authentication middleware
const requireAdminAuth = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader) {
            return res.status(401).json({ 
                success: false, 
                error: 'Authorization header required' 
            });
        }

        // Parse Authorization header properly
        const [scheme, token] = authHeader.split(' ');
        
        if (!scheme || !token) {
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid authorization format' 
            });
        }

        // Validate scheme
        if (scheme.toLowerCase() !== 'bearer') {
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid authorization scheme' 
            });
        }

        // Validate token format (should be a valid API key)
        if (!token || token.length < 32) {
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid token format' 
            });
        }

        // Get expected token from environment
        const expectedToken = process.env.API_KEY;
        if (!expectedToken) {
            console.error('API_KEY environment variable not set');
            return res.status(500).json({ 
                success: false, 
                error: 'Server configuration error' 
            });
        }

        // CRITICAL: Check lengths before timingSafeEqual to prevent exceptions
        if (token.length !== expectedToken.length) {
            return res.status(403).json({ 
                success: false, 
                error: 'Invalid credentials' 
            });
        }

        // Use constant-time comparison to prevent timing attacks
        if (!crypto.timingSafeEqual(
            Buffer.from(token, 'utf8'), 
            Buffer.from(expectedToken, 'utf8')
        )) {
            return res.status(403).json({ 
                success: false, 
                error: 'Invalid credentials' 
            });
        }

        // Add admin role to request
        req.isAdmin = true;
        req.adminToken = token; // For audit logging (masked)
        
        next();
    } catch (error) {
        console.error('Admin auth error:', error.message);
        return res.status(500).json({ 
            success: false, 
            error: 'Authentication error' 
        });
    }
};

// Rate limiting for admin endpoints (properly configured)
const rateLimit = require('express-rate-limit');

const adminRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: {
        success: false,
        error: 'Too many admin requests, please try again later'
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Add additional security headers
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
    // Custom key generator for better rate limiting
    keyGenerator: (req) => {
        return req.ip + ':' + (req.headers['x-forwarded-for'] || '');
    }
});

// Audit logging for admin actions (with comprehensive masking)
const logAdminAction = (req, res, next) => {
    const originalSend = res.send;
    
    res.send = function(data) {
        // Comprehensive masking of sensitive data
        const maskSensitiveData = (obj) => {
            if (!obj || typeof obj !== 'object') return obj;
            
            const masked = { ...obj };
            const sensitiveFields = [
                'password', 'token', 'api_key', 'secret', 'authorization',
                'cookie', 'session', 'auth', 'key', 'credential', 'Authorization',
                'AUTHORIZATION', 'Token', 'TOKEN', 'Api-Key', 'API-KEY',
                'x-api-key', 'x-auth-token', 'x-access-token', 'x-refresh-token',
                'x-csrf-token', 'x-xsrf-token', 'x-requested-with', 'x-forwarded-proto',
                'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-server',
                'x-original-url', 'x-rewrite-url', 'x-script-name', 'x-path-info',
                'x-http-method-override', 'x-http-method', 'x-method-override',
                'x-requested-with', 'x-ajax-request', 'x-requested-by', 'x-requested-for',
                'x-requested-from', 'x-requested-via', 'x-requested-through',
                'x-requested-using', 'x-requested-with', 'x-requested-by',
                'x-requested-for', 'x-requested-from', 'x-requested-via',
                'x-requested-through', 'x-requested-using', 'x-requested-with',
                'x-requested-by', 'x-requested-for', 'x-requested-from',
                'x-requested-via', 'x-requested-through', 'x-requested-using'
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
                const safeHeaderKeys = [
                    'user-agent', 'accept', 'content-type', 'content-length',
                    'host', 'origin', 'referer', 'x-forwarded-for', 'x-real-ip'
                ];
                
                for (const [key, value] of Object.entries(masked.headers)) {
                    const lowerKey = key.toLowerCase();
                    
                    // Only include safe headers
                    if (safeHeaderKeys.includes(lowerKey)) {
                        safeHeaders[key] = value;
                    } else if (sensitiveFields.some(field => 
                        lowerKey.includes(field.toLowerCase())
                    )) {
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
                    
                    // Check if field is in route allowlist
                    if (routeAllowlist.includes(key) || routeAllowlist.includes(lowerKey)) {
                        // For sensitive fields in allowlist, mask the value but keep the field
                        if (['walletaddress', 'wallet_address', 'txid', 'tx_id', 'userid', 'user_id'].includes(lowerKey)) {
                            const strValue = value?.toString() || '';
                            safeBody[key] = strValue.length > 8 ? 
                                strValue.substring(0, 4) + '...' + strValue.substring(strValue.length - 4) : 
                                '***MASKED***';
                        } else {
                            safeBody[key] = value;
                        }
                    } else if (sensitiveFields.some(field => 
                        lowerKey.includes(field.toLowerCase())
                    )) {
                        safeBody[key] = '***MASKED***';
                    } else {
                        // For unknown fields, use structured fallback logging
                        const strValue = value?.toString() || '';
                        if (strValue.length > 20) {
                            safeBody[key] = `[${typeof value}] ${strValue.substring(0, 20)}...`;
                        } else {
                            safeBody[key] = `[${typeof value}] ${strValue}`;
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

module.exports = {
    requireAdminAuth,
    adminRateLimit,
    logAdminAction
};