// StarStore Admin Dashboard - Modern JavaScript

class AdminDashboard {
    constructor() {
        this.token = localStorage.getItem('admin_token');
        this.user = null;
        this.ws = null;
        this.charts = {};
        this.currentSection = 'dashboard';
        
        this.init();
    }
    
    async init() {
        this.showLoading(true);
        
        // Check authentication
        if (this.token) {
            const isValid = await this.verifyToken();
            if (isValid) {
                await this.showDashboard();
            } else {
                this.showLogin();
            }
        } else {
            this.showLogin();
        }
        
        this.bindEvents();
        this.showLoading(false);
    }
    
    showLoading(show) {
        const loadingScreen = document.getElementById('loading-screen');
        if (show) {
            loadingScreen.classList.remove('hidden');
        } else {
            loadingScreen.classList.add('hidden');
        }
    }
    
    showLogin() {
        document.getElementById('login-modal').classList.remove('hidden');
        document.getElementById('app').classList.add('hidden');
    }
    
    hideLogin() {
        document.getElementById('login-modal').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
    }
    
    async verifyToken() {
        try {
            const response = await fetch('/api/auth/me', {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                this.user = data.user;
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('Token verification failed:', error);
            return false;
        }
    }
    
    async showDashboard() {
        this.hideLogin();
        this.updateUserInfo();
        this.connectWebSocket();
        await this.loadDashboardData();
        this.initCharts();
    }
    
    updateUserInfo() {
        if (this.user) {
            document.getElementById('admin-name').textContent = `Admin ${this.user.telegramId}`;
        }
    }
    
    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        
        this.ws = new WebSocket(wsUrl);
        
        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.ws.send(JSON.stringify({
                type: 'subscribe',
                channels: ['dashboard', 'orders', 'users', 'system']
            }));
        };
        
        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleWebSocketMessage(data);
            } catch (error) {
                console.error('WebSocket message error:', error);
            }
        };
        
        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            // Attempt to reconnect after 5 seconds
            setTimeout(() => {
                if (this.token) {
                    this.connectWebSocket();
                }
            }, 5000);
        };
    }
    
    handleWebSocketMessage(data) {
        switch (data.channel) {
            case 'dashboard':
                this.updateDashboardStats(data.data);
                break;
            case 'orders':
                this.updateOrdersTable(data.data);
                break;
            case 'users':
                this.updateUsersTable(data.data);
                break;
            case 'system':
                this.updateSystemHealth(data.data);
                break;
        }
    }
    
    bindEvents() {
        // Login form events
        document.getElementById('send-otp-btn').addEventListener('click', () => this.sendOTP());
        document.getElementById('verify-otp-btn').addEventListener('click', () => this.verifyOTP());
        
        // Navigation events
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const section = link.dataset.section;
                this.showSection(section);
            });
        });
        
        // Sidebar toggle for mobile
        document.getElementById('sidebar-toggle').addEventListener('click', () => {
            this.toggleSidebar();
        });
        
        // Logout
        document.getElementById('logout-btn').addEventListener('click', () => {
            this.logout();
        });
        
        // Refresh activity
        document.getElementById('refresh-activity').addEventListener('click', () => {
            this.loadRecentActivity();
        });
        
        // Revenue period change
        document.getElementById('revenue-period').addEventListener('change', (e) => {
            this.updateRevenueChart(e.target.value);
        });
        
        // Sidebar overlay
        document.getElementById('sidebar-overlay').addEventListener('click', () => {
            this.toggleSidebar();
        });
    }
    
    async sendOTP() {
        const telegramId = document.getElementById('telegram-id').value.trim();
        
        if (!telegramId) {
            this.showMessage('Please enter your Telegram ID', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/auth/send-otp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ telegramId })
            });
            
            const data = await response.json();
            
            if (response.ok) {
                document.getElementById('otp-section').classList.remove('hidden');
                this.showMessage('Verification code sent to your Telegram', 'success');
                this.startOTPTimer(data.expiresIn || 300);
            } else {
                this.showMessage(data.error || 'Failed to send OTP', 'error');
            }
        } catch (error) {
            console.error('Send OTP error:', error);
            this.showMessage('Network error. Please try again.', 'error');
        }
    }
    
    async verifyOTP() {
        const telegramId = document.getElementById('telegram-id').value.trim();
        const otp = document.getElementById('otp-input').value.trim();
        
        if (!telegramId || !otp) {
            this.showMessage('Please enter both Telegram ID and OTP', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/auth/verify-otp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ telegramId, otp })
            });
            
            const data = await response.json();
            
            if (response.ok) {
                this.token = data.token;
                this.user = data.user;
                localStorage.setItem('admin_token', this.token);
                
                this.showMessage('Login successful!', 'success');
                setTimeout(() => {
                    this.showDashboard();
                }, 1000);
            } else {
                this.showMessage(data.error || 'Invalid verification code', 'error');
            }
        } catch (error) {
            console.error('Verify OTP error:', error);
            this.showMessage('Network error. Please try again.', 'error');
        }
    }
    
    startOTPTimer(seconds) {
        const timerElement = document.getElementById('otp-timer');
        timerElement.classList.remove('hidden');
        
        const updateTimer = () => {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            timerElement.textContent = `Code expires in ${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
            
            if (seconds <= 0) {
                timerElement.textContent = 'Code expired. Please request a new one.';
                return;
            }
            
            seconds--;
            setTimeout(updateTimer, 1000);
        };
        
        updateTimer();
    }
    
    showMessage(message, type = 'info') {
        const messageElement = document.getElementById('login-message');
        messageElement.textContent = message;
        messageElement.className = `text-sm text-center ${type === 'error' ? 'text-red-600' : type === 'success' ? 'text-green-600' : 'text-blue-600'}`;
        messageElement.classList.remove('hidden');
        
        setTimeout(() => {
            messageElement.classList.add('hidden');
        }, 5000);
    }
    
    showSection(section) {
        // Update navigation
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.section === section);
        });
        
        // Update sections
        document.querySelectorAll('.section').forEach(sec => {
            sec.classList.toggle('active', sec.id === `${section}-section`);
        });
        
        // Update page title
        const titles = {
            dashboard: 'Dashboard',
            orders: 'Order Management',
            users: 'User Management',
            analytics: 'Analytics & Reports',
            notifications: 'Notification Center',
            system: 'System Management'
        };
        
        document.getElementById('page-title').textContent = titles[section] || 'Dashboard';
        this.currentSection = section;
        
        // Load section-specific data
        this.loadSectionData(section);
    }
    
    async loadSectionData(section) {
        switch (section) {
            case 'dashboard':
                await this.loadDashboardData();
                break;
            case 'orders':
                await this.loadOrdersData();
                break;
            case 'users':
                await this.loadUsersData();
                break;
            case 'analytics':
                await this.loadAnalyticsData();
                break;
            case 'notifications':
                await this.loadNotificationsData();
                break;
            case 'system':
                await this.loadSystemData();
                break;
        }
    }
    
    async loadDashboardData() {
        try {
            const [statsResponse, activityResponse] = await Promise.all([
                fetch('/api/dashboard/stats', {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                }),
                fetch('/api/dashboard/activity', {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                })
            ]);
            
            if (statsResponse.ok) {
                const statsData = await statsResponse.json();
                this.updateDashboardStats(statsData.data);
            }
            
            if (activityResponse.ok) {
                const activityData = await activityResponse.json();
                this.updateRecentActivity(activityData.data);
            }
            
            // Load revenue chart data
            await this.updateRevenueChart('7d');
            
        } catch (error) {
            console.error('Failed to load dashboard data:', error);
            this.showToast('Failed to load dashboard data', 'error');
        }
    }
    
    updateDashboardStats(stats) {
        document.getElementById('total-users').textContent = stats.totalUsers.toLocaleString();
        document.getElementById('total-orders').textContent = stats.totalOrders.toLocaleString();
        document.getElementById('total-revenue').textContent = `$${stats.totalRevenue.toLocaleString()}`;
        document.getElementById('pending-orders').textContent = stats.pendingOrders.toLocaleString();
    }
    
    updateRecentActivity(activities) {
        const activityList = document.getElementById('activity-list');
        activityList.innerHTML = '';
        
        activities.forEach(activity => {
            const activityItem = this.createActivityItem(activity);
            activityList.appendChild(activityItem);
        });
    }
    
    createActivityItem(activity) {
        const item = document.createElement('div');
        item.className = 'activity-item';
        
        const iconColors = {
            order: 'bg-blue-500',
            withdrawal: 'bg-green-500',
            signup: 'bg-purple-500',
            login: 'bg-orange-500'
        };
        
        const icons = {
            order: 'fas fa-shopping-cart',
            withdrawal: 'fas fa-money-bill-wave',
            signup: 'fas fa-user-plus',
            login: 'fas fa-sign-in-alt'
        };
        
        item.innerHTML = `
            <div class="activity-icon ${iconColors[activity.type] || 'bg-gray-500'}">
                <i class="${icons[activity.type] || 'fas fa-circle'} text-white"></i>
            </div>
            <div class="activity-content">
                <div class="activity-title">${this.getActivityTitle(activity)}</div>
                <div class="activity-description">${this.getActivityDescription(activity)}</div>
            </div>
            <div class="activity-time">${this.formatTime(activity.timestamp)}</div>
        `;
        
        return item;
    }
    
    getActivityTitle(activity) {
        const titles = {
            order: 'New Order',
            withdrawal: 'Withdrawal Request',
            signup: 'New User Registration',
            login: 'User Login'
        };
        return titles[activity.type] || 'Activity';
    }
    
    getActivityDescription(activity) {
        switch (activity.type) {
            case 'order':
                return `${activity.user} placed an order for $${activity.amount}`;
            case 'withdrawal':
                return `${activity.user} requested withdrawal of $${activity.amount}`;
            case 'signup':
                return `${activity.user} joined the platform`;
            case 'login':
                return `${activity.user} logged in`;
            default:
                return `${activity.user} performed an action`;
        }
    }
    
    formatTime(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (minutes < 1) return 'Just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        return `${days}d ago`;
    }
    
    async updateRevenueChart(period) {
        try {
            const response = await fetch(`/api/dashboard/revenue?period=${period}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            
            if (response.ok) {
                const data = await response.json();
                this.renderRevenueChart(data.data);
            }
        } catch (error) {
            console.error('Failed to load revenue chart:', error);
        }
    }
    
    initCharts() {
        this.renderOrdersChart();
    }
    
    renderRevenueChart(data) {
        const ctx = document.getElementById('revenue-chart').getContext('2d');
        
        if (this.charts.revenue) {
            this.charts.revenue.destroy();
        }
        
        this.charts.revenue = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.map(item => new Date(item.date).toLocaleDateString()),
                datasets: [{
                    label: 'Revenue',
                    data: data.map(item => item.revenue),
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: function(value) {
                                return '$' + value.toLocaleString();
                            }
                        }
                    }
                }
            }
        });
    }
    
    renderOrdersChart() {
        const ctx = document.getElementById('orders-chart').getContext('2d');
        
        this.charts.orders = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Completed', 'Pending', 'Cancelled'],
                datasets: [{
                    data: [3824, 23, 15],
                    backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom'
                    }
                }
            }
        });
    }
    
    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        
        sidebar.classList.toggle('-translate-x-full');
        overlay.classList.toggle('hidden');
    }
    
    logout() {
        localStorage.removeItem('admin_token');
        this.token = null;
        this.user = null;
        
        if (this.ws) {
            this.ws.close();
        }
        
        // Clear all charts
        Object.values(this.charts).forEach(chart => {
            if (chart) chart.destroy();
        });
        this.charts = {};
        
        this.showLogin();
        this.showToast('Logged out successfully', 'info');
    }
    
    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        const icons = {
            success: 'fas fa-check-circle',
            error: 'fas fa-exclamation-circle',
            warning: 'fas fa-exclamation-triangle',
            info: 'fas fa-info-circle'
        };
        
        toast.innerHTML = `
            <i class="${icons[type]} text-${type === 'error' ? 'red' : type === 'success' ? 'green' : type === 'warning' ? 'yellow' : 'blue'}-500"></i>
            <span>${message}</span>
        `;
        
        container.appendChild(toast);
        
        setTimeout(() => {
            toast.remove();
        }, 5000);
    }
    
    async loadOrdersData() {
        // TODO: Implement orders data loading
        console.log('Loading orders data...');
    }
    
    async loadUsersData() {
        // TODO: Implement users data loading
        console.log('Loading users data...');
    }
    
    async loadAnalyticsData() {
        // TODO: Implement analytics data loading
        console.log('Loading analytics data...');
    }
    
    async loadNotificationsData() {
        // TODO: Implement notifications data loading
        console.log('Loading notifications data...');
    }
    
    async loadSystemData() {
        // TODO: Implement system data loading
        console.log('Loading system data...');
    }
    
    async loadRecentActivity() {
        await this.loadDashboardData();
        this.showToast('Activity refreshed', 'success');
    }
}

// Initialize the admin dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.adminDashboard = new AdminDashboard();
});

// Handle window resize for responsive charts
window.addEventListener('resize', () => {
    if (window.adminDashboard && window.adminDashboard.charts) {
        Object.values(window.adminDashboard.charts).forEach(chart => {
            if (chart) chart.resize();
        });
    }
});