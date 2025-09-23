// Simple Loading Component for StarStore
const LoadingComponent = {
    // Show loading
    show(elementId, type = 'spinner', options = {}) {
        const element = document.getElementById(elementId);
        if (!element) return;
        
        // Simple loading HTML
        element.innerHTML = `
            <div class="flex items-center justify-center p-8">
                <div class="loading-spinner w-8 h-8 border-2 border-gray-200 border-t-indigo-600 rounded-full animate-spin"></div>
                <div class="ml-3 text-gray-600">Loading...</div>
            </div>
        `;
        element.style.display = 'block';
    },

    // Hide loading
    hide(elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            element.style.display = 'none';
        }
    },

    // Initialize loading styles
    init() {
        // Add basic loading styles
        if (!document.getElementById('loading-styles')) {
            const style = document.createElement('style');
            style.id = 'loading-styles';
            style.textContent = `
                .loading-spinner {
                    animation: spin 1s linear infinite;
                }
                
                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
            `;
            document.head.appendChild(style);
        }
    }
};

(function(){
	const once = (fn) => {
		let called = false;
		return function(...args) {
			if (called) return;
			called = true;
			return fn.apply(this, args);
		};
	};

	window.initializeTranslations = window.initializeTranslations || async function initializeTranslations() {
		return Promise.resolve();
	};

	window.initializeCommon = window.initializeCommon || once(function initializeCommon() {
		// Hook up any common listeners if needed
	});

	window.initializeHomePage = window.initializeHomePage || once(function initializeHomePage() {
		// Home page specific bootstrapping
	});

	window.initializeSellPage = window.initializeSellPage || once(function initializeSellPage() {
		// Sell page specific bootstrapping
	});

	window.initializeHistoryPage = window.initializeHistoryPage || once(function initializeHistoryPage() {
		// History page specific bootstrapping
	});

	window.initializeAboutPage = window.initializeAboutPage || once(function initializeAboutPage() {
		// About page specific bootstrapping
	});

	window.initializeBlogPage = window.initializeBlogPage || once(function initializeBlogPage() {
		// Blog page specific bootstrapping
	});

	window.initializeKnowledgeBasePage = window.initializeKnowledgeBasePage || once(function initializeKnowledgeBasePage() {
		// Knowledge base page specific bootstrapping
	});
})();

// Auto-initialize when DOM is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        LoadingComponent.init();
    });
} else {
    LoadingComponent.init();
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LoadingComponent;
}