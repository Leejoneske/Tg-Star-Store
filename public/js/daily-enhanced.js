// Enhanced Daily Rewards System with advanced features
// Author: StarStore Team
// Version: 2.0

class DailyRewardsSystem {
    constructor() {
        this.storage = new PersistentStorage();
        this.achievements = new AchievementManager();
        this.streakManager = new StreakManager();
        this.notificationManager = new NotificationManager();
        this.animationEngine = new AnimationEngine();
        this.rewardRedemption = new RewardRedemption();
        this.currentLeaderboardTab = 'global';
        this.leaderboardUpdateInterval = null;
        this.cachedData = null;
    }

    async init() {
        try {
            await this.initializeTelegram();
            await this.loadCachedData();
            await this.setupEventListeners();
            await this.renderCalendar(new Date());
            await this.hydrateFromAPI();
            await this.loadMissions();
            await this.loadLeaderboard();
            await this.checkStreakReminders();
            await this.startAutoRefresh();
        } catch (error) {
            console.error('Initialization error:', error);
            this.handleError(error);
        }
    }

    async initializeTelegram() {
        try {
            if (window.Telegram?.WebApp) {
                const webApp = window.Telegram.WebApp;
                webApp.ready();
                webApp.expand();
                
                // Check version before using advanced features
                const version = parseFloat(webApp.version || '6.0');
                
                // enableClosingConfirmation requires version 6.2+
                if (version >= 6.2 && typeof webApp.enableClosingConfirmation === 'function') {
                    try {
                        webApp.enableClosingConfirmation();
                    } catch (e) {
                        console.log('Closing confirmation not supported:', e.message);
                    }
                }
                
                document.body.classList.add('telegram-fullscreen');
                
                // Set theme colors
                if (webApp.colorScheme === 'dark') {
                    document.documentElement.setAttribute('data-theme', 'dark');
                }
                
                // Handle back button (requires version 6.1+)
                if (version >= 6.1 && webApp.BackButton) {
                    try {
                        webApp.BackButton.onClick(() => {
                            window.history.back();
                        });
                    } catch (e) {
                        console.log('BackButton not supported:', e.message);
                    }
                }
                
                console.log('Telegram WebApp initialized, version:', version);
            }
        } catch (error) {
            console.warn('Telegram initialization error:', error);
            // Continue without Telegram features
        }
    }

    async loadCachedData() {
        const cached = this.storage.get('dailyState');
        if (cached && this.isCacheValid(cached.timestamp)) {
            this.cachedData = cached.data;
            this.renderWithCache(cached.data);
        }
    }

    isCacheValid(timestamp, maxAge = 300000) { // 5 minutes
        return timestamp && (Date.now() - timestamp < maxAge);
    }

