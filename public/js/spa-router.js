/**
 * SPA Router - Simple client-side router for single-page app
 * Handles navigation, route matching, and history management
 */

class SPARouter {
  constructor() {
    this.currentPath = '/';
    this.routes = new Map();
    this.beforeEach = null;
    this.afterEach = null;
    this.appContainer = null;
    this.isNavigating = false;
    
    // Bind methods
    this.navigate = this.navigate.bind(this);
    this.handlePopState = this.handlePopState.bind(this);
    this.handleLinkClick = this.handleLinkClick.bind(this);
  }

  /**
   * Initialize the router
   * @param {HTMLElement} container - Element to mount page content
   */
  init(container) {
    this.appContainer = container;
    
    // Setup history navigation
    window.addEventListener('popstate', this.handlePopState);
    
    // Setup link interception
    document.addEventListener('click', this.handleLinkClick);
    
    // Load initial page based on current URL
    const path = window.location.pathname;
    this.navigate(path, { skipHistory: true });
  }

  /**
   * Register a route
   * @param {string} path - Route path (e.g., '/sell', '/referral')
   * @param {Function|string} component - Component function or template name
   * @param {Object} options - Route options
   */
  register(path, component, options = {}) {
    this.routes.set(path, {
      component,
      name: options.name || path,
      meta: options.meta || {},
      ...options
    });
  }

  /**
   * Navigate to a route
   * @param {string} path - Path to navigate to
   * @param {Object} options - Navigation options
   */
  async navigate(path, options = {}) {
    if (this.isNavigating) return;
    this.isNavigating = true;

    try {
      // Normalize path
      const normalizedPath = path.startsWith('/') ? path : '/' + path;
      const cleanPath = normalizedPath.split('?')[0].split('#')[0];

      // Check if route exists
      const route = this.routes.get(cleanPath);
      
      if (!route) {
        // Try index as fallback for root
        if (cleanPath === '/') {
          await this.loadAndRender('/', this.routes.get('/'));
        } else {
          console.warn(`Route not found: ${cleanPath}`);
          this.isNavigating = false;
          return;
        }
      } else {
        // Call before hook
        if (this.beforeEach) {
          const canNavigate = await this.beforeEach({ 
            from: this.currentPath, 
            to: cleanPath,
            route 
          });
          if (!canNavigate) {
            this.isNavigating = false;
            return;
          }
        }

        // Load and render
        await this.loadAndRender(cleanPath, route);
      }

      // Update history if not already handled
      if (!options.skipHistory && window.location.pathname !== cleanPath) {
        window.history.pushState({ path: cleanPath }, '', cleanPath);
      }

      // Update current path
      this.currentPath = cleanPath;

      // Call after hook
      if (this.afterEach) {
        await this.afterEach({ path: cleanPath, route: this.routes.get(cleanPath) });
      }

      // Scroll to top
      if (this.appContainer) {
        this.appContainer.scrollTop = 0;
      }
    } catch (error) {
      console.error('Navigation error:', error);
    } finally {
      this.isNavigating = false;
    }
  }

  /**
   * Load and render a route
   * @private
   */
  async loadAndRender(path, route) {
    if (!route || !this.appContainer) return;

    try {
      // Show loading state
      this.appContainer.innerHTML = '<div class="loading-spinner"></div>';

      let content;
      let fullDocument = null;

      if (typeof route.component === 'function') {
        // If component is a function, call it
        content = await route.component();
      } else if (typeof route.component === 'string') {
        // If component is a string, fetch the template
        const response = await fetch(`/templates/${route.component}.html`);
        if (!response.ok) {
          throw new Error(`Failed to load template: ${route.component}`);
        }
        content = await response.text();
      } else {
        throw new Error(`Invalid component type for route: ${path}`);
      }

      // Parse the content to extract app-container and scripts
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = content;
      
      // Extract app-container content
      const appContainer = tempDiv.querySelector('.app-container');
      const containerHTML = appContainer ? appContainer.innerHTML : content;
      
      // Extract all script tags
      const scripts = tempDiv.querySelectorAll('script');
      const scriptContents = Array.from(scripts).map(script => ({
        src: script.src,
        content: script.innerHTML,
        type: script.type || 'text/javascript'
      }));

      // Render HTML content
      this.appContainer.innerHTML = containerHTML;

      // Execute extracted scripts in order
      for (const script of scriptContents) {
        try {
          if (script.src) {
            // External script
            await this.loadExternalScript(script.src);
          } else if (script.content) {
            // Inline script
            await this.executeScript(script.content, script.type);
          }
        } catch (error) {
          console.warn(`Script execution warning for route ${path}:`, error);
          // Continue loading even if one script fails
        }
      }

      // Reinitialize page components
      this.initializePageScripts();
    } catch (error) {
      console.error('Render error:', error);
      this.appContainer.innerHTML = `<div class="error-state"><p>Failed to load page: ${error.message}</p></div>`;
    }
  }

