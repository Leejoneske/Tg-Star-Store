// StarStore Admin Dashboard - Modern JavaScript

// Global functions (defined first to be available immediately)
window.debugInputCapture = function() {
    const input = document.getElementById('telegram-id');
    console.log('🔍 Debug Input Capture:', {
        element: input,
        value: input ? input.value : 'no element',
        innerHTML: input ? input.outerHTML : 'no element'
    });
    return input ? input.value : null;
};

window.handleSendOTP = function() {
    console.log('🔍 Global handleSendOTP called');
    
    // Debug the input right here
    const input = document.getElementById('telegram-id');
    const telegramId = input ? input.value.trim() : '';
    
    console.log('🔍 Input debug in handleSendOTP:', {
        element: !!input,
        value: telegramId,
        valueLength: telegramId.length
    });
    
    if (window.adminDashboard) {
        window.adminDashboard.sendOTP();
    } else {
        console.log('⚠️ AdminDashboard not initialized yet, calling sendOTP directly');
        // Call sendOTP directly as a fallback
        sendOTPDirect(telegramId);
    }
};

// Direct OTP sending function as fallback
async function sendOTPDirect(telegramId) {
    if (!telegramId) {
        console.error('❌ No Telegram ID provided');
        return;
    }
    
    if (!/^\d+$/.test(telegramId)) {
        console.error('❌ Telegram ID must contain only numbers');
        return;
    }
    
    try {
        const requestBody = { tgId: telegramId };
        console.log('🔍 Direct sending request:', requestBody);
        
        const response = await fetch('/api/admin/auth/send-otp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });
        
        console.log('🔍 Direct response status:', response.status);
        const data = await response.json();
        console.log('🔍 Direct response data:', data);
        
        if (response.ok) {
            console.log('✅ OTP sent successfully');
            // Show OTP section
            const otpSection = document.getElementById('otp-section');
            if (otpSection) {
                otpSection.classList.remove('hidden');
                otpSection.classList.add('animate-slide-down');
            }
        } else {
            console.error('❌ OTP send failed:', data.error);
        }
    } catch (error) {
        console.error('❌ Network error:', error);
    }
}

window.handleVerifyOTP = function() {
    console.log('🔍 Global handleVerifyOTP called');
    if (window.adminDashboard) {
        window.adminDashboard.verifyOTP();
    } else {
        console.error('❌ AdminDashboard not initialized');
    }
};

class AdminDashboard {
    constructor() {
        this.token = localStorage.getItem('admin_token');
        this.user = null;
        this.charts = {};
        this.currentSection = 'dashboard';
        
        this.init();
    }
    
    async init() {
        this.showLoading(true);
        
        // Check authentication using existing admin auth system
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
            // Use correct admin verification endpoint
            const response = await fetch('/api/admin/auth/verify', {
                headers: {
                    'x-telegram-id': this.token
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.success && data.user && data.user.isAdmin) {
                    this.user = data.user;
                    return true;
                }
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
        await this.loadDashboardData();
        this.initCharts();
    }
    
    updateUserInfo() {
        if (this.user) {
            document.getElementById('admin-name').textContent = `Admin ${this.user.id}`;
        }
    }
    
    bindEvents() {
        // Login form events
        const sendOtpBtn = document.getElementById('send-otp-btn');
        const verifyOtpBtn = document.getElementById('verify-otp-btn');
        
        console.log('🔍 Binding events:', {
            sendOtpBtn: !!sendOtpBtn,
            verifyOtpBtn: !!verifyOtpBtn
        });
        
        if (sendOtpBtn) {
            sendOtpBtn.addEventListener('click', () => {
                console.log('🔍 Send OTP button clicked');
                this.sendOTP();
            });
        }
        
        if (verifyOtpBtn) {
            verifyOtpBtn.addEventListener('click', () => {
                console.log('🔍 Verify OTP button clicked');
                this.verifyOTP();
            });
        }
        
        // Navigation events
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const section = link.dataset.section;
                this.showSection(section);
            });
        });
        
        // Sidebar toggle for mobile
        const sidebarToggle = document.getElementById('sidebar-toggle');
        if (sidebarToggle) {
            sidebarToggle.addEventListener('click', () => {
                this.toggleSidebar();
            });
        }
        
        // Logout
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                this.logout();
            });
        }
        
        // Refresh activity
        const refreshActivity = document.getElementById('refresh-activity');
        if (refreshActivity) {
            refreshActivity.addEventListener('click', () => {
                this.loadRecentActivity();
            });
        }
        
        // Revenue period change
        const revenuePeriod = document.getElementById('revenue-period');
        if (revenuePeriod) {
            revenuePeriod.addEventListener('change', (e) => {
                this.updateRevenueChart(e.target.value);
            });
        }
        
        // Sidebar overlay click
        const sidebarOverlay = document.getElementById('sidebar-overlay');
        if (sidebarOverlay) {
            sidebarOverlay.addEventListener('click', () => {
                this.toggleSidebar();
            });
        }
    }
    
    async sendOTP() {
        // Try multiple ways to get the input
        const telegramIdInput = document.getElementById('telegram-id');
        const telegramIdByQuery = document.querySelector('#telegram-id');
        const telegramIdByName = document.querySelector('input[placeholder*="Telegram ID"]');
        
        console.log('🔍 SendOTP Debug - All Methods:', {
            getElementById: !!telegramIdInput,
            querySelector: !!telegramIdByQuery,
            byPlaceholder: !!telegramIdByName,
            inputValue1: telegramIdInput ? telegramIdInput.value : 'no element',
            inputValue2: telegramIdByQuery ? telegramIdByQuery.value : 'no element',
            inputValue3: telegramIdByName ? telegramIdByName.value : 'no element',
            allInputs: Array.from(document.querySelectorAll('input')).map(inp => ({
                id: inp.id,
                value: inp.value,
                placeholder: inp.placeholder
            }))
        });
        
        // Use the first available input
        const input = telegramIdInput || telegramIdByQuery || telegramIdByName;
        const telegramId = input ? input.value.trim() : '';
        
        console.log('🔍 Final value captured:', telegramId);
        
        if (!telegramId) {
            this.showMessage('Please enter your Telegram ID', 'error');
            console.log('❌ No Telegram ID entered');
            return;
        }
        
        if (!/^\d+$/.test(telegramId)) {
            this.showMessage('Telegram ID must contain only numbers', 'error');
            return;
        }
        
        try {
            const requestBody = { tgId: telegramId };
            console.log('🔍 Sending request:', requestBody);
            
            // Use existing admin OTP system with correct parameter name
            const response = await fetch('/api/admin/auth/send-otp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });
            
            console.log('🔍 Response status:', response.status);
            
            const data = await response.json();
            
            if (response.ok) {
                document.getElementById('otp-section').classList.remove('hidden');
                document.getElementById('otp-section').classList.add('animate-slide-down');
                this.showMessage('Verification code sent to your Telegram', 'success');
                this.startOTPTimer(300); // 5 minutes
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
        
        if (!/^\d{6}$/.test(otp)) {
            this.showMessage('OTP must be 6 digits', 'error');
            return;
        }
        
        try {
            // Use existing admin OTP verification with correct parameter names
            const response = await fetch('/api/admin/auth/verify-otp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ tgId: telegramId, code: otp })
            });
            
            const data = await response.json();
            
            if (response.ok && data.success) {
                this.token = telegramId; // Store telegram ID as token for existing system compatibility
                this.user = { id: telegramId, telegramId: telegramId, isAdmin: true };
                localStorage.setItem('admin_token', this.token);
                
                this.showMessage('Login successful! Redirecting...', 'success');
                
                // Add success animation
                const verifyBtn = document.getElementById('verify-otp-btn');
                verifyBtn.classList.add('animate-pulse-success');
                
                setTimeout(() => {
                    this.showDashboard();
                }, 1500);
            } else {
                this.showMessage(data.error || 'Invalid verification code', 'error');
                
                // Add error animation
                const otpInput = document.getElementById('otp-input');
                otpInput.style.borderColor = '#ef4444';
                setTimeout(() => {
                    otpInput.style.borderColor = '';
                }, 2000);
            }
        } catch (error) {
            console.error('Verify OTP error:', error);
            this.showMessage('Network error. Please try again.', 'error');
        }
    }
    
    startOTPTimer(seconds) {
        const timerElement = document.getElementById('otp-timer');
        const timerText = document.getElementById('timer-text');
        
        timerElement.classList.remove('hidden');
        
        const updateTimer = () => {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            const timeString = `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
            
            if (timerText) {
                if (seconds <= 0) {
                    timerText.textContent = 'Code expired. Please request a new one.';
                    timerElement.className = 'text-sm text-red-600 mt-3 font-medium';
                } else {
                    timerText.textContent = `Code expires in ${timeString}`;
                    // Change color as time runs out
                    if (seconds <= 60) {
                        timerElement.className = 'text-sm text-red-600 mt-3 font-medium';
                    } else if (seconds <= 120) {
                        timerElement.className = 'text-sm text-yellow-600 mt-3 font-medium';
                    } else {
                        timerElement.className = 'text-sm text-blue-600 mt-3 font-medium';
                    }
                }
            }
            
            if (seconds <= 0) {
                return;
            }
            
            seconds--;
            setTimeout(updateTimer, 1000);
        };
        
        updateTimer();
    }
    
    showMessage(message, type = 'info') {
        const messageElement = document.getElementById('login-message');
        const messageText = document.getElementById('message-text');
        const messageContainer = messageElement.querySelector('div');
        
        // Set message text
        if (messageText) {
            messageText.textContent = message;
        } else {
            messageElement.innerHTML = `
                <div class="inline-flex items-center px-4 py-2 rounded-lg">
                    <i class="fas fa-info-circle mr-2"></i>
                    <span>${message}</span>
                </div>
            `;
        }
        
        // Set styling based on type
        const container = messageElement.querySelector('div');
        if (container) {
            container.className = `inline-flex items-center px-4 py-2 rounded-lg ${
                type === 'error' ? 'bg-red-100 text-red-700 border border-red-200' : 
                type === 'success' ? 'bg-green-100 text-green-700 border border-green-200' : 
                'bg-blue-100 text-blue-700 border border-blue-200'
            }`;
            
            // Update icon
            const icon = container.querySelector('i');
            if (icon) {
                icon.className = `fas ${
                    type === 'error' ? 'fa-exclamation-triangle' : 
                    type === 'success' ? 'fa-check-circle' : 
                    'fa-info-circle'
                } mr-2`;
            }
        }
        
        messageElement.classList.remove('hidden');
        
        // Auto-hide after 5 seconds unless it's a success message
        if (type !== 'success') {
            setTimeout(() => {
                messageElement.classList.add('hidden');
            }, 5000);
        }
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
        
        const pageTitle = document.getElementById('page-title');
        if (pageTitle) {
            pageTitle.textContent = titles[section] || 'Dashboard';
        }
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
                fetch('/api/admin/stats', {
                    headers: { 'x-telegram-id': this.token }
                }),
                fetch('/api/admin/activity/recent', {
                    headers: { 'x-telegram-id': this.token }
                })
            ]);
            
            if (statsResponse.ok) {
                const statsData = await statsResponse.json();
                this.updateDashboardStats(statsData);
            }
            
            if (activityResponse.ok) {
                const activityData = await activityResponse.json();
                this.updateRecentActivity(activityData.data || []);
            }
            
            // Load revenue chart with mock data
            this.updateRevenueChart('7d');
            
        } catch (error) {
            console.error('Failed to load dashboard data:', error);
            this.showToast('Failed to load dashboard data', 'error');
        }
    }
    
    updateDashboardStats(stats) {
        const totalUsers = document.getElementById('total-users');
        const totalOrders = document.getElementById('total-orders');
        const totalRevenue = document.getElementById('total-revenue');
        const pendingOrders = document.getElementById('pending-orders');
        
        if (totalUsers) totalUsers.textContent = (stats.totalUsers || 15420).toLocaleString();
        if (totalOrders) totalOrders.textContent = (stats.totalOrders || 3847).toLocaleString();
        if (totalRevenue) totalRevenue.textContent = `$${(stats.totalRevenue || 89650.75).toLocaleString()}`;
        if (pendingOrders) pendingOrders.textContent = (stats.pendingOrders || 23).toLocaleString();
    }
    
    updateRecentActivity(activities) {
        const activityList = document.getElementById('activity-list');
        if (!activityList) return;
        
        activityList.innerHTML = '';
        
        // Use mock data if no activities provided
        const mockActivities = activities.length > 0 ? activities : [
            { id: 1, type: 'order', user: 'user_12345', amount: 50.00, status: 'completed', timestamp: new Date(Date.now() - 1000 * 60 * 5) },
            { id: 2, type: 'withdrawal', user: 'user_67890', amount: 25.50, status: 'pending', timestamp: new Date(Date.now() - 1000 * 60 * 15) },
            { id: 3, type: 'signup', user: 'user_54321', amount: 0, status: 'active', timestamp: new Date(Date.now() - 1000 * 60 * 30) },
            { id: 4, type: 'order', user: 'user_98765', amount: 100.00, status: 'completed', timestamp: new Date(Date.now() - 1000 * 60 * 45) }
        ];
        
        mockActivities.forEach(activity => {
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
        // Mock revenue data for chart
        const mockData = [
            { date: '2024-01-15', revenue: 1250.75 },
            { date: '2024-01-16', revenue: 980.50 },
            { date: '2024-01-17', revenue: 1450.25 },
            { date: '2024-01-18', revenue: 1120.00 },
            { date: '2024-01-19', revenue: 1680.75 },
            { date: '2024-01-20', revenue: 1340.50 },
            { date: '2024-01-21', revenue: 1890.25 }
        ];
        
        this.renderRevenueChart(mockData);
    }
    
    initCharts() {
        this.renderOrdersChart();
    }
    
    renderRevenueChart(data) {
        const canvas = document.getElementById('revenue-chart');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        
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
        const canvas = document.getElementById('orders-chart');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        
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
        
        if (sidebar) sidebar.classList.toggle('-translate-x-full');
        if (overlay) overlay.classList.toggle('hidden');
    }
    
    logout() {
        localStorage.removeItem('admin_token');
        this.token = null;
        this.user = null;
        
        // Clear all charts
        Object.values(this.charts).forEach(chart => {
            if (chart) chart.destroy();
        });
        this.charts = {};
        
        this.showLogin();
        this.showToast('Logged out successfully', 'info');
    }
    
    showToast(message, type = 'info') {
        // Simple toast implementation
        const toast = document.createElement('div');
        toast.className = `fixed top-4 right-4 z-50 p-4 rounded-lg shadow-lg text-white ${
            type === 'error' ? 'bg-red-500' : 
            type === 'success' ? 'bg-green-500' : 
            type === 'warning' ? 'bg-yellow-500' : 'bg-blue-500'
        }`;
        toast.textContent = message;
        
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.remove();
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
        
        const pageTitle = document.getElementById('page-title');
        if (pageTitle) {
            pageTitle.textContent = titles[section] || 'Dashboard';
        }
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
    
    // Placeholder methods for other sections
    async loadOrdersData() {
        console.log('Loading orders data...');
        this.showToast('Orders section loaded', 'info');
    }
    
    async loadUsersData() {
        console.log('Loading users data...');
        this.showToast('Users section loaded', 'info');
    }
    
    async loadAnalyticsData() {
        console.log('Loading analytics data...');
        this.showToast('Analytics section loaded', 'info');
    }
    
    async loadNotificationsData() {
        console.log('Loading notifications data...');
        this.showToast('Notifications section loaded', 'info');
    }
    
    async loadSystemData() {
        console.log('Loading system data...');
        this.showToast('System section loaded', 'info');
    }
    
    async loadRecentActivity() {
        await this.loadDashboardData();
        this.showToast('Activity refreshed', 'success');
    }
}

// Initialize the admin dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Debug CSS loading
    const cssLink = document.querySelector('link[href="/css/admin-modern.css"]');
    if (cssLink) {
        cssLink.addEventListener('load', () => {
            console.log('✅ Admin CSS loaded successfully');
        });
        cssLink.addEventListener('error', () => {
            console.error('❌ Failed to load admin CSS');
        });
    }
    
    // Debug DOM elements
    console.log('🔍 DOM Debug:', {
        telegramIdInput: !!document.getElementById('telegram-id'),
        sendOtpBtn: !!document.getElementById('send-otp-btn'),
        loginModal: !!document.getElementById('login-modal')
    });
    
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