    async setupEventListeners() {
        // Check-in button
        const checkInBtn = document.getElementById('checkInBtn');
        checkInBtn?.addEventListener('click', () => this.handleCheckIn());

        // Leaderboard refresh
        const refreshBtn = document.getElementById('refreshLeaderboard');
        refreshBtn?.addEventListener('click', () => this.refreshLeaderboard());

        // Tab switching
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchTab(e.target));
        });

        // Weight controls
        document.getElementById('wRef')?.addEventListener('change', () => this.loadLeaderboard());
        document.getElementById('wAct')?.addEventListener('change', () => this.loadLeaderboard());

        // Calendar navigation
        document.getElementById('prevMonth')?.addEventListener('click', () => this.navigateMonth(-1));
        document.getElementById('nextMonth')?.addEventListener('click', () => this.navigateMonth(1));

        // Reward redemption
        document.getElementById('redeemBtn')?.addEventListener('click', () => this.openRedemptionModal());

        // Share achievement
        document.addEventListener('achievement-unlocked', (e) => this.handleAchievementUnlock(e.detail));

        // Offline/online detection
        window.addEventListener('online', () => this.handleOnline());
        window.addEventListener('offline', () => this.handleOffline());

        // Visibility change (tab switching)
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                this.refreshOnFocus();
            }
        });
    }

    async hydrateFromAPI() {
        try {
            const data = await window.API.getDailyState();
            if (!data?.success) {
                throw new Error(data?.error || 'Failed to load daily state');
            }

            // Cache the response
            this.storage.set('dailyState', data, Date.now());
            this.cachedData = data;

            // Update UI
            this.updateStreakDisplay(data);
            this.updateStatsDisplay(data);
            this.updateCalendar(data.checkedInDays || []);
            this.updateWeeklyProgress(data);
            this.checkAndUnlockAchievements(data);
            
            return data;
        } catch (error) {
            console.error('Hydration error:', error);
            
            // Check if it's an auth error
            if (error.message.includes('Unauthorized') || error.message.includes('401')) {
                console.warn('Authentication required. Using demo mode.');
                this.showAuthError();
                // Return demo data
                return this.getDemoData();
            }
            
            // Fallback to cached data
            if (this.cachedData) {
                this.showOfflineNotice();
                this.updateUIWithData(this.cachedData);
                return this.cachedData;
            }
            
            // Last resort: show demo data
            console.warn('No cached data available, using demo mode');
            return this.getDemoData();
        }
    }

    updateUIWithData(data) {
        try {
            this.updateStreakDisplay(data);
            this.updateStatsDisplay(data);
            this.updateCalendar(data.checkedInDays || []);
            this.updateWeeklyProgress(data);
        } catch (error) {
            console.error('UI update error:', error);
        }
    }

    getDemoData() {
        const today = new Date().getDate();
        return {
            success: true,
            streak: 3,
            totalPoints: 50,
            lastCheckIn: new Date(),
            checkedInDays: [today - 2, today - 1, today],
            missionsCompleted: ['m1'],
            month: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
        };
    }

    showAuthError() {
        const notice = document.createElement('div');
        notice.className = 'auth-notice';
        notice.innerHTML = `
            <div style="background: #fff3cd; color: #856404; padding: 12px 16px; text-align: center; font-size: 13px; font-weight: 500; border-bottom: 1px solid #ffeaa7;">
                🔐 Demo Mode - Please open in Telegram to access your account
            </div>
        `;
        document.querySelector('.app-container')?.prepend(notice);
    }

    updateStreakDisplay(data) {
        const streak = data.streak || 0;
        const streakEl = document.getElementById('streakCount');
        const emojiEl = document.getElementById('streakEmoji');
        const badgeEl = document.getElementById('achievementBadge');

        // Animated counter
        this.animateCounter(streakEl, 0, streak, 1000);

        // Dynamic emoji based on streak
        const emoji = this.getStreakEmoji(streak);
        emojiEl.textContent = emoji;
        emojiEl.classList.add('animate-bounce');

        // Achievement badges
        const badge = this.achievements.getBadgeForStreak(streak);
        if (badge) {
            badgeEl.innerHTML = `<div class="achievement-badge animate-in">${badge.icon} ${badge.title}</div>`;
        }

        // Streak status indicator
        this.updateStreakStatus(data);
    }

    getStreakEmoji(streak) {
        if (streak >= 100) return '👑';
        if (streak >= 50) return '💎';
        if (streak >= 30) return '🏆';
        if (streak >= 14) return '⭐';
        if (streak >= 7) return '🔥';
        if (streak >= 3) return '💪';
        return '🌱';
    }

    updateStatsDisplay(data) {
        document.getElementById('totalPoints').textContent = (data.totalPoints || 0).toLocaleString();
        
        // Calculate daily and weekly points
        const dailyPoints = 10;
        const weeklyBonus = Math.floor((data.streak || 0) / 7) * 50;
        
        document.getElementById('dailyPoints').textContent = dailyPoints;
        document.getElementById('weeklyBonus').textContent = weeklyBonus;

        // Update missions summary
        const completed = (data.missionsCompleted || []).length;
        const total = 4;
        document.getElementById('missionsSummary').textContent = `${completed}/${total} completed`;
    }

    updateCalendar(checkedInDays) {
        const days = new Set(checkedInDays);
        document.querySelectorAll('[data-day]').forEach(el => {
            const day = parseInt(el.getAttribute('data-day'), 10);
            if (days.has(day)) {
                el.classList.add('checked');
                el.innerHTML = `<span>✓</span>`;
            }
        });
    }

    updateWeeklyProgress(data) {
        const checkedDays = data.checkedInDays || [];
        const thisWeekDays = this.getThisWeekDays(checkedDays);
        const weekCount = thisWeekDays.length;
        const percentage = Math.min(100, Math.round((weekCount / 7) * 100));

        // Animate progress bar
        const progressBar = document.getElementById('weekBar');
        this.animateProgress(progressBar, 0, percentage, 800);

        document.getElementById('weekProgress').textContent = `${percentage}%`;
        document.getElementById('daysThisWeek').textContent = weekCount;
        document.getElementById('weeklyEarned').textContent = weekCount * 5;
    }

    getThisWeekDays(checkedInDays) {
        const now = new Date();
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);

        return checkedInDays.filter(day => {
            const checkDate = new Date(now.getFullYear(), now.getMonth(), day);
            return checkDate >= startOfWeek && checkDate <= now;
        });
    }

    async handleCheckIn() {
        const btn = document.getElementById('checkInBtn');
        const originalText = btn.innerHTML;
        
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner"></div> Checking in...';

        try {
            const resp = await window.API.dailyCheckIn();
            
            if (!resp?.success) {
                throw new Error(resp?.error || 'Check-in failed');
            }

            if (resp.alreadyChecked) {
                this.showToast('Already checked in today! ✓', 'info');
            } else {
                // Success animation
                await this.animationEngine.celebrateCheckIn();
                this.showToast(`Check-in successful! +${resp.pointsEarned || 10} points 🎉`, 'success');
                
                // Check for streak milestones
                if (resp.streakMilestone) {
                    await this.celebrations.showMilestone(resp.streakMilestone);
                }

                // Trigger confetti for special achievements
                if (resp.newAchievement) {
                    this.animationEngine.confetti();
                }
            }

            // Refresh data
            await this.hydrateFromAPI();
            
        } catch (error) {
            console.error('Check-in error:', error);
            this.showToast('Failed to check-in. Please try again.', 'error');
            
            // Optimistic update for offline mode
            if (!navigator.onLine) {
                this.storage.queueAction('checkin', { date: new Date() });
                this.showToast('Check-in queued. Will sync when online.', 'info');
            }
        } finally {
            setTimeout(() => {
                btn.disabled = false;
                btn.innerHTML = originalText;
            }, 1000);
        }
    }

    async loadMissions() {
        const list = document.getElementById('missionsList');
        if (!list) return;
        
        list.innerHTML = '<div class="loading-skeleton"></div>';

        try {
            const [missionsResp, stateResp] = await Promise.all([
                window.API.getMissions().catch(e => {
                    console.warn('Failed to load missions:', e);
                    return this.getDemoMissions();
                }),
                window.API.getDailyState().catch(e => {
                    console.warn('Failed to load state:', e);
                    return this.getDemoData();
                })
            ]);

            const missions = missionsResp?.missions || [];
            const completed = new Set(stateResp?.missionsCompleted || []);

            list.innerHTML = '';
            
            if (missions.length === 0) {
                list.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">No missions available</div>';
                return;
            }

            missions.forEach((mission, index) => {
                const isCompleted = completed.has(mission.id);
                const row = this.createMissionElement(mission, isCompleted, index);
                list.appendChild(row);
            });

            // Attach event listeners
            list.addEventListener('click', (e) => this.handleMissionClick(e));

        } catch (error) {
            console.error('Load missions error:', error);
            list.innerHTML = '<div class="error-message">Failed to load missions. Please try again.</div>';
        }
    }

    getDemoMissions() {
        return {
            success: true,
            missions: [
                { id: 'm1', title: 'Connect a wallet', points: 20 },
                { id: 'm2', title: 'Join Telegram channel', points: 10 },
                { id: 'm3', title: 'Complete your first order', points: 50 },
                { id: 'm4', title: 'Invite a friend', points: 30 }
            ]
        };
    }

    createMissionElement(mission, isCompleted, index) {
        const row = document.createElement('div');
        row.className = 'mission-item animate-in';
        row.style.animationDelay = `${index * 50}ms`;
        
        const icon = this.getMissionIcon(mission.id);
        const validationStatus = this.getMissionValidationStatus(mission.id);

        row.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
                <div class="mission-icon">${icon}</div>
                <div style="flex: 1;">
                    <div class="mission-title">${mission.title}</div>
                    <div class="mission-subtitle">+${mission.points} pts${validationStatus ? ` • ${validationStatus}` : ''}</div>
                </div>
            </div>
            <button data-id="${mission.id}" class="mission-btn ${isCompleted ? 'completed' : 'complete'}">
                ${isCompleted ? '✓ Done' : 'Complete'}
            </button>
        `;

        return row;
    }

    getMissionIcon(missionId) {
        const icons = {
            'm1': '💳',
            'm2': '💬',
            'm3': '🛍️',
            'm4': '👥'
        };
        return icons[missionId] || '⭐';
    }

    getMissionValidationStatus(missionId) {
        // Smart validation - check if user actually completed the requirement
        const validations = this.storage.get('missionValidations') || {};
        return validations[missionId]?.status;
    }

    async handleMissionClick(e) {
        const btn = e.target.closest('.mission-btn');
        if (!btn || btn.classList.contains('completed')) return;

        const missionId = btn.getAttribute('data-id');
        const originalText = btn.textContent;

        btn.disabled = true;
        btn.textContent = 'Verifying...';

        try {
            // Validate mission completion
            const isValid = await this.validateMissionCompletion(missionId);
            
            if (!isValid) {
                this.showToast('Please complete the mission requirements first', 'warning');
                btn.disabled = false;
                btn.textContent = originalText;
                return;
            }

            // Complete mission
            const resp = await window.API.completeMission(missionId);
            
            if (resp?.success) {
                this.animationEngine.missionComplete(btn);
                this.showToast(`Mission completed! +${resp.pointsEarned || 0} points`, 'success');
                
                // Reload missions and stats
                await Promise.all([
                    this.loadMissions(),
                    this.hydrateFromAPI()
                ]);
            }

        } catch (error) {
            console.error('Mission completion error:', error);
            this.showToast('Failed to complete mission', 'error');
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }

    async validateMissionCompletion(missionId) {
        // Smart validation logic
        switch (missionId) {
            case 'm1': // Connect wallet
                return this.checkWalletConnected();
            case 'm2': // Join Telegram channel
                return this.checkTelegramChannelMembership();
            case 'm3': // Complete first order
                return this.checkFirstOrderCompleted();
            case 'm4': // Invite friend
                return this.checkReferralMade();
            default:
                return true;
        }
    }

    async checkWalletConnected() {
        try {
            const resp = await window.API.getWalletAddress();
            return resp?.success && resp?.walletAddress;
        } catch {
            return false;
        }
    }

    async checkTelegramChannelMembership() {
        // This would require Telegram Bot API to check membership
        // For now, we'll use localStorage as a simple check
        return this.storage.get('telegramChannelJoined') === true;
    }

    async checkFirstOrderCompleted() {
        try {
            const orders = this.storage.get('completedOrders') || [];
            return orders.length > 0;
        } catch {
            return false;
        }
    }

    async checkReferralMade() {
        try {
            const referrals = this.storage.get('referralCount') || 0;
            return referrals > 0;
        } catch {
            return false;
        }
    }

    async loadLeaderboard() {
        const el = document.getElementById('leaderboardList');
        if (!el) return;
        
        el.innerHTML = '<div class="loading-skeleton-lb"></div>';

        try {
            const wRef = parseFloat(document.getElementById('wRef')?.value || 0.7);
            const wAct = parseFloat(document.getElementById('wAct')?.value || 0.3);
            
            const data = await window.API.getLeaderboard(
                this.currentLeaderboardTab,
                isNaN(wRef) ? undefined : wRef,
                isNaN(wAct) ? undefined : wAct
            ).catch(e => {
                console.warn('Leaderboard API failed:', e);
                // Return demo leaderboard
                return this.getDemoLeaderboard();
            });

            if (!data?.success) throw new Error('Failed to load leaderboard');

            // Update user rank
            const rankEl = document.getElementById('userRank');
            if (rankEl) {
                rankEl.textContent = data.userRank ? `#${data.userRank}` : '#--';
            }

            // Render entries
            el.innerHTML = '';
            
            if (!data.entries || data.entries.length === 0) {
                el.innerHTML = '<div style="text-align: center; color: #999; padding: 40px;">No leaderboard data yet</div>';
                return;
            }

            data.entries.forEach((entry, index) => {
                const row = this.createLeaderboardEntry(entry, index);
                el.appendChild(row);
            });

            // Cache leaderboard data
            this.storage.set('leaderboard', { data, tab: this.currentLeaderboardTab }, Date.now());

        } catch (error) {
            console.error('Leaderboard error:', error);
            
            // Try to load from cache
            const cached = this.storage.get('leaderboard');
            if (cached && cached.tab === this.currentLeaderboardTab) {
                this.renderLeaderboardFromCache(cached.data);
            } else {
                el.innerHTML = '<div class="error-message">Leaderboard temporarily unavailable</div>';
            }
        }
    }

    getDemoLeaderboard() {
        return {
            success: true,
            userRank: null,
            entries: [
                { userId: 'demo1', username: 'StarUser', score: 1000, activityPoints: 500 },
                { userId: 'demo2', username: 'TopPlayer', score: 850, activityPoints: 400 },
                { userId: 'demo3', username: 'Champion', score: 720, activityPoints: 350 }
            ]
        };
    }

    createLeaderboardEntry(entry, index) {
        const row = document.createElement('div');
        const rank = index + 1;
        const isTop3 = rank <= 3;
        const isCurrentUser = entry.isCurrentUser;

        row.className = `leaderboard-item animate-in ${isTop3 ? 'top-3' : ''} ${isCurrentUser ? 'current-user' : ''}`;
        row.style.animationDelay = `${index * 30}ms`;

        const rankBadge = this.getRankBadge(rank);
        const avatar = this.createAvatar(entry.username || entry.userId);
        const streakText = this.getStreakText(entry.activityPoints || 0);

        row.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px;">
                <div class="rank-badge ${rankBadge.class}">${rankBadge.content}</div>
                ${avatar}
                <div>
                    <div class="lb-username">@${entry.username || 'user_' + (entry.userId || '').slice(-5)}</div>
                    <div class="lb-streak">${streakText}</div>
                </div>
            </div>
            <div>
                <div class="lb-score">${(entry.score || entry.points || 0).toLocaleString()}</div>
                <div class="lb-score-label">score</div>
            </div>
        `;

        return row;
    }

    getRankBadge(rank) {
        if (rank === 1) return { class: 'gold', content: '🥇' };
        if (rank === 2) return { class: 'silver', content: '🥈' };
        if (rank === 3) return { class: 'bronze', content: '🥉' };
        return { class: '', content: rank };
    }

    createAvatar(name) {
        const initial = (name || 'U')[0].toUpperCase();
        const color = this.getAvatarColor(initial);
        return `<div class="avatar" style="background: ${color}">${initial}</div>`;
    }

    getAvatarColor(letter) {
        const colors = [
            'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
            'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
            'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
            'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
            'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
            'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
            'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
        ];
        return colors[letter.charCodeAt(0) % colors.length];
    }

    getStreakText(points) {
        const days = Math.floor(points / 10);
        if (days >= 30) return '🏆 30+ day streak';
        if (days >= 14) return '⭐ 14+ day streak';
        if (days >= 7) return '🔥 7+ day streak';
        return `${days} day streak`;
    }

    async refreshLeaderboard() {
        const btn = document.getElementById('refreshLeaderboard');
        const originalText = btn.textContent;
        
        btn.textContent = '↻ Refreshing...';
        await this.loadLeaderboard();
        
        btn.textContent = '✓ Refreshed';
        setTimeout(() => {
            btn.textContent = originalText;
        }, 1500);
    }

    switchTab(btn) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        this.currentLeaderboardTab = btn.getAttribute('data-tab');
        
        // Show/hide weight controls
        const weightControls = document.getElementById('weightControls');
        if (weightControls) {
            weightControls.style.display = this.currentLeaderboardTab === 'global' ? 'flex' : 'none';
        }
        
        this.loadLeaderboard();
    }

    async renderCalendar(date) {
        const grid = document.getElementById('calendarGrid');
        if (!grid) return;

        grid.innerHTML = '';
        
        const year = date.getFullYear();
        const month = date.getMonth();
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const today = new Date();
        
        // Update month display
        const monthName = date.toLocaleString('default', { month: 'long', year: 'numeric' });
        document.getElementById('calendarMonth').textContent = monthName;

        const startWeekday = firstDay.getDay();
        const totalDays = lastDay.getDate();

        // Empty cells for days before month starts
        for (let i = 0; i < startWeekday; i++) {
            const empty = document.createElement('div');
            empty.className = 'calendar-empty';
            grid.appendChild(empty);
        }

        // Days of the month
        for (let day = 1; day <= totalDays; day++) {
            const cell = document.createElement('button');
            cell.className = 'calendar-day';
            cell.setAttribute('data-day', day);
            cell.textContent = day;

            // Mark today
            if (year === today.getFullYear() && 
                month === today.getMonth() && 
                day === today.getDate()) {
                cell.classList.add('today');
            }

            // Add tooltip
            cell.title = `Day ${day}`;

            grid.appendChild(cell);
        }
    }

    navigateMonth(direction) {
        const currentMonth = document.getElementById('calendarMonth')?.textContent;
        if (!currentMonth) return;

        // Parse current month and navigate
        const date = new Date(currentMonth);
        date.setMonth(date.getMonth() + direction);
        
        this.renderCalendar(date);
        // Reload check-in data for this month
        this.hydrateFromAPI();
    }

    async checkStreakReminders() {
        const lastCheckIn = this.storage.get('lastCheckIn');
        if (!lastCheckIn) return;

        const hoursSinceCheckIn = (Date.now() - lastCheckIn) / (1000 * 60 * 60);
        
        // Remind if more than 20 hours since last check-in
        if (hoursSinceCheckIn > 20 && hoursSinceCheckIn < 24) {
            this.notificationManager.sendReminder('Don\'t break your streak! Check in before midnight 🔥');
        }
    }

    async startAutoRefresh() {
        // Auto-refresh leaderboard every 2 minutes
        this.leaderboardUpdateInterval = setInterval(() => {
            if (!document.hidden) {
                this.loadLeaderboard();
            }
        }, 120000);
    }

    checkAndUnlockAchievements(data) {
        const streak = data.streak || 0;
        const points = data.totalPoints || 0;
        
        // Check various achievement criteria
        this.achievements.check('first_checkin', streak >= 1);
        this.achievements.check('week_warrior', streak >= 7);
        this.achievements.check('two_weeks', streak >= 14);
        this.achievements.check('month_master', streak >= 30);
        this.achievements.check('points_100', points >= 100);
        this.achievements.check('points_500', points >= 500);
        this.achievements.check('points_1000', points >= 1000);
    }

    updateStreakStatus(data) {
        const lastCheckIn = data.lastCheckIn ? new Date(data.lastCheckIn) : null;
        const now = new Date();
        
        if (lastCheckIn) {
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const checkInDate = new Date(lastCheckIn.getFullYear(), lastCheckIn.getMonth(), lastCheckIn.getDate());
            const daysDiff = Math.floor((today - checkInDate) / (1000 * 60 * 60 * 24));

            if (daysDiff === 0) {
                // Already checked in today
                const btn = document.getElementById('checkInBtn');
                if (btn) {
                    btn.disabled = true;
                    btn.innerHTML = '✓ Checked in today';
                    btn.classList.add('btn-success');
                }
            }
        }
    }

    // Utility methods
    animateCounter(element, start, end, duration) {
        if (!element) return;
        
        const range = end - start;
        const increment = range / (duration / 16);
        let current = start;

        const timer = setInterval(() => {
            current += increment;
            if (current >= end) {
                element.textContent = Math.round(end);
                clearInterval(timer);
            } else {
                element.textContent = Math.round(current);
            }
        }, 16);
    }

    animateProgress(element, start, end, duration) {
        if (!element) return;
        
        const range = end - start;
        const increment = range / (duration / 16);
        let current = start;

        const timer = setInterval(() => {
            current += increment;
            if (current >= end) {
                element.style.width = `${end}%`;
                clearInterval(timer);
            } else {
                element.style.width = `${current}%`;
            }
        }, 16);
    }

    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type} animate-in`;
        toast.textContent = message;
        
        const colors = {
            success: '#4caf50',
            error: '#f44336',
            warning: '#ff9800',
            info: '#2196f3'
        };
        
        toast.style.cssText = `
            position: fixed;
            bottom: 24px;
            left: 50%;
            transform: translateX(-50%);
            background: ${colors[type] || colors.info};
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            max-width: 90%;
        `;
        
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(-50%) translateY(20px)';
            toast.style.transition = 'all 0.3s ease';
        }, 3000);
        
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 3500);
    }

    handleError(error) {
        console.error('Daily system error:', error);
        this.showToast('Something went wrong. Please try again.', 'error');
    }

    handleOnline() {
        this.showToast('Back online! Syncing data...', 'success');
        this.hydrateFromAPI();
        this.syncQueuedActions();
    }

    handleOffline() {
        this.showToast('You\'re offline. Some features may be limited.', 'warning');
    }

    showOfflineNotice() {
        const notice = document.createElement('div');
        notice.className = 'offline-notice';
        notice.innerHTML = '📶 Offline mode - Showing cached data';
        document.querySelector('.app-container')?.prepend(notice);
    }

    async syncQueuedActions() {
        const queued = this.storage.get('queuedActions') || [];
        for (const action of queued) {
            try {
                if (action.type === 'checkin') {
                    await window.API.dailyCheckIn();
                }
                // Remove from queue
                this.storage.removeFromQueue(action);
            } catch (error) {
                console.error('Sync error:', action, error);
            }
        }
    }

    refreshOnFocus() {
        // Refresh data when user comes back to the tab
        const lastRefresh = this.storage.get('lastRefresh') || 0;
        if (Date.now() - lastRefresh > 60000) { // 1 minute
            this.hydrateFromAPI();
            this.storage.set('lastRefresh', Date.now());
        }
    }

    cleanup() {
        if (this.leaderboardUpdateInterval) {
            clearInterval(this.leaderboardUpdateInterval);
        }
    }
}

