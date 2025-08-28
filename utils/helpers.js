// Utility functions
function generateOrderId() {
    return Array.from({ length: 6 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
}

function sanitizeUsername(username) {
    if (!username) return null;
    return username.replace(/[^\w\d_]/g, '');
}

module.exports = {
    generateOrderId,
    sanitizeUsername
};