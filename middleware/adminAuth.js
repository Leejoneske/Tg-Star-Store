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

        // Compare with environment variable (constant-time comparison)
        const expectedToken = process.env.API_KEY;
        if (!expectedToken) {
            console.error('API_KEY environment variable not set');
            return res.status(500).json({ 
                success: false, 
                error: 'Server configuration error' 
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

// Rate limiting for admin endpoints
const adminRateLimit = {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: {
        success: false,
        error: 'Too many admin requests, please try again later'
    },
    standardHeaders: true,
    legacyHeaders: false,
};

// Audit logging for admin actions
const logAdminAction = (req, res, next) => {
    const originalSend = res.send;
    
    res.send = function(data) {
        // Log admin actions (without sensitive data)
        const logData = {
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.path,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            statusCode: res.statusCode,
            adminToken: req.adminToken ? 
                req.adminToken.substring(0, 8) + '...' : 
                'unknown'
        };
        
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