// Simple Loading Component for StarStore
const LoadingComponent = {
    // Show loading
    show(elementId, type = 'spinner', options = {}) {
        const element = document.getElementById(elementId);
        if (!element) return;
        
        if (type === 'cards') {
            // Card skeleton loading (like daily page tasks)
            const count = options.count || 3;
            let cardsHTML = '';
            for (let i = 0; i < count; i++) {
                cardsHTML += `
                    <div class="bg-white rounded-lg p-4 mb-3 shadow-sm animate-pulse">
                        <div class="flex items-center space-x-4">
                            <div class="w-12 h-12 bg-gray-200 rounded-full"></div>
                            <div class="flex-1 space-y-2">
                                <div class="h-4 bg-gray-200 rounded w-3/4"></div>
                                <div class="h-3 bg-gray-200 rounded w-1/2"></div>
                            </div>
                            <div class="w-16 h-6 bg-gray-200 rounded"></div>
                        </div>
                    </div>
                `;
            }
            element.innerHTML = cardsHTML;
        } else {
            // Simple spinner loading
            element.innerHTML = `
                <div class="flex items-center justify-center p-8">
                    <div class="loading-spinner w-8 h-8 border-2 border-gray-200 border-t-blue-600 rounded-full animate-spin"></div>
                    <div class="ml-3 text-gray-600">Loading...</div>
                </div>
            `;
        }
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