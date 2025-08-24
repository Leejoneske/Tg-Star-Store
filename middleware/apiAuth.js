const rateLimit = require('express-rate-limit');

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: '15 minutes'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Stricter rate limiting for sensitive endpoints
const sensitiveApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    message: {
        error: 'Too many requests to sensitive endpoint, please try again later.',
        retryAfter: '15 minutes'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Authentication middleware for sensitive API endpoints
const requireApiAuth = (req, res, next) => {
    // Check for API key in headers
    const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
    
    if (!apiKey) {
        return res.status(401).json({
            error: 'API key required',
            message: 'Please provide a valid API key in the Authorization header'
        });
    }
    
    // Validate API key (you can implement your own validation logic)
    if (apiKey !== process.env.API_KEY) {
        return res.status(403).json({
            error: 'Invalid API key',
            message: 'The provided API key is invalid'
        });
    }
    
    next();
};

// Logging middleware for API requests
const apiLogger = (req, res, next) => {
    const start = Date.now();
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
    });
    
    next();
};

module.exports = {
    apiLimiter,
    sensitiveApiLimiter,
    requireApiAuth,
    apiLogger
};