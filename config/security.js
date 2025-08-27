// Unified security configuration for Helmet and related headers
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