// Supporting classes

class PersistentStorage {
    constructor() {
        this.prefix = 'starstore_daily_';
    }

    set(key, value, timestamp = null) {
        try {
            const data = { value, timestamp: timestamp || Date.now() };
            localStorage.setItem(this.prefix + key, JSON.stringify(data));
        } catch (error) {
            console.warn('Storage set error:', error);
        }
    }

    get(key) {
        try {
            const item = localStorage.getItem(this.prefix + key);
            if (!item) return null;
            const data = JSON.parse(item);
            return data.timestamp ? data : data.value;
        } catch (error) {
            console.warn('Storage get error:', error);
            return null;
        }
    }

    remove(key) {
        try {
            localStorage.removeItem(this.prefix + key);
        } catch (error) {
            console.warn('Storage remove error:', error);
        }
    }

    queueAction(type, data) {
        const queued = this.get('queuedActions') || [];
        queued.push({ type, data, timestamp: Date.now() });
        this.set('queuedActions', queued);
    }

    removeFromQueue(action) {
        let queued = this.get('queuedActions') || [];
        queued = queued.filter(a => a.timestamp !== action.timestamp);
        this.set('queuedActions', queued);
    }
}

class AchievementManager {
    constructor() {
        this.achievements = {
            first_checkin: { id: 'first_checkin', title: 'First Steps', icon: '🌱', unlocked: false },
            week_warrior: { id: 'week_warrior', title: 'Week Warrior', icon: '🔥', unlocked: false },
            two_weeks: { id: 'two_weeks', title: '2-Week Streak', icon: '⭐', unlocked: false },
            month_master: { id: 'month_master', title: 'Month Master', icon: '🏆', unlocked: false },
            points_100: { id: 'points_100', title: '100 Points', icon: '💯', unlocked: false },
            points_500: { id: 'points_500', title: '500 Points', icon: '🎯', unlocked: false },
            points_1000: { id: 'points_1000', title: '1000 Points', icon: '💎', unlocked: false }
        };
        
        this.loadProgress();
    }

