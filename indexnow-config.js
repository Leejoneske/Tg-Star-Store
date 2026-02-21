// IndexNow Configuration for StarStore
// This configuration helps search engines index your website faster

// IndexNow API Key: You need to generate this from:
// https://www.indexnow.org/
// Then save it as an environment variable: INDEXNOW_KEY

const indexNowConfig = {
    // Your domain
    host: 'starstore.site',
    
    // Required: Your IndexNow API Key (set in .env as INDEXNOW_KEY)
    apiKey: process.env.INDEXNOW_KEY || null,
    
    // API Endpoints for IndexNow submission
    endpoints: {
        bing: 'https://www.bing.com/indexnow',
        yandex: 'https://yandex.com/indexnow'
    },
    
    // URLs to submit for indexing (add new URLs when you publish content)
    urlsToSubmit: [
        'https://starstore.site/',
        'https://starstore.site/about.html',
        'https://starstore.site/sell.html',
        'https://starstore.site/blog/',
        'https://starstore.site/knowledge-base/',
        'https://starstore.site/privacy-policy',
        'https://starstore.site/terms-of-service'
    ],
    
    // Optional: List of URL prefixes to update daily
    keyLocations: [
        `https://starstore.site/.well-known/IndexNow/${process.env.INDEXNOW_KEY || 'YOUR_KEY'}`
    ]
};

/**
 * Submit URLs to IndexNow for faster indexing
 * Call this function after publishing new content
 * 
 * @param {Array<string>} urls - URLs to submit
 * @param {string} keyLocation - Optional: Path to key file for verification
 */
async function submitToIndexNow(urls = indexNowConfig.urlsToSubmit, keyLocation = null) {
    if (!indexNowConfig.apiKey) {
        console.warn('⚠️ IndexNow: API key not configured. Set INDEXNOW_KEY in .env');
        return { success: false, error: 'API key missing' };
    }
    
    const payload = {
        host: indexNowConfig.host,
        key: indexNowConfig.apiKey,
        keyLocation: keyLocation || `https://${indexNowConfig.host}/.well-known/IndexNow/${indexNowConfig.apiKey}`,
        urlList: urls
    };
    
    try {
        // Submit to Bing
        const bingResponse = await fetch(indexNowConfig.endpoints.bing, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        console.log(`✅ IndexNow submitted to Bing: ${urls.length} URLs`);
        
        // Submit to Yandex
        const yandexResponse = await fetch(indexNowConfig.endpoints.yandex, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        console.log(`✅ IndexNow submitted to Yandex: ${urls.length} URLs`);
        
        return { success: true, bingStatus: bingResponse.status, yandexStatus: yandexResponse.status };
    } catch (error) {
        console.error('❌ IndexNow submission failed:', error.message);
        return { success: false, error: error.message };
    }
}

module.exports = { indexNowConfig, submitToIndexNow };
