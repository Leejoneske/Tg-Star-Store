/**
 * Simple SPA Router - WhatsApp-like navigation
 * Prevents page reloads and maintains state
 */
class SimpleSPA {
    constructor() {
        this.pageCache = new Map();
        this.currentPage = null;
        this.isNavigating = false;
        
        this.init();
    }

    init() {
        // Intercept all navigation clicks
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a[href]');
            if (!link) return;
            
            const href = link.getAttribute('href');
            
            // Skip external links, mailto, tel, etc.
            if (this.isExternalLink(href) || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) {
                return;
            }
            
            // Skip if it's already a hash link
            if (href.startsWith('#')) {
                return;
            }
            
            e.preventDefault();
            this.navigate(href);
        });
        
        // Handle browser back/forward
        window.addEventListener('popstate', (e) => {
            this.handlePopState(e);
        });
        
        // Load initial page
        this.loadInitialPage();
    }

    isExternalLink(href) {
        try {
            const url = new URL(href, window.location.origin);
            return url.origin !== window.location.origin;
        } catch {
            return false;
        }
    }

    async navigate(href) {
        if (this.isNavigating) return;
        
        const normalizedPath = this.normalizePath(href);
        
        // Check if it's the same page
        if (this.currentPage === normalizedPath) {
            return;
        }
        
        this.isNavigating = true;
        
        try {
            // Show loading indicator
            this.showLoading();
            
            // Load page content
            const content = await this.loadPage(normalizedPath);
            
            // Update page
            this.updatePage(normalizedPath, content);
            
            // Update URL
            window.history.pushState({ path: normalizedPath }, '', normalizedPath);
            
            // Update navigation state
            this.updateNavigationState(normalizedPath);
            
            // Track page view
            this.trackPageView(normalizedPath);
            
        } catch (error) {
            console.error('Navigation error:', error);
            // Fallback to normal navigation
            window.location.href = href;
        } finally {
            this.hideLoading();
            this.isNavigating = false;
        }
    }

    normalizePath(href) {
        // Remove .html extension
        let normalized = href.replace(/\.html$/, '');
        
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

    async loadPage(path) {
        // Check cache first
        if (this.pageCache.has(path)) {
            return this.pageCache.get(path);
        }
        
        try {
            // Determine file path
            const fileMap = {
                '/': 'index.html',
                '/sell': 'sell.html',
                '/history': 'history.html',
                '/referral': 'referral.html',
                '/about': 'about.html',
                '/blog': 'blog/index.html',
                '/knowledge-base': 'knowledge-base/index.html'
            };
            
            const file = fileMap[path];
            if (!file) {
                throw new Error(`Page not found: ${path}`);
            }
            
            const response = await fetch(file);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const html = await response.text();
            
            // Extract main content
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            // Get the main content area
            const mainContent = doc.querySelector('main') || doc.body;
            
            // Cache the content
            this.pageCache.set(path, mainContent.innerHTML);
            
            return mainContent.innerHTML;
            
        } catch (error) {
            console.error(`Failed to load page: ${path}`, error);
            throw error;
        }
    }

    updatePage(path, content) {
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
        
        // Update main content
        const mainElement = document.querySelector('main');
        if (mainElement) {
            // Add transition class
            mainElement.style.opacity = '0';
            mainElement.style.transform = 'translateY(20px)';
            
            // Wait for transition
            setTimeout(() => {
                // Update content
                mainElement.innerHTML = content;
                
                // Re-initialize page-specific scripts
                this.initializePageScripts(path);
                
                // Fade in
                mainElement.style.opacity = '1';
                mainElement.style.transform = 'translateY(0)';
            }, 150);
        }
        
        // Update current page
        this.currentPage = path;
    }

    initializePageScripts(path) {
        // Re-initialize page-specific functionality
        switch (path) {
            case '/':
                this.initializeHomePage();
                break;
            case '/sell':
                this.initializeSellPage();
                break;
            case '/history':
                this.initializeHistoryPage();
                break;
            case '/about':
                this.initializeAboutPage();
                break;
            case '/blog':
                this.initializeBlogPage();
                break;
            case '/knowledge-base':
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
        window.history.back();
    }

    goForward() {
        window.history.forward();
    }

    refresh() {
        if (this.currentPage) {
            this.pageCache.delete(this.currentPage);
            this.navigate(this.currentPage);
        }
    }

    clearCache() {
        this.pageCache.clear();
    }
}

// Initialize Simple SPA when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    window.simpleSPA = new SimpleSPA();
});

// Export for use in other scripts
window.SimpleSPA = SimpleSPA;