// API utility for StarStore frontend
class API {
    constructor() {
        this.baseURL = '/api';
        this.timeout = 10000;
    }

    // Generic request method with error handling
    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const config = {
            timeout: this.timeout,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            },
            ...options
        };

        try {
            const response = await fetch(url, config);
            
            // Handle non-JSON responses
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                throw new Error(`Invalid response type: ${contentType}`);
            }

            const data = await response.json();

            // Handle API errors
            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
            }

            return data;
        } catch (error) {
            console.error(`API request failed for ${endpoint}:`, error);
            
            // Provide user-friendly error messages
            if (error.name === 'TypeError' && error.message.includes('fetch')) {
                throw new Error('Network error. Please check your connection and try again.');
            }
            
            if (error.message.includes('timeout')) {
                throw new Error('Request timed out. Please try again.');
            }

            throw error;
        }
    }

    // GET request
    async get(endpoint, params = {}) {
        const queryString = new URLSearchParams(params).toString();
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        
        return this.request(url, {
            method: 'GET'
        });
    }

    // POST request
    async post(endpoint, data = {}) {
        return this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    // PUT request
    async put(endpoint, data = {}) {
        return this.request(endpoint, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    // DELETE request
    async delete(endpoint) {
        return this.request(endpoint, {
            method: 'DELETE'
        });
    }

    // Order-related API calls
    async getQuote(data) {
        return this.post('/quote', data);
    }

    async createOrder(orderData) {
        return this.post('/orders/create', orderData);
    }

    async createSellOrder(sellData) {
        return this.post('/sell-orders', sellData);
    }

    async getOrderHistory(userId) {
        return this.get(`/order-history/${userId}`);
    }

    async getOrderDetails(orderId) {
        return this.get(`/order-details/${orderId}`);
    }

    async getSellOrders(telegramId) {
        return this.get('/sell-orders', { telegramId });
    }

    async validateUsernames(usernames) {
        return this.post('/validate-usernames', { usernames });
    }

    async getWalletAddress() {
        return this.get('/get-wallet-address');
    }

    // Referral-related API calls
    async getReferralStats(userId) {
        return this.get(`/referral-stats/${userId}`);
    }

    async getReferralHistory(userId) {
        return this.get(`/referrals/${userId}`);
    }

    async getAvailableBalance(userId) {
        return this.get(`/available-balance/${userId}`);
    }

    async createWithdrawal(withdrawalData) {
        return this.post('/referral-withdrawals', withdrawalData);
    }

    async getWithdrawalHistory(userId) {
        return this.get(`/withdrawal-history/${userId}`);
    }

    // User-related API calls
    async getUserProfile(userId) {
        return this.get(`/users/profile/${userId}`);
    }

    async updateUserProfile(userId, profileData) {
        return this.put(`/users/profile/${userId}`, profileData);
    }

    async getUserStats(userId) {
        return this.get(`/users/stats/${userId}`);
    }

    // Transaction-related API calls
    async getTransactions(userId) {
        return this.get(`/transactions/${userId}`);
    }

    // Notification-related API calls
    async getNotifications(userId = 'all') {
        return this.get(`/notifications/${userId}`);
    }

    async markNotificationRead(notificationId) {
        return this.put(`/notifications/${notificationId}/read`);
    }

    // Sticker-related API calls
    async getStickerInfo(stickerId) {
        return this.get(`/sticker/${stickerId}/info`);
    }

    async getStickers(params = {}) {
        return this.get('/stickers', params);
    }

    async searchStickers(query) {
        return this.get('/stickers/search', { q: query });
    }

    // Health check
    async getHealthStatus() {
        return this.get('/health');
    }
}

// Global API instance
window.API = new API();

// Error handling utility
class APIErrorHandler {
    static handle(error, context = '') {
        console.error(`API Error in ${context}:`, error);
        
        let userMessage = 'An unexpected error occurred. Please try again.';
        
        if (error.message) {
            // Handle specific error types
            if (error.message.includes('Network error')) {
                userMessage = 'Network error. Please check your connection and try again.';
            } else if (error.message.includes('timeout')) {
                userMessage = 'Request timed out. Please try again.';
            } else if (error.message.includes('403')) {
                userMessage = 'Access denied. Please check your permissions.';
            } else if (error.message.includes('404')) {
                userMessage = 'Resource not found. Please check the URL.';
            } else if (error.message.includes('500')) {
                userMessage = 'Server error. Please try again later.';
            } else {
                // Use the actual error message if it's user-friendly
                userMessage = error.message;
            }
        }
        
        return userMessage;
    }

    static async showError(error, context = '') {
        const message = this.handle(error, context);
        
        if (window.Swal) {
            await Swal.fire({
                title: 'Error',
                text: message,
                icon: 'error',
                confirmButtonText: 'OK'
            });
        } else {
            alert(message);
        }
    }
}

// Global error handler
window.APIErrorHandler = APIErrorHandler;

// Utility for consistent data formatting
class DataFormatter {
    static formatCurrency(amount, currency = 'USDT') {
        if (typeof amount !== 'number') return '0.00';
        return `${amount.toFixed(2)} ${currency}`;
    }

    static formatDate(date) {
        if (!date) return 'N/A';
        return new Date(date).toLocaleDateString();
    }

    static formatDateTime(date) {
        if (!date) return 'N/A';
        return new Date(date).toLocaleString();
    }

    static formatStatus(status) {
        if (!status) return 'Unknown';
        return status.charAt(0).toUpperCase() + status.slice(1);
    }

    static truncateAddress(address, length = 8) {
        if (!address || address.length <= length * 2) return address;
        return `${address.substring(0, length)}...${address.substring(address.length - length)}`;
    }
}

// Global data formatter
window.DataFormatter = DataFormatter;