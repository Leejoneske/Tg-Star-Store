/**
 * Single Page Application Router
 * Handles client-side navigation without page reloads
 */
class SPARouter {
    constructor() {
        this.routes = new Map();
        this.currentPage = null;
        this.pageCache = new Map();
        this.loadingStates = new Map();
        this.history = [];
        this.maxHistorySize = 10;
        
        this.init();
    }

    init() {
        // Define routes
        this.defineRoutes();
        
        // Handle browser back/forward
        window.addEventListener('popstate', (e) => {
            this.handlePopState(e);
        });
        
        // Handle initial load
        this.handleInitialLoad();
        
        // Intercept all navigation links
        this.interceptNavigation();
    }

    defineRoutes() {
        this.routes.set('/', {
            path: '/',
            file: 'index.html',
            title: 'StarStore | Buy & Sell Telegram Stars',
            component: 'home'
        });
        
        this.routes.set('/sell', {
            path: '/sell',
            file: 'sell.html',
            title: 'Sell Telegram Stars | StarStore',
            component: 'sell'
        });
        
        this.routes.set('/history', {
            path: '/history',
            file: 'history.html',
            title: 'Transaction History | StarStore',
            component: 'history'
        });
        
        this.routes.set('/referral', {
            path: '/referral',
            file: 'referral.html',
            title: 'Referral Program | StarStore',
            component: 'referral'
        });
        
        this.routes.set('/about', {
            path: '/about',
            file: 'about.html',
            title: 'About StarStore | Telegram Stars Platform',
            component: 'about'
        });
        
        this.routes.set('/blog', {
            path: '/blog',
            file: 'blog/index.html',
            title: 'StarStore Insights | Blog',
            component: 'blog'
        });
        
        this.routes.set('/knowledge-base', {
            path: '/knowledge-base',
            file: 'knowledge-base/index.html',
            title: 'Knowledge Base | StarStore',
            component: 'knowledge-base'
        });
    }

