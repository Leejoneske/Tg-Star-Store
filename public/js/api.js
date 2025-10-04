// API utility for StarStore frontend (restored)
window.API = {
    baseURL: (() => {
        // If we're accessing from localhost or the page is served from localhost, use localhost API
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            return 'http://localhost:3000/api';
        }
        // Otherwise use relative path (production)
        return '/api';
    })(),
    timeout: 10000,
    
    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        console.log(`🌐 API Request: ${options.method || 'GET'} ${url}`);
        
        // Get authentication headers
        let authHeaders = {};
        
        // Try to get Telegram WebApp data
        if (window.Telegram?.WebApp?.initData) {
            authHeaders['x-telegram-init-data'] = window.Telegram.WebApp.initData;
        }
        if (window.Telegram?.WebApp?.initDataUnsafe?.user?.id) {
            authHeaders['x-telegram-id'] = window.Telegram.WebApp.initDataUnsafe.user.id;
        }
        
        // Fallback for development/testing when not in Telegram
        if (!authHeaders['x-telegram-id'] && !authHeaders['x-telegram-init-data']) {
            // Use real Telegram ID for testing
            authHeaders['x-telegram-id'] = '5107333540';
            console.log('Using test Telegram ID:', authHeaders['x-telegram-id']);
        }
        
        const config = {
            timeout: this.timeout,
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders,
                ...options.headers
            },
            ...options
        };

        const resp = await fetch(url, config);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
    },

    async get(endpoint, params = {}) {
        const queryString = new URLSearchParams(params).toString();
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        return this.request(url, { method: 'GET' });
    },

    async post(endpoint, data = {}) {
        return this.request(endpoint, { method: 'POST', body: JSON.stringify(data) });
    },

    // Daily methods
    async getDailyState() { return this.get('/daily/state'); },
    async dailyCheckIn() { return this.post('/daily/checkin'); },
    async getMissions() { return this.get('/daily/missions'); },
    async completeMission(missionId) { return this.post('/daily/missions/complete', { missionId }); },
    async redeemReward(rewardId) { return this.post('/daily/redeem', { rewardId }); },
    async getRewards() { return this.get('/daily/rewards'); },

    // Leaderboard
    async getLeaderboard(scope = 'global', wRef, wAct) { 
        const params = { scope };
        if (typeof wRef === 'number') params.wRef = wRef;
        if (typeof wAct === 'number') params.wAct = wAct;
        return this.get('/leaderboard', params); 
    },

    async getQuote(data) { return this.post('/quote', data); },
    async getWalletAddress() { return this.get('/get-wallet-address'); },
    async createOrder(orderData) { return this.post('/orders/create', orderData); }
};

// Verify the API object and methods
console.log('🌐 API Base URL:', window.API.baseURL);
console.log('API object created:', window.API);
console.log('API methods:', {
    getDailyState: typeof window.API.getDailyState,
    dailyCheckIn: typeof window.API.dailyCheckIn,
    getMissions: typeof window.API.getMissions,
    getLeaderboard: typeof window.API.getLeaderboard,
    completeMission: typeof window.API.completeMission
});

// Test one method to ensure it works
try {
    console.log('Testing API method binding...');
    const testMethod = window.API.getDailyState;
    console.log('getDailyState method:', typeof testMethod);
} catch (error) {
    console.error('API method test failed:', error);
}
