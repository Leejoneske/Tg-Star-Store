// API utility for StarStore frontend (restored)
class API {
    constructor() {
        this.baseURL = '/api';
        this.timeout = 10000;
    }

    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        
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
            // Use a default user ID for development
            authHeaders['x-telegram-id'] = 'dev-user-' + Math.random().toString(36).substr(2, 9);
            console.log('Using development user ID:', authHeaders['x-telegram-id']);
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
    }

    async get(endpoint, params = {}) {
        const queryString = new URLSearchParams(params).toString();
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        return this.request(url, { method: 'GET' });
    }

    async post(endpoint, data = {}) {
        return this.request(endpoint, { method: 'POST', body: JSON.stringify(data) });
    }

    // Daily
    async getDailyState() { return this.get('/daily/state'); }
    async dailyCheckIn() { return this.post('/daily/checkin'); }
    async getMissions() { return this.get('/daily/missions'); }
    async completeMission(missionId) { return this.post('/daily/missions/complete', { missionId }); }
    async redeemReward(rewardId) { return this.post('/daily/redeem', { rewardId }); }
    async getRewards() { return this.get('/daily/rewards'); }

    // Leaderboard
    async getLeaderboard(scope = 'global', wRef, wAct) { 
        const params = { scope };
        if (typeof wRef === 'number') params.wRef = wRef;
        if (typeof wAct === 'number') params.wAct = wAct;
        return this.get('/leaderboard', params); 
    }
    async getQuote(data) { return this.post('/quote', data); }
    async getWalletAddress() { return this.get('/get-wallet-address'); }
    async createOrder(orderData) { return this.post('/orders/create', orderData); }
}

// Create API instance
const apiInstance = new API();

// Ensure methods are properly bound
window.API = {
    ...apiInstance,
    getDailyState: apiInstance.getDailyState.bind(apiInstance),
    dailyCheckIn: apiInstance.dailyCheckIn.bind(apiInstance),
    getMissions: apiInstance.getMissions.bind(apiInstance),
    completeMission: apiInstance.completeMission.bind(apiInstance),
    getLeaderboard: apiInstance.getLeaderboard.bind(apiInstance),
    redeemReward: apiInstance.redeemReward.bind(apiInstance),
    getRewards: apiInstance.getRewards.bind(apiInstance),
    getQuote: apiInstance.getQuote.bind(apiInstance),
    getWalletAddress: apiInstance.getWalletAddress.bind(apiInstance),
    createOrder: apiInstance.createOrder.bind(apiInstance)
};

console.log('API object created:', window.API);
console.log('API methods available:', Object.keys(window.API));