    interceptNavigation() {
        // Intercept all anchor clicks
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a[href]');
            if (!link) return;
            
            const href = link.getAttribute('href');
            
            // Skip external links, mailto, tel, etc.
            if (this.isExternalLink(href) || href.startsWith('mailto:') || href.startsWith('tel:')) {
                return;
            }
            
            // Skip if it's already a hash link
            if (href.startsWith('#')) {
                return;
            }
            
            e.preventDefault();
            this.navigate(href);
        });
    }

    isExternalLink(href) {
        try {
            const url = new URL(href, window.location.origin);
            return url.origin !== window.location.origin;
        } catch {
            return false;
        }
    }

    async navigate(path, addToHistory = true) {
        // Normalize path
        const normalizedPath = this.normalizePath(path);
        
        // Check if it's the same page
        if (this.currentPage === normalizedPath) {
            return;
        }
        
        // Show loading state
        this.showLoading();
        
        try {
            // Get route info
            const route = this.routes.get(normalizedPath);
            if (!route) {
                throw new Error(`Route not found: ${normalizedPath}`);
            }
            
            // Load page content
            const content = await this.loadPage(route);
            
            // Update page
            await this.updatePage(route, content);
            
            // Update history
            if (addToHistory) {
                this.addToHistory(normalizedPath);
                window.history.pushState({ path: normalizedPath }, '', normalizedPath);
            }
            
            // Update navigation state
            this.updateNavigationState(normalizedPath);
            
            // Track page view
            this.trackPageView(normalizedPath);
            
        } catch (error) {
            console.error('Navigation error:', error);
            this.showError('Failed to load page. Please try again.');
        } finally {
            this.hideLoading();
        }
    }

    normalizePath(path) {
        // Remove .html extension
        let normalized = path.replace(/\.html$/, '');
        
        // Ensure leading slash
        if (!normalized.startsWith('/')) {
            normalized = '/' + normalized;
        }
        
        // Handle root
        if (normalized === '/index' || normalized === '/index.html') {
            normalized = '/';
        }
        
        return normalized;
    }

    async loadPage(route) {
        // Check cache first
        if (this.pageCache.has(route.path)) {
            return this.pageCache.get(route.path);
        }
        
        try {
            // Fetch the static HTML file directly
            const response = await fetch(route.file, {
                cache: 'no-cache',
                headers: { 'Cache-Control': 'no-cache' }
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const html = await response.text();
            
            // Extract main content (skip head, keep only body content)
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            // Get the main content area
            const mainContent = doc.querySelector('main') || doc.body;
            
            // Cache the content
            this.pageCache.set(route.path, mainContent.innerHTML);
            
            return mainContent.innerHTML;
            
        } catch (error) {
            console.error(`Failed to load page: ${route.component}`, error);
            throw error;
        }
    }

    async updatePage(route, content) {
        // Update title
        document.title = route.title;
        
        // Update main content
        const mainElement = document.querySelector('main');
        if (mainElement) {
            // Add transition class
            mainElement.style.opacity = '0';
            mainElement.style.transform = 'translateY(20px)';
            
            // Wait for transition
            await new Promise(resolve => setTimeout(resolve, 150));
            
            // Update content
            mainElement.innerHTML = content;
            
            // Re-initialize page-specific scripts
            this.initializePageScripts(route.component);
            
            // Fade in
            mainElement.style.opacity = '1';
            mainElement.style.transform = 'translateY(0)';
        }
        
        // Update current page
        this.currentPage = route.path;
    }

    initializePageScripts(component) {
        // Re-initialize page-specific functionality
        switch (component) {
            case 'home':
                this.initializeHomePage();
                break;
            case 'sell':
                this.initializeSellPage();
                break;
            case 'history':
                this.initializeHistoryPage();
                break;
            case 'about':
                this.initializeAboutPage();
                break;
            case 'blog':
                this.initializeBlogPage();
                break;
            case 'knowledge-base':
                this.initializeKnowledgeBasePage();
                break;
        }
        
        // Re-initialize common functionality
        this.initializeCommonScripts();
    }

    initializeHomePage() {
        // Re-initialize TON Connect if needed
        if (window.tonConnectUI) {
            // TON Connect should auto-initialize
        }
        
        // Re-initialize any home-specific functionality
        if (typeof initializeHomePage === 'function') {
            initializeHomePage();
        }
    }

    initializeSellPage() {
        // Re-initialize sell page functionality
        if (typeof initializeSellPage === 'function') {
            initializeSellPage();
        }
    }

    initializeHistoryPage() {
        // Re-initialize history page functionality
        if (typeof initializeHistoryPage === 'function') {
            initializeHistoryPage();
        }
    }

    initializeAboutPage() {
        // Re-initialize about page functionality
        if (typeof initializeAboutPage === 'function') {
            initializeAboutPage();
        }
    }

    initializeBlogPage() {
        // Re-initialize blog page functionality
        if (typeof initializeBlogPage === 'function') {
            initializeBlogPage();
        }
    }

    initializeKnowledgeBasePage() {
        // Re-initialize knowledge base functionality
        if (typeof initializeKnowledgeBasePage === 'function') {
            initializeKnowledgeBasePage();
        }
    }

    initializeCommonScripts() {
        // Re-initialize translations
        if (typeof initializeTranslations === 'function') {
            initializeTranslations();
        }
        
        // Re-initialize any other common functionality
        if (typeof initializeCommon === 'function') {
            initializeCommon();
        }
    }

    addToHistory(path) {
        this.history.push(path);
        
        // Limit history size
        if (this.history.length > this.maxHistorySize) {
            this.history.shift();
        }
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

    trackPageView(path) {
        // Google Analytics tracking
        if (typeof gtag === 'function') {
            gtag('config', 'G-SX6TDXG0N8', {
                page_path: path
            });
        }
    }

    showLoading() {
        // Create or show loading indicator
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
                    background: rgba(255, 255, 255, 0.9);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 9999;
                    backdrop-filter: blur(2px);
                ">
                    <div style="
                        width: 40px;
                        height: 40px;
                        border: 3px solid #f3f3f3;
                        border-top: 3px solid #4f46e5;
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

    showError(message) {
        // Show error message (you can customize this)
        console.error('SPA Error:', message);
        // You could show a toast notification here
    }

    handlePopState(e) {
        const path = e.state?.path || window.location.pathname;
        this.navigate(path, false);
    }

    handleInitialLoad() {
        const path = window.location.pathname;
        this.navigate(path, false);
    }

    // Public API
    goBack() {
        if (this.history.length > 1) {
            this.history.pop(); // Remove current page
            const previousPage = this.history[this.history.length - 1];
            this.navigate(previousPage);
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
            this.navigate(this.currentPage, false);
        }
    }

    clearCache() {
        this.pageCache.clear();
    }
}

// Initialize SPA Router
window.spaRouter = new SPARouter();

// Export for use in other scripts
window.SPARouter = SPARouter;