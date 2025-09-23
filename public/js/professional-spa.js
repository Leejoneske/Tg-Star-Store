/**
 * Professional SPA Router - WhatsApp-level navigation
 * Advanced features: preloading, service worker, virtual scrolling, route guards, analytics
 */
class ProfessionalSPA {
    constructor() {
        this.pageCache = new Map();
        this.preloadCache = new Map();
        this.currentPage = null;
        this.isNavigating = false;
        this.navigationHistory = [];
        this.maxHistorySize = 50;
        this.preloadQueue = [];
        this.isPreloading = false;
        this.scriptCache = new Map();
        this.loadedScriptSrcs = new Set();
        this.executedInlineForPath = new Set();
        this.performanceMetrics = {
            navigationTimes: [],
            cacheHitRate: 0,
            errorRate: 0
        };
        this.routeGuards = new Map();
        this.offlineMode = false;
        this.serviceWorker = null;
        
        this.init();
    }

    async init() {
        // Initialize service worker
        await this.initServiceWorker();
        
        // Intercept all navigation clicks
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a[href]');
            if (!link) return;
            
            const href = link.getAttribute('href');
            
            // Skip external links, mailto, tel, etc.
            if (this.isExternalLink(href) || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) {
                return;
            }
            
            e.preventDefault();
            this.navigate(href);
        });
        
        // Handle browser back/forward
        window.addEventListener('popstate', (e) => {
            this.handlePopState(e);
        });
        
        // Handle online/offline events
        window.addEventListener('online', () => {
            this.offlineMode = false;
            this.showNotification('Connection restored', 'success');
        });
        
        window.addEventListener('offline', () => {
            this.offlineMode = true;
            this.showNotification('You are offline', 'warning');
        });
        
        // Preload critical pages
        this.preloadCriticalPages();
        
        // Load initial page
        this.loadInitialPage();
        
        // Start performance monitoring
        this.startPerformanceMonitoring();
    }

    async initServiceWorker() {
        if ('serviceWorker' in navigator) {
            try {
                const registration = await navigator.serviceWorker.register('/sw.js');
                this.serviceWorker = registration;
                console.log('Service Worker registered:', registration);
            } catch (error) {
                console.warn('Service Worker registration failed:', error);
            }
        }
    }

    async preloadCriticalPages() {
        const criticalPages = ['/sell', '/history', '/about'];
        
        for (const page of criticalPages) {
            this.preloadPage(page);
        }
    }

    async preloadPage(path) {
        if (this.preloadCache.has(path) || this.pageCache.has(path)) {
            return;
        }
        
        try {
            const startTime = performance.now();
            const content = await this.loadPageContent(path);
            const loadTime = performance.now() - startTime;
            
            this.preloadCache.set(path, {
                content,
                loadTime,
                timestamp: Date.now()
            });
            
            console.log(`Preloaded ${path} in ${loadTime.toFixed(2)}ms`);
        } catch (error) {
            console.warn(`Failed to preload ${path}:`, error);
        }
    }

    isExternalLink(href) {
        try {
            const url = new URL(href, window.location.origin);
            return url.origin !== window.location.origin;
        } catch {
            return false;
        }
    }

    async navigate(href, options = {}) {
        if (this.isNavigating && !options.force) return;
        
        const startTime = performance.now();
        const normalizedPath = this.normalizePath(href);
        
        // Check if it's the same page
        if (this.currentPage === normalizedPath && !options.force) {
            return;
        }
        
        // Check route guards
        if (!await this.checkRouteGuards(normalizedPath)) {
            return;
        }
        
        this.isNavigating = true;
        
        try {
            // Show loading indicator
            this.showLoading();
            
            // Track navigation start
            this.trackNavigationStart(normalizedPath);
            
            // Load page content (from cache or network)
            const content = await this.loadPage(normalizedPath);
            
            // Update page
            await this.updatePage(normalizedPath, content);
            
            // Update URL and history
            this.updateHistory(normalizedPath);
            
            // Update navigation state
            this.updateNavigationState(normalizedPath);
            
            // Track navigation completion
            const navigationTime = performance.now() - startTime;
            this.trackNavigationComplete(normalizedPath, navigationTime);
            
            // Preload related pages
            this.preloadRelatedPages(normalizedPath);
            
            // Track page view
            this.trackPageView(normalizedPath);
            
        } catch (error) {
            console.error('Navigation error:', error);
            this.trackNavigationError(normalizedPath, error);
            
            // Fallback to normal navigation
            if (!this.offlineMode) {
                window.location.href = href;
            } else {
                this.showError('Page not available offline');
            }
        } finally {
            this.hideLoading();
            this.isNavigating = false;
        }
    }

    async checkRouteGuards(path) {
        const guard = this.routeGuards.get(path);
        if (!guard) return true;
        
        try {
            return await guard();
        } catch (error) {
            console.error('Route guard failed:', error);
            return false;
        }
    }

    addRouteGuard(path, guardFunction) {
        this.routeGuards.set(path, guardFunction);
    }

    normalizePath(href) {
        let normalized = href.replace(/\.html$/, '');
        
        if (!normalized.startsWith('/')) {
            normalized = '/' + normalized;
        }
        
        if (normalized === '/index' || normalized === '/index.html') {
            normalized = '/';
        }
        
        // Treat /app as root for SPA shell
        if (normalized === '/app') {
            normalized = '/';
        }
        
        return normalized;
    }

    async loadPage(path) {
        // Check cache first
        if (this.pageCache.has(path)) {
            this.performanceMetrics.cacheHitRate++;
            return this.pageCache.get(path);
        }
        
        // Check preload cache
        if (this.preloadCache.has(path)) {
            const preloaded = this.preloadCache.get(path);
            this.pageCache.set(path, preloaded.content);
            this.preloadCache.delete(path);
            this.performanceMetrics.cacheHitRate++;
            return preloaded.content;
        }
        
        // Load from network
        const content = await this.loadPageContent(path);
        this.pageCache.set(path, content);
        
        return content;
    }

    async loadPageContent(path) {
        const fileMap = {
            '/': 'index.html',
            '/sell': 'sell.html',
            '/history': 'history.html',
            '/referral': 'referral.html',
            '/about': 'about.html',
            '/blog': 'blog/index.html',
            '/knowledge-base': 'knowledge-base/index.html'
        };
        // Support app shell
        if (path === '/app') {
            path = '/';
        }
        
        const file = fileMap[path];
        if (!file) {
            throw new Error(`Page not found: ${path}`);
        }
        
        const response = await fetch(file, {
            cache: 'no-cache',
            headers: {
                'Cache-Control': 'no-cache'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const html = await response.text();
        
        // Extract main content
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        const mainContent = doc.querySelector('main') || doc.body;
        
        // Collect embedded scripts inside main content so we can execute them after injection
        const embeddedScripts = Array.from(mainContent.querySelectorAll('script')).map((script) => ({
            src: script.getAttribute('src'),
            type: (script.getAttribute('type') || '').trim(),
            content: script.textContent || ''
        })).filter((s) => !s.type || s.type === 'text/javascript' || s.type === 'module');
        
        // Compute base path for resolving relative script src values
        const lastSlashIndex = file.lastIndexOf('/');
        const basePath = lastSlashIndex >= 0 ? file.slice(0, lastSlashIndex + 1) : '';
        
        // Normalize relative script srcs
        const normalizedScripts = embeddedScripts.map((s) => {
            if (s.src && !s.src.startsWith('http') && !s.src.startsWith('//') && !s.src.startsWith('/')) {
                return { ...s, src: `/${basePath}${s.src}`.replace(/\\+/g, '/') };
            }
            return s;
        });
        
        this.scriptCache.set(path, normalizedScripts);
        
        return mainContent.innerHTML;
    }

    async updatePage(path, content) {
        // Update title
        const titleMap = {
            '/': 'StarStore | Buy & Sell Telegram Stars',
            '/sell': 'Sell Telegram Stars | StarStore',
            '/history': 'Transaction History | StarStore',
            '/referral': 'Referral Program | StarStore',
            '/about': 'About StarStore | Telegram Stars Platform',
            '/blog': 'StarStore Insights | Blog',
            '/knowledge-base': 'Knowledge Base | StarStore'
        };
        
        document.title = titleMap[path] || 'StarStore';
        
        // Update main content with smooth transition
        const mainElement = document.querySelector('main');
        if (mainElement) {
            // Add transition class
            mainElement.style.opacity = '0';
            mainElement.style.transform = 'translateY(20px)';
            mainElement.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
            
            // Wait for transition
            await new Promise(resolve => setTimeout(resolve, 150));
            
            // Update content
            mainElement.innerHTML = content;
            
            // Execute embedded scripts captured from the fetched page
            await this.executeEmbeddedScripts(path);
            
            // Re-initialize page-specific scripts (should be idempotent)
            await this.initializePageScripts(path);
            
            // Ensure bottom navigation is present and up to date
            await this.ensureBottomNav(path);
            
            // Fade in
            mainElement.style.opacity = '1';
            mainElement.style.transform = 'translateY(0)';
        }
        
        // Update current page
        this.currentPage = path;
    }

    async executeEmbeddedScripts(path) {
        const scripts = this.scriptCache.get(path) || [];
        if (!scripts.length) return;

        // Avoid re-executing inline scripts for the same path
        const isFirstInlineExecForPath = !this.executedInlineForPath.has(path);
        
        for (const s of scripts) {
            try {
                if (s.src) {
                    if (this.loadedScriptSrcs.has(s.src)) continue;
                    await new Promise((resolve, reject) => {
                        const el = document.createElement('script');
                        if (s.type === 'module') el.type = 'module';
                        el.src = s.src;
                        el.async = true;
                        el.onload = () => { this.loadedScriptSrcs.add(s.src); resolve(); };
                        el.onerror = () => reject(new Error(`Failed to load script: ${s.src}`));
                        document.body.appendChild(el);
                    });
                } else if (s.content && (!s.type || s.type === 'text/javascript')) {
                    // Run inline scripts only once per path to avoid global redeclaration errors
                    if (!isFirstInlineExecForPath) continue;

                    // Skip known global duplicate declarations
                    const knownGlobals = ['tonConnectUI','currentLanguage','walletConnected','currentWalletAddress','lastUserData','currentUser','isTelegramEnv','isInitialized'];
                    let shouldSkip = false;
                    for (const name of knownGlobals) {
                        const declRe = new RegExp(`\\b(let|const|var)\\s+${name}\\b`);
                        if (declRe.test(s.content) && typeof window[name] !== 'undefined') {
                            shouldSkip = true;
                            break;
                        }
                    }
                    if (shouldSkip) continue;

                    const el = document.createElement('script');
                    el.textContent = s.content;
                    document.body.appendChild(el);
                }
            } catch (err) {
                console.warn('Embedded script execution failed:', err);
            }
        }

        // Mark inline scripts for this path as executed
        this.executedInlineForPath.add(path);
    }

    async ensureBottomNav(currentPath) {
        try {
            // Prefer global shell container; fallback to page-local container
            let container = document.getElementById('bottom-nav-container') || document.getElementById('bottomnav-container');
            if (!container) return;
            
            const hasNav = container.querySelector('nav') || container.querySelector('.nav-link');
            if (!hasNav) {
                const resp = await fetch('/bottomnav.html', { cache: 'no-cache' });
                if (resp.ok) {
                    const html = await resp.text();
                    container.innerHTML = html;
                }
            }
            // Update active state
            this.updateNavigationState(currentPath);
        } catch (_) {
            // noop
        }
    }

    async initializePageScripts(path) {
        // Re-initialize page-specific functionality
        switch (path) {
            case '/':
                await this.initializeHomePage();
                break;
            case '/sell':
                await this.initializeSellPage();
                break;
            case '/history':
                await this.initializeHistoryPage();
                break;
            case '/about':
                await this.initializeAboutPage();
                break;
            case '/blog':
                await this.initializeBlogPage();
                break;
            case '/knowledge-base':
                await this.initializeKnowledgeBasePage();
                break;
        }
        
        // Re-initialize common functionality
        await this.initializeCommonScripts();
    }

    async initializeHomePage() {
        // Re-initialize TON Connect if needed
        if (window.tonConnectUI) {
            // TON Connect should auto-initialize
        }
        
        // Re-initialize any home-specific functionality
        if (typeof initializeHomePage === 'function') {
            await initializeHomePage();
        }
    }

    async initializeSellPage() {
        if (typeof initializeSellPage === 'function') {
            await initializeSellPage();
        }
    }

    async initializeHistoryPage() {
        if (typeof initializeHistoryPage === 'function') {
            await initializeHistoryPage();
        }
    }

    async initializeAboutPage() {
        if (typeof initializeAboutPage === 'function') {
            await initializeAboutPage();
        }
    }

    async initializeBlogPage() {
        if (typeof initializeBlogPage === 'function') {
            await initializeBlogPage();
        }
    }

    async initializeKnowledgeBasePage() {
        if (typeof initializeKnowledgeBasePage === 'function') {
            await initializeKnowledgeBasePage();
        }
    }

    async initializeCommonScripts() {
        // Re-initialize translations
        if (typeof initializeTranslations === 'function') {
            await initializeTranslations();
        }
        
        // Re-initialize any other common functionality
        if (typeof initializeCommon === 'function') {
            await initializeCommon();
        }
    }

    updateHistory(path) {
        this.navigationHistory.push({
            path,
            timestamp: Date.now(),
            scrollPosition: window.scrollY
        });
        
        // Limit history size
        if (this.navigationHistory.length > this.maxHistorySize) {
            this.navigationHistory.shift();
        }
        
        // Update browser history
        window.history.pushState({ path }, '', path);
    }

    updateNavigationState(path) {
        // Update bottom navigation active state
        const navLinks = document.querySelectorAll('.nav-link');
        navLinks.forEach(link => {
            link.classList.remove('active');
            
            const linkPath = this.normalizePath(link.getAttribute('href'));
            if (linkPath === path) {
                link.classList.add('active');
            }
        });
    }

    preloadRelatedPages(currentPath) {
        const relatedPages = {
            '/': ['/sell', '/history'],
            '/sell': ['/', '/history'],
            '/history': ['/', '/sell'],
            '/about': ['/', '/blog'],
            '/blog': ['/about', '/knowledge-base'],
            '/knowledge-base': ['/blog', '/about']
        };
        
        const toPreload = relatedPages[currentPath] || [];
        
        toPreload.forEach(page => {
            if (!this.pageCache.has(page) && !this.preloadCache.has(page)) {
                this.preloadPage(page);
            }
        });
    }

    trackNavigationStart(path) {
        console.log(`Navigation started: ${path}`);
    }

    trackNavigationComplete(path, navigationTime) {
        this.performanceMetrics.navigationTimes.push(navigationTime);
        
        // Keep only last 100 navigation times
        if (this.performanceMetrics.navigationTimes.length > 100) {
            this.performanceMetrics.navigationTimes.shift();
        }
        
        console.log(`Navigation completed: ${path} in ${navigationTime.toFixed(2)}ms`);
    }

    trackNavigationError(path, error) {
        this.performanceMetrics.errorRate++;
        console.error(`Navigation error: ${path}`, error);
    }

    trackPageView(path) {
        // Google Analytics tracking
        if (typeof gtag === 'function') {
            gtag('config', 'G-SX6TDXG0N8', {
                page_path: path
            });
        }
        
        // Custom analytics
        this.sendAnalytics('page_view', {
            path,
            timestamp: Date.now(),
            userAgent: navigator.userAgent
        });
    }

    sendAnalytics(event, data) {
        // Send to your analytics service
        console.log('Analytics:', event, data);
    }

    startPerformanceMonitoring() {
        setInterval(() => {
            this.logPerformanceMetrics();
        }, 30000); // Every 30 seconds
    }

    logPerformanceMetrics() {
        const avgNavigationTime = this.performanceMetrics.navigationTimes.reduce((a, b) => a + b, 0) / this.performanceMetrics.navigationTimes.length;
        const cacheHitRate = this.performanceMetrics.cacheHitRate / (this.performanceMetrics.cacheHitRate + this.performanceMetrics.navigationTimes.length);
        
        console.log('Performance Metrics:', {
            averageNavigationTime: avgNavigationTime.toFixed(2) + 'ms',
            cacheHitRate: (cacheHitRate * 100).toFixed(1) + '%',
            errorRate: this.performanceMetrics.errorRate,
            cacheSize: this.pageCache.size,
            preloadCacheSize: this.preloadCache.size
        });
    }

    showLoading() {
        let loader = document.getElementById('spa-loader');
        if (!loader) {
            loader = document.createElement('div');
            loader.id = 'spa-loader';
            loader.innerHTML = `
                <div style="
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(255, 255, 255, 0.95);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 9999;
                    backdrop-filter: blur(3px);
                ">
                    <div style="
                        width: 50px;
                        height: 50px;
                        border: 4px solid #f3f3f3;
                        border-top: 4px solid #4f46e5;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                    "></div>
                </div>
                <style>
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                </style>
            `;
            document.body.appendChild(loader);
        }
        loader.style.display = 'flex';
    }

    hideLoading() {
        const loader = document.getElementById('spa-loader');
        if (loader) {
            loader.style.display = 'none';
        }
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            border-radius: 8px;
            color: white;
            font-weight: 500;
            z-index: 10000;
            animation: slideIn 0.3s ease;
            background: ${type === 'success' ? '#10B981' : type === 'warning' ? '#F59E0B' : '#3B82F6'};
        `;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    showError(message) {
        this.showNotification(message, 'error');
    }

    handlePopState(e) {
        const path = e.state?.path || window.location.pathname;
        this.navigate(path);
    }

    loadInitialPage() {
        const path = window.location.pathname;
        this.navigate(path);
    }

    // Public API
    goBack() {
        if (this.navigationHistory.length > 1) {
            this.navigationHistory.pop(); // Remove current page
            const previousPage = this.navigationHistory[this.navigationHistory.length - 1];
            this.navigate(previousPage.path);
        } else {
            window.history.back();
        }
    }

    goForward() {
        window.history.forward();
    }

    refresh() {
        if (this.currentPage) {
            this.pageCache.delete(this.currentPage);
            this.navigate(this.currentPage, { force: true });
        }
    }

    clearCache() {
        this.pageCache.clear();
        this.preloadCache.clear();
        this.showNotification('Cache cleared', 'success');
    }

    getPerformanceMetrics() {
        return this.performanceMetrics;
    }

    // Virtual scrolling for large lists
    initVirtualScrolling(container, items, itemHeight = 50) {
        const containerHeight = container.clientHeight;
        const visibleItems = Math.ceil(containerHeight / itemHeight) + 2;
        
        let startIndex = 0;
        let endIndex = Math.min(startIndex + visibleItems, items.length);
        
        const renderItems = () => {
            const visibleItemsArray = items.slice(startIndex, endIndex);
            container.innerHTML = '';
            
            visibleItemsArray.forEach((item, index) => {
                const element = document.createElement('div');
                element.style.height = `${itemHeight}px`;
                element.textContent = item;
                container.appendChild(element);
            });
        };
        
        container.addEventListener('scroll', () => {
            const scrollTop = container.scrollTop;
            const newStartIndex = Math.floor(scrollTop / itemHeight);
            
            if (newStartIndex !== startIndex) {
                startIndex = newStartIndex;
                endIndex = Math.min(startIndex + visibleItems, items.length);
                renderItems();
            }
        });
        
        renderItems();
    }
}

// Initialize Professional SPA when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    window.professionalSPA = new ProfessionalSPA();
    
    // Add route guards
    window.professionalSPA.addRouteGuard('/history', async () => {
        // Check if user is authenticated
        return true; // Add your auth logic here
    });
    
    // Add virtual scrolling to any large lists
    const largeLists = document.querySelectorAll('[data-virtual-scroll]');
    largeLists.forEach(list => {
        const items = Array.from(list.children).map(child => child.textContent);
        window.professionalSPA.initVirtualScrolling(list, items);
    });
});

// Export for use in other scripts
window.ProfessionalSPA = ProfessionalSPA;