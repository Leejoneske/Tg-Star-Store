// API utility for StarStore frontend (restored)
class API {
    constructor() {
        this.baseURL = '/api';
        this.timeout = 10000;
    }

    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const config = {
            timeout: this.timeout,
            headers: {
                'Content-Type': 'application/json',
                ...(window.Telegram?.WebApp?.initData ? { 'x-telegram-init-data': window.Telegram.WebApp.initData } : {}),
                ...(window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? { 'x-telegram-id': window.Telegram.WebApp.initDataUnsafe.user.id } : {}),
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

window.API = new API();