  /**
   * Load external script
   * @private
   */
  loadExternalScript(src) {
    return new Promise((resolve, reject) => {
      // Skip if already loaded
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.type = 'text/javascript';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.head.appendChild(script);
    });
  }

  /**
   * Execute inline script content
   * @private
   */
  executeScript(content, type = 'text/javascript') {
    return new Promise((resolve) => {
      try {
        // Create and execute script in global context
        const script = document.createElement('script');
        script.type = type;
        script.textContent = content;
        script.async = false;
        
        // Append to document to execute in global scope
        document.body.appendChild(script);
        
        // For inline scripts, resolve immediately (they execute synchronously)
        // Use setTimeout to allow async operations to start
        setTimeout(() => resolve(), 50);
      } catch (error) {
        console.error('Script execution error:', error);
        // Resolve even on error to continue loading
        resolve();
      }
    });
  }

  /**
   * Initialize page-specific scripts after render
   * @private
   */
  async initializePageScripts() {
    // Add small delay to ensure DOM is fully updated
    await new Promise(resolve => setTimeout(resolve, 100));

    // Reinitialize translations if available
    if (typeof TranslationUtils !== 'undefined') {
      try {
        TranslationUtils.applyTranslations();
      } catch (e) {
        console.warn('Translation initialization error:', e);
      }
    }

    // Reinitialize theme
    if (typeof updateTheme === 'function') {
      try {
        updateTheme();
      } catch (e) {
        console.warn('Theme update error:', e);
      }
    }

    // Load bottom navigation if needed
    const bottomnavContainer = document.getElementById('bottomnav-container');
    if (bottomnavContainer && !bottomnavContainer.innerHTML.trim()) {
      try {
        const response = await fetch('/bottomnav.html');
        if (response.ok) {
          const html = await response.text();
          bottomnavContainer.innerHTML = html;
          // Re-apply translations to bottomnav
          if (typeof TranslationUtils !== 'undefined') {
            TranslationUtils.applyTranslations();
          }
        }
      } catch (e) {
        console.warn('Bottomnav loading error:', e);
      }
    }

    // Dispatch custom event for page init
    // Use setTimeout to ensure event fires after scripts have executed
    setTimeout(() => {
      document.dispatchEvent(new CustomEvent('spa:pageLoaded', {
        detail: { path: this.currentPath }
      }));
    }, 100);
  }

  /**
   * Handle browser back/forward buttons
   * @private
   */
  handlePopState(event) {
    const path = event.state?.path || '/';
    this.navigate(path, { skipHistory: true });
  }

  /**
   * Intercept link clicks for SPA navigation
   * @private
   */
  handleLinkClick(event) {
    const link = event.target.closest('a');
    
    if (!link) return;

    const href = link.getAttribute('href');
    
    // Only handle internal links
    if (!href || href.startsWith('http') || href.startsWith('tel:') || href.startsWith('mailto:')) {
      return;
    }

    // Don't intercept if target is blank
    if (link.getAttribute('target') === '_blank') {
      return;
    }

    // Open in external browser for Telegram WebApp links
    if (link.classList.contains('external-link') && window.Telegram?.WebApp?.openLink) {
      event.preventDefault();
      window.Telegram.WebApp.openLink(href);
      return;
    }

    // Check if this is a registered route
    const path = href.split('?')[0].split('#')[0];
    if (this.routes.has(path)) {
      event.preventDefault();
      this.navigate(path);
    }
  }

  /**
   * Get current route
   */
  getCurrentRoute() {
    return this.routes.get(this.currentPath);
  }

  /**
   * Set before navigation hook
   */
  setBeforeEach(callback) {
    this.beforeEach = callback;
  }

  /**
   * Set after navigation hook
   */
  setAfterEach(callback) {
    this.afterEach = callback;
  }
}

// Export the router
window.SPARouter = SPARouter;