    loadProgress() {
        try {
            const saved = localStorage.getItem('starstore_achievements');
            if (saved) {
                const progress = JSON.parse(saved);
                Object.keys(progress).forEach(key => {
                    if (this.achievements[key]) {
                        this.achievements[key].unlocked = progress[key];
                    }
                });
            }
        } catch (error) {
            console.warn('Achievement load error:', error);
        }
    }

    saveProgress() {
        try {
            const progress = {};
            Object.keys(this.achievements).forEach(key => {
                progress[key] = this.achievements[key].unlocked;
            });
            localStorage.setItem('starstore_achievements', JSON.stringify(progress));
        } catch (error) {
            console.warn('Achievement save error:', error);
        }
    }

    check(achievementId, condition) {
        const achievement = this.achievements[achievementId];
        if (!achievement || achievement.unlocked) return;

        if (condition) {
            achievement.unlocked = true;
            this.saveProgress();
            this.triggerUnlock(achievement);
        }
    }

    triggerUnlock(achievement) {
        const event = new CustomEvent('achievement-unlocked', { detail: achievement });
        document.dispatchEvent(event);
    }

    getBadgeForStreak(streak) {
        if (streak >= 30) return this.achievements.month_master;
        if (streak >= 14) return this.achievements.two_weeks;
        if (streak >= 7) return this.achievements.week_warrior;
        if (streak >= 1) return this.achievements.first_checkin;
        return null;
    }
}

