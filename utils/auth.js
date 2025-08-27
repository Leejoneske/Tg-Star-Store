function extractApiKey(req) {
    const headerKey = req.headers['x-api-key'];
    if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();
    const auth = req.headers['authorization'];
    if (!auth || typeof auth !== 'string') return null;
    const parts = auth.trim().split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer' && parts[1]) {
        return parts[1];
    }
    return null;
}

module.exports = { extractApiKey };

