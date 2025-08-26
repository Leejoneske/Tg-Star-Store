const crypto = require('crypto');

// Secure Telegram ID validation and parsing
const validateTelegramId = (id) => {
    if (!id) return { valid: false, error: 'Telegram ID is required' };
    
    const idStr = id.toString().trim();
    
    // Check for valid numeric format
    if (!/^\d+$/.test(idStr)) {
        return { valid: false, error: 'Telegram ID must be numeric' };
    }
    
    // Check for reasonable length (Telegram IDs are typically 5-15 digits)
    if (idStr.length < 5 || idStr.length > 15) {
        return { valid: false, error: 'Invalid Telegram ID length' };
    }
    
    // Check for overflow (JavaScript Number.MAX_SAFE_INTEGER)
    const numId = parseInt(idStr, 10);
    if (numId > Number.MAX_SAFE_INTEGER || numId < 0) {
        return { valid: false, error: 'Telegram ID out of valid range' };
    }
    
    return { valid: true, id: numId, idStr };
};

// Validate transaction ID format
const validateTransactionId = (txId) => {
    if (!txId) return { valid: false, error: 'Transaction ID is required' };
    
    const txIdStr = txId.toString().trim();
    
    // Telegram payment charge IDs are typically alphanumeric with specific format
    if (!/^[a-zA-Z0-9_-]+$/.test(txIdStr)) {
        return { valid: false, error: 'Invalid transaction ID format' };
    }
    
    // Check length (Telegram charge IDs are typically 20-50 characters)
    if (txIdStr.length < 10 || txIdStr.length > 100) {
        return { valid: false, error: 'Invalid transaction ID length' };
    }
    
    return { valid: true, txId: txIdStr };
};

// Validate order ID format
const validateOrderId = (orderId) => {
    if (!orderId) return { valid: false, error: 'Order ID is required' };
    
    const orderIdStr = orderId.toString().trim();
    
    // Order IDs should be alphanumeric with specific format
    if (!/^[A-Z0-9_-]+$/.test(orderIdStr)) {
        return { valid: false, error: 'Invalid order ID format' };
    }
    
    // Check length
    if (orderIdStr.length < 5 || orderIdStr.length > 50) {
        return { valid: false, error: 'Invalid order ID length' };
    }
    
    return { valid: true, orderId: orderIdStr };
};

// Validate stars amount
const validateStarsAmount = (stars) => {
    if (!stars) return { valid: false, error: 'Stars amount is required' };
    
    const starsNum = parseInt(stars, 10);
    
    if (isNaN(starsNum)) {
        return { valid: false, error: 'Stars must be a valid number' };
    }
    
    if (starsNum <= 0 || starsNum > 1000000) {
        return { valid: false, error: 'Stars amount out of valid range' };
    }
    
    return { valid: true, stars: starsNum };
};

// Sanitize and validate refund reason
const validateRefundReason = (reason) => {
    if (!reason) return { valid: false, error: 'Refund reason is required' };
    
    const reasonStr = reason.toString().trim();
    
    // Check minimum length
    if (reasonStr.length < 10) {
        return { valid: false, error: 'Refund reason must be at least 10 characters' };
    }
    
    // Check maximum length
    if (reasonStr.length > 1000) {
        return { valid: false, error: 'Refund reason too long' };
    }
    
    // Check for suspicious content
    const suspiciousPatterns = [
        /<script/i,
        /javascript:/i,
        /on\w+\s*=/i,
        /data:text\/html/i
    ];
    
    for (const pattern of suspiciousPatterns) {
        if (pattern.test(reasonStr)) {
            return { valid: false, error: 'Refund reason contains invalid content' };
        }
    }
    
    return { valid: true, reason: reasonStr };
};

// Secure string comparison (constant-time)
const secureCompare = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    
    return crypto.timingSafeEqual(
        Buffer.from(a, 'utf8'),
        Buffer.from(b, 'utf8')
    );
};

// Mask sensitive data for logging
const maskSensitiveData = (data, fields = ['password', 'token', 'api_key', 'secret']) => {
    if (typeof data !== 'object' || data === null) {
        return data;
    }
    
    const masked = { ...data };
    
    for (const field of fields) {
        if (masked[field]) {
            const value = masked[field].toString();
            masked[field] = value.length > 8 ? 
                value.substring(0, 4) + '...' + value.substring(value.length - 4) : 
                '***';
        }
    }
    
    return masked;
};

// Validate request body schema
const validateRequestBody = (body, schema) => {
    const errors = [];
    
    for (const [field, validator] of Object.entries(schema)) {
        const value = body[field];
        const result = validator(value);
        
        if (!result.valid) {
            errors.push(`${field}: ${result.error}`);
        }
    }
    
    return {
        valid: errors.length === 0,
        errors,
        data: errors.length === 0 ? 
            Object.fromEntries(
                Object.entries(schema).map(([field, validator]) => [
                    field, 
                    validator(body[field]).value || body[field]
                ])
            ) : null
    };
};

module.exports = {
    validateTelegramId,
    validateTransactionId,
    validateOrderId,
    validateStarsAmount,
    validateRefundReason,
    secureCompare,
    maskSensitiveData,
    validateRequestBody
};