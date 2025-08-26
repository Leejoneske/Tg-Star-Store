/**
 * Telegram MarkdownV2 escaping utility
 * Based on Telegram's official MarkdownV2 specification
 */

// Characters that need escaping in MarkdownV2
const MARKDOWN_V2_ESCAPE_CHARS = [
    '_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'
];

// Escape text for Telegram MarkdownV2
const escapeMarkdownV2 = (text) => {
    if (!text || typeof text !== 'string') {
        return 'Unknown';
    }
    
    let escaped = text;
    
    // Escape all special characters
    for (const char of MARKDOWN_V2_ESCAPE_CHARS) {
        escaped = escaped.replace(new RegExp(`\\${char}`, 'g'), `\\${char}`);
    }
    
    return escaped;
};

// Escape inline code for Telegram MarkdownV2
const escapeInlineCode = (text) => {
    if (!text || typeof text !== 'string') {
        return 'Unknown';
    }
    
    // For inline code, we need to escape backticks and backslashes
    return text.replace(/[`\\]/g, '\\$&');
};

// Escape code blocks for Telegram MarkdownV2
const escapeCodeBlock = (text) => {
    if (!text || typeof text !== 'string') {
        return 'Unknown';
    }
    
    // For code blocks, we need to escape backticks and backslashes
    return text.replace(/[`\\]/g, '\\$&');
};

// Safe markdown formatting for user-facing messages
const safeMarkdown = (text, type = 'text') => {
    if (!text || typeof text !== 'string') {
        return 'Unknown';
    }
    
    switch (type) {
        case 'inline_code':
            return escapeInlineCode(text);
        case 'code_block':
            return escapeCodeBlock(text);
        case 'text':
        default:
            return escapeMarkdownV2(text);
    }
};

// Format admin notification with safe markdown
const formatAdminNotification = (data) => {
    const {
        orderId,
        username,
        userId,
        stars,
        reason,
        type = 'refund'
    } = data;
    
    const safeOrderId = safeMarkdown(orderId);
    const safeUsername = safeMarkdown(username);
    const safeUserId = safeMarkdown(userId);
    const safeStars = safeMarkdown(stars.toString());
    const safeReason = safeMarkdown(reason);
    
    let icon = '🔄';
    let title = 'Refund Request';
    
    switch (type) {
        case 'reversal':
            icon = '🔄';
            title = 'Reversal Request';
            break;
        case 'refund':
        default:
            icon = '💸';
            title = 'Refund Request';
            break;
    }
    
    return `${icon} ${title}\n` +
        `Order: ${safeOrderId}\n` +
        `User: @${safeUsername}\n` +
        `User ID: ${safeUserId}\n` +
        `Stars: ${safeStars}\n` +
        `Reason: ${safeReason}`;
};

// Validate markdown safety
const isMarkdownSafe = (text) => {
    if (!text || typeof text !== 'string') {
        return false;
    }
    
    // Check for potentially dangerous patterns
    const dangerousPatterns = [
        /<script/i,
        /javascript:/i,
        /on\w+\s*=/i,
        /data:text\/html/i,
        /vbscript:/i,
        /expression\(/i
    ];
    
    for (const pattern of dangerousPatterns) {
        if (pattern.test(text)) {
            return false;
        }
    }
    
    return true;
};

module.exports = {
    escapeMarkdownV2,
    escapeInlineCode,
    escapeCodeBlock,
    safeMarkdown,
    formatAdminNotification,
    isMarkdownSafe,
    MARKDOWN_V2_ESCAPE_CHARS
};