class StreakManager {
    constructor() {
        this.gracePeriod = 6; // hours
    }

    calculateStreak(checkInDates) {
        if (!checkInDates || checkInDates.length === 0) return 0;

        const sorted = [...checkInDates].sort((a, b) => new Date(b) - new Date(a));
        let streak = 1;
        let lastDate = new Date(sorted[0]);

        for (let i = 1; i < sorted.length; i++) {
            const current = new Date(sorted[i]);
            const diffDays = Math.floor((lastDate - current) / (1000 * 60 * 60 * 24));

            if (diffDays === 1) {
                streak++;
                lastDate = current;
            } else if (diffDays > 1) {
                break;
            }
        }

        return streak;
    }

    isInGracePeriod(lastCheckIn) {
        if (!lastCheckIn) return false;
        
        const now = new Date();
        const last = new Date(lastCheckIn);
        const hoursDiff = (now - last) / (1000 * 60 * 60);
        
        return hoursDiff < (24 + this.gracePeriod);
    }
}

class NotificationManager {
    sendReminder(message) {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('StarStore Daily Reminder', {
                body: message,
                icon: '/favicon.png',
                badge: '/favicon.png'
            });
        }
    }

    async requestPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            await Notification.requestPermission();
        }
    }
}

class AnimationEngine {
    async celebrateCheckIn() {
        // Add celebration animation
        const btn = document.getElementById('checkInBtn');
        if (btn) {
            btn.classList.add('celebrate');
            setTimeout(() => btn.classList.remove('celebrate'), 1000);
        }
    }

