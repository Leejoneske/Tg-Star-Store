// API utility for StarStore frontend (restored)
function API() {
    this.baseURL = '/api';
    this.timeout = 10000;
}

API.prototype.request = async function(endpoint, options = {}) {
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
};

API.prototype.get = async function(endpoint, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const url = queryString ? `${endpoint}?${queryString}` : endpoint;
    return this.request(url, { method: 'GET' });
};

API.prototype.post = async function(endpoint, data = {}) {
    return this.request(endpoint, { method: 'POST', body: JSON.stringify(data) });
};

// Daily methods
API.prototype.getDailyState = async function() { return this.get('/daily/state'); };
API.prototype.dailyCheckIn = async function() { return this.post('/daily/checkin'); };
API.prototype.getMissions = async function() { return this.get('/daily/missions'); };
API.prototype.completeMission = async function(missionId) { return this.post('/daily/missions/complete', { missionId }); };
API.prototype.redeemReward = async function(rewardId) { return this.post('/daily/redeem', { rewardId }); };
API.prototype.getRewards = async function() { return this.get('/daily/rewards'); };

// Leaderboard
API.prototype.getLeaderboard = async function(scope = 'global', wRef, wAct) { 
    const params = { scope };
    if (typeof wRef === 'number') params.wRef = wRef;
    if (typeof wAct === 'number') params.wAct = wAct;
    return this.get('/leaderboard', params); 
};

API.prototype.getQuote = async function(data) { return this.post('/quote', data); };
API.prototype.getWalletAddress = async function() { return this.get('/get-wallet-address'); };
API.prototype.createOrder = async function(orderData) { return this.post('/orders/create', orderData); };

// Create API instance and assign to window
window.API = new API();

// Verify the API object and methods
console.log('API object created:', window.API);
console.log('API constructor:', window.API.constructor.name);
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
