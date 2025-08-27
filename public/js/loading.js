// Standard Loading Component for StarStore
const LoadingComponent = {
    // Standard spinner HTML
    getSpinnerHTML(size = 'medium', text = 'Loading...', color = 'primary') {
        const sizes = {
            small: 'w-4 h-4',
            medium: 'w-8 h-8',
            large: 'w-12 h-12',
            xlarge: 'w-16 h-16'
        };
        
        const colors = {
            primary: 'border-indigo-600',
            secondary: 'border-gray-600',
            white: 'border-white',
            blue: 'border-blue-600'
        };
        
        const sizeClass = sizes[size] || sizes.medium;
        const colorClass = colors[color] || colors.primary;
        
        return `
            <div class="loading-container flex flex-col items-center justify-center p-8">
                <div class="loading-spinner ${sizeClass} ${colorClass} border-2 border-gray-200 border-t-current rounded-full animate-spin mb-4"></div>
                <div class="loading-text text-gray-600 text-sm font-medium">${text}</div>
            </div>
        `;
    },

    // Full page loading overlay
    getFullPageLoadingHTML(text = 'Loading StarStore...') {
        const loadingMessages = [
            'Preparing your StarStore experience...',
            'Setting up secure connections...',
            'Loading your personalized dashboard...',
            'Almost ready...',
            'Welcome to StarStore!'
        ];
        
        return `
            <div id="fullPageLoading" class="fixed inset-0 bg-white bg-opacity-95 flex items-center justify-center z-50">
                <div class="text-center">
                    <div class="loading-spinner w-16 h-16 border-4 border-gray-200 border-t-indigo-600 rounded-full animate-spin mb-6"></div>
                    <div class="loading-text text-gray-700 text-lg font-medium">${text}</div>
                    <div class="loading-subtitle text-gray-500 text-sm mt-2" id="loadingSubtitle">Preparing your StarStore experience...</div>
                </div>
            </div>
        `;
    },

    // Inline loading for sections
    getInlineLoadingHTML(text = 'Loading...') {
        return `
            <div class="inline-loading flex items-center justify-center py-8">
                <div class="loading-spinner w-6 h-6 border-2 border-gray-200 border-t-indigo-600 rounded-full animate-spin mr-3"></div>
                <div class="loading-text text-gray-600 text-sm">${text}</div>
            </div>
        `;
    },

    // Card loading placeholder
    getCardLoadingHTML(count = 3) {
        let cards = '';
        for (let i = 0; i < count; i++) {
            cards += `
                <div class="card-loading bg-white rounded-lg shadow-sm border border-gray-100 p-6 mb-4">
                    <div class="flex items-center mb-4">
                        <div class="loading-spinner w-8 h-8 border-2 border-gray-200 border-t-indigo-600 rounded-full animate-spin mr-3"></div>
                        <div class="flex-1">
                            <div class="h-4 bg-gray-200 rounded mb-2 animate-pulse"></div>
                            <div class="h-3 bg-gray-200 rounded w-2/3 animate-pulse"></div>
                        </div>
                    </div>
                    <div class="space-y-2">
                        <div class="h-3 bg-gray-200 rounded animate-pulse"></div>
                        <div class="h-3 bg-gray-200 rounded w-4/5 animate-pulse"></div>
                        <div class="h-3 bg-gray-200 rounded w-3/5 animate-pulse"></div>
                    </div>
                </div>
            `;
        }
        return cards;
    },

    // Show loading
    show(elementId, type = 'spinner', options = {}) {
        const element = document.getElementById(elementId);
        if (!element) return;

        const defaultOptions = {
            size: 'medium',
            text: 'Loading...',
            color: 'primary',
            count: 3
        };
        
        const config = { ...defaultOptions, ...options };
        
        let html = '';
        switch (type) {
            case 'spinner':
                html = this.getSpinnerHTML(config.size, config.text, config.color);
                break;
            case 'fullPage':
                html = this.getFullPageLoadingHTML(config.text);
                // Start cycling through loading messages
                this.startLoadingMessageCycle();
                break;
            case 'inline':
                html = this.getInlineLoadingHTML(config.text);
                break;
            case 'cards':
                html = this.getCardLoadingHTML(config.count);
                break;
            default:
                html = this.getSpinnerHTML();
        }
        
        element.innerHTML = html;
        element.style.display = 'block';
    },

    // Start cycling through loading messages
    startLoadingMessageCycle() {
        const loadingMessages = [
            'Preparing your StarStore experience...',
            'Setting up secure connections...',
            'Loading your personalized dashboard...',
            'Almost ready...',
            'Welcome to StarStore!'
        ];
        
        let currentIndex = 0;
        const subtitleElement = document.getElementById('loadingSubtitle');
        
        if (subtitleElement) {
            this.loadingMessageInterval = setInterval(() => {
                currentIndex = (currentIndex + 1) % loadingMessages.length;
                subtitleElement.textContent = loadingMessages[currentIndex];
            }, 2000); // Change message every 2 seconds
        }
    },
    
    // Stop loading message cycle
    stopLoadingMessageCycle() {
        if (this.loadingMessageInterval) {
            clearInterval(this.loadingMessageInterval);
            this.loadingMessageInterval = null;
        }
    },

    // Hide loading
    hide(elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            // Stop loading message cycle if it's running
            this.stopLoadingMessageCycle();
            element.style.display = 'none';
        }
    },

    // Replace skeleton with standard loading
    replaceSkeleton(skeletonId, loadingId, type = 'spinner', options = {}) {
        const skeleton = document.getElementById(skeletonId);
        if (skeleton) {
            skeleton.style.display = 'none';
        }
        
        this.show(loadingId, type, options);
    },

    // Initialize loading styles
    init() {
        // Add loading styles if not already present
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
                
                .animate-pulse {
                    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
                }
                
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: .5; }
                }
                
                .card-loading {
                    transition: all 0.3s ease;
                }
                
                .inline-loading {
                    transition: opacity 0.3s ease;
                }
                
                .loading-container {
                    transition: all 0.3s ease;
                }
            `;
            document.head.appendChild(style);
        }
    }
};

// Auto-initialize when DOM is loaded
// Temporarily disabled to test if this is causing the issue
/*
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        LoadingComponent.init();
    });
} else {
    LoadingComponent.init();
}
*/

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LoadingComponent;
}