    missionComplete(element) {
        element.classList.add('mission-complete-anim');
        setTimeout(() => element.classList.remove('mission-complete-anim'), 600);
    }

    confetti() {
        // Simple confetti effect
        const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
        const container = document.body;

        for (let i = 0; i < 50; i++) {
            setTimeout(() => {
                const confetti = document.createElement('div');
                confetti.className = 'confetti-piece';
                confetti.style.cssText = `
                    position: fixed;
                    width: 10px;
                    height: 10px;
                    background: ${colors[Math.floor(Math.random() * colors.length)]};
                    top: -10px;
                    left: ${Math.random() * 100}%;
                    animation: confetti-fall ${2 + Math.random() * 2}s ease-in forwards;
                    z-index: 10000;
                `;
                container.appendChild(confetti);
                
                setTimeout(() => confetti.remove(), 4000);
            }, i * 30);
        }
    }
}

class RewardRedemption {
    constructor() {
        this.rewards = [
            { id: 'r1', name: 'Extra Check-in Points', cost: 100, type: 'boost' },
            { id: 'r2', name: 'Streak Freeze (1 day)', cost: 500, type: 'protection' },
            { id: 'r3', name: 'Double Points (24h)', cost: 1000, type: 'boost' },
            { id: 'r4', name: 'Profile Badge', cost: 2000, type: 'cosmetic' }
        ];
    }

