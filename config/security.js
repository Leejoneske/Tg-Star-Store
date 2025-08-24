module.exports = {
    // Content Security Policy configuration
    csp: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: [
                "'self'", 
                "'unsafe-inline'", 
                "https://cdnjs.cloudflare.com", 
                "https://fonts.googleapis.com"
            ],
            scriptSrc: [
                "'self'", 
                "'unsafe-inline'", 
                "https://telegram.org", 
                "https://cdnjs.cloudflare.com", 
                "https://unpkg.com"
            ],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: [
                "'self'", 
                "https://api.telegram.org", 
                "https://ton.org"
            ],
            frameSrc: ["'self'", "https://telegram.org"],
            objectSrc: ["'none'"],
            fontSrc: [
                "'self'", 
                "https://fonts.gstatic.com", 
                "https://cdnjs.cloudflare.com"
            ],
            upgradeInsecureRequests: []
        }
    },

    // Permissions Policy configuration
    permissionsPolicy: {
        features: {
            geolocation: [],
            microphone: [],
            camera: [],
            payment: [],
            usb: [],
            magnetometer: [],
            gyroscope: [],
            accelerometer: [],
            autoplay: [],
            encryptedMedia: [],
            fullscreen: [],
            pictureInPicture: [],
            syncXhr: []
        }
    },

    // Rate limiting configuration
    rateLimit: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100, // limit each IP to 100 requests per windowMs
        message: {
            error: 'Too many requests from this IP, please try again later.',
            retryAfter: '15 minutes'
        }
    },

    // Sensitive endpoints rate limiting
    sensitiveRateLimit: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 10, // limit each IP to 10 requests per windowMs
        message: {
            error: 'Too many requests to sensitive endpoint, please try again later.',
            retryAfter: '15 minutes'
        }
    },

    // HSTS configuration
    hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true
    },

    // Frame guard configuration
    frameguard: {
        action: 'sameorigin' // Allow same-origin embedding
    },

    // Referrer policy
    referrerPolicy: {
        policy: 'strict-origin-when-cross-origin'
    }
};