    getAvailableRewards(points) {
        return this.rewards.filter(r => r.cost <= points);
    }

    async redeem(rewardId, userPoints) {
        const reward = this.rewards.find(r => r.id === rewardId);
        if (!reward) throw new Error('Invalid reward');
        
        if (userPoints < reward.cost) {
            throw new Error('Insufficient points');
        }

        // Here you would call an API to redeem the reward
        return { success: true, reward };
    }
}

// Initialize when DOM is ready
let dailySystem;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Initialize translations
        if (typeof TranslationUtils !== 'undefined') {
            TranslationUtils.init();
        }

        // Check if API is available
        if (typeof window.API === 'undefined') {
            console.error('API not loaded. Make sure api.js is included before daily-enhanced.js');
            return;
        }

        // Initialize daily system
        dailySystem = new DailyRewardsSystem();
        window.dailySystem = dailySystem; // Make globally accessible
        
        await dailySystem.init();
        
        console.log('✅ Enhanced daily system initialized successfully');

        // Cleanup on page unload
        window.addEventListener('beforeunload', () => {
            dailySystem?.cleanup();
        });
    } catch (error) {
        console.error('❌ Enhanced system initialization failed:', error);
        console.log('Falling back to basic system');
        // Don't block - let the page still work with basic functionality
    }
});

// Export for external use
window.DailyRewardsSystem = DailyRewardsSystem;
