/**
 * Reconnection Manager for StarStore MiniApp
 * Handles graceful reconnection to servers with exponential backoff
 * Secure by design - no sensitive data exposure
 */

window.ReconnectManager = (() => {
    // Private state - not exposed
    const state = {
        isConnected: true,
        isReconnecting: false,
        reconnectAttempts: 0,
        maxReconnectAttempts: 10,
        baseDelay: 1000, // 1 second
        maxDelay: 30000, // 30 seconds
        currentDelay: 1000,
        reconnectTimeout: null,
        healthCheckInterval: null,
        lastSuccessfulConnection: Date.now(),
        showOverlayDelay: 3000, // Show overlay after 3 seconds of disconnection
        showOverlayTimeout: null // Track the show overlay timeout
    };

    // UI elements
    let reconnectUI = null;

    /**
     * Initialize the reconnection manager
     */
    const init = () => {
        console.log('Reconnect Manager: Initializing');
        createReconnectUI();
        setupHealthCheck();
        setupGlobalErrorHandlers();
    };

    /**
     * Create UI for reconnection status
     */
    const createReconnectUI = () => {
        const container = document.createElement('div');
        container.id = 'reconnect-manager';
        container.innerHTML = `
            <div id="reconnect-overlay" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex flex-col items-center justify-center">
                <div class="bg-white rounded-lg p-6 m-4 max-w-sm w-full shadow-xl">
                    <div class="text-center">
                        <h2 class="text-lg font-semibold text-gray-800 mb-2">Connection Lost</h2>
                        <p class="text-gray-600 text-sm mb-4">Attempting to reconnect to server...</p>
                        
                        <div class="flex justify-center mb-4">
                            <div class="animate-spin h-8 w-8 border-4 border-gray-200 border-t-blue-500 rounded-full"></div>
                        </div>
                        
                        <div id="reconnect-status" class="text-xs text-gray-500 mb-3">
                            <p>Attempt <span id="attempt-count">0</span>/10</p>
                            <p>Retry in <span id="retry-countdown">--</span>s</p>
                        </div>
                        
                        <button id="manual-retry-btn" class="w-full px-4 py-2 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition mb-2">
                            Try Now
                        </button>
                        
                        <button id="retry-cancel-btn" class="w-full px-4 py-2 bg-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-400 transition">
                            Close App
                        </button>
                    </div>
                </div>
            </div>

            <!-- Connection Status Indicator - Always visible when connected -->
            <style>
                @keyframes reconnect-pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.7; }
                }
                #connection-status-indicator {
                    animation: reconnect-pulse 2s ease-in-out infinite;
                }
            </style>

            <div id="connection-status-indicator" style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 40; pointer-events: none; display: block !important;">
                <div style="background-color: #22c55e; color: white; padding: 12px 24px; border-radius: 9999px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
                    <div style="width: 12px; height: 12px; background-color: white; border-radius: 50%;"></div>
                    <span>Connected</span>
                </div>
            </div>

            <div id="reconnect-toast" class="hidden fixed bottom-4 right-4 bg-green-500 text-white px-4 py-2 rounded-lg shadow-lg z-40 animate-pulse">
                Connection restored
            </div>
        `;
        
        document.body.appendChild(container);
        reconnectUI = {
            overlay: document.getElementById('reconnect-overlay'),
            attemptCount: document.getElementById('attempt-count'),
            retryCountdown: document.getElementById('retry-countdown'),
            manualRetry: document.getElementById('manual-retry-btn'),
            cancel: document.getElementById('retry-cancel-btn'),
            toast: document.getElementById('reconnect-toast'),
            statusIndicator: document.getElementById('connection-status-indicator')
        };

        // Event listeners
        reconnectUI.manualRetry.addEventListener('click', manualRetry);
        reconnectUI.cancel.addEventListener('click', cancelReconnect);
    };

    /**
     * Setup global error handlers for network failures
     */
    const setupGlobalErrorHandlers = () => {
        // Handle fetch errors
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
            try {
                const response = await originalFetch.apply(this, args);
                
                if (response.ok) {
                    onConnectionSuccess();
                } else if (response.status >= 500 || response.status === 0) {
                    // Server error or network error
                    onConnectionFailure(`HTTP ${response.status}`);
                }
                
                return response;
            } catch (error) {
                // Network error (no connection, timeout, etc.)
                onConnectionFailure(error);
                throw error;
            }
        };

        // Handle unhandled promise rejections
        window.addEventListener('unhandledrejection', (event) => {
            if (event.reason && (event.reason.message?.includes('Failed to fetch') || 
                                 event.reason.message?.includes('Network') ||
                                 event.reason.message?.includes('timeout'))) {
                onConnectionFailure(event.reason);
                // Don't prevent default for user notification
            }
        });
    };

    /**
     * Setup periodic health checks
     */
    const setupHealthCheck = () => {
        // Check connection every 30 seconds
        state.healthCheckInterval = setInterval(async () => {
            if (!state.isConnected) return;
            
            try {
                // Simple health check - doesn't require auth
                const response = await fetch('/api/health', {
                    method: 'GET',
                    timeout: 5000
                });
                
                if (response.ok) {
                    onConnectionSuccess();
                } else if (response.status >= 500) {
                    onConnectionFailure(`Health check failed: ${response.status}`);
                }
            } catch (error) {
                onConnectionFailure(error);
            }
        }, 30000);
    };

    /**
     * Handle connection success
     */
    const onConnectionSuccess = () => {
        if (!state.isConnected) {
            console.log('Reconnect Manager: Connection restored');
            state.isConnected = true;
            state.isReconnecting = false;
            state.reconnectAttempts = 0;
            state.currentDelay = state.baseDelay;
            state.lastSuccessfulConnection = Date.now();
            
            hideReconnectUI();
            showToast('Connection restored');
            
            // Trigger custom event for app state recovery
            window.dispatchEvent(new CustomEvent('connection-restored'));
        }
    };

    /**
     * Handle connection failure
     */
    const onConnectionFailure = (error) => {
        if (state.isConnected) {
            console.warn('Reconnect Manager: Connection lost', error?.message || error);
            state.isConnected = false;
            state.reconnectAttempts = 0;
            state.currentDelay = state.baseDelay;
            
            // Clear any existing delay timeout
            if (state.showOverlayTimeout) {
                clearTimeout(state.showOverlayTimeout);
            }
            
            // Show UI after 3 second delay to prevent flashing on quick reconnects
            state.showOverlayTimeout = setTimeout(() => {
                showReconnectUI();
                state.showOverlayTimeout = null;
            }, state.showOverlayDelay);
            
            startReconnectProcess();
            
            // Trigger custom event for app state freeze
            window.dispatchEvent(new CustomEvent('connection-lost'));
        }
    };

    /**
     * Start the reconnection process with exponential backoff
     */
    const startReconnectProcess = () => {
        if (state.isReconnecting) return;
        
        state.isReconnecting = true;
        attemptReconnect();
    };

    /**
     * Attempt to reconnect
     */
    const attemptReconnect = () => {
        if (state.reconnectAttempts >= state.maxReconnectAttempts) {
            console.error('Reconnect Manager: Max reconnection attempts reached');
            showMaxAttemptsUI();
            return;
        }

        state.reconnectAttempts++;
        updateReconnectUI();
        
        // Clear previous timeout
        if (state.reconnectTimeout) {
            clearTimeout(state.reconnectTimeout);
        }

        // Calculate delay with exponential backoff + jitter
        const jitter = Math.random() * 1000; // 0-1s random jitter
        const delay = Math.min(
            state.baseDelay * Math.pow(2, state.reconnectAttempts - 1) + jitter,
            state.maxDelay
        );
        
        state.currentDelay = delay;
        
        // Schedule next attempt
        state.reconnectTimeout = setTimeout(() => {
            performHealthCheck();
        }, delay);
    };

    /**
     * Perform a health check
     */
    const performHealthCheck = async () => {
        try {
            const response = await fetch('/api/health', {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 5000
            });

            if (response.ok) {
                onConnectionSuccess();
            } else {
                // Server error, retry
                attemptReconnect();
            }
        } catch (error) {
            // Still no connection, retry
            attemptReconnect();
        }
    };

    /**
     * Manual retry triggered by user
     */
    const manualRetry = () => {
        state.reconnectAttempts = Math.max(0, state.reconnectAttempts - 2); // Give user a bonus
        state.currentDelay = state.baseDelay;
        performHealthCheck();
    };

    /**
     * Cancel reconnection attempt
     */
    const cancelReconnect = () => {
        console.log('Reconnect Manager: Reconnection cancelled by user');
        
        if (state.reconnectTimeout) {
            clearTimeout(state.reconnectTimeout);
        }
        
        state.isReconnecting = false;
        hideReconnectUI();
        
        // Trigger custom event for app shutdown
        window.dispatchEvent(new CustomEvent('reconnect-cancelled'));
    };

    /**
     * Update reconnect UI with current status
     */
    const updateReconnectUI = () => {
        if (!reconnectUI) return;
        
        const countdownSeconds = Math.ceil(state.currentDelay / 1000);
        reconnectUI.attemptCount.textContent = state.reconnectAttempts;
        reconnectUI.retryCountdown.textContent = countdownSeconds;
        
        // Update countdown every 100ms
        let elapsed = 0;
        const countdownInterval = setInterval(() => {
            elapsed += 100;
            const remaining = Math.ceil((state.currentDelay - elapsed) / 1000);
            if (reconnectUI && remaining >= 0) {
                reconnectUI.retryCountdown.textContent = remaining;
            }
            if (elapsed >= state.currentDelay) {
                clearInterval(countdownInterval);
            }
        }, 100);
    };

    /**
     * Show reconnect overlay
     */
    const showReconnectUI = () => {
        if (!reconnectUI?.overlay) return;
        
        // Hide status indicator when showing overlay
        if (reconnectUI.statusIndicator) {
            reconnectUI.statusIndicator.style.display = 'none !important';
        }
        
        reconnectUI.overlay.classList.remove('hidden');
        updateReconnectUI();
    };

    /**
     * Hide reconnect overlay
     */
    const hideReconnectUI = () => {
        if (!reconnectUI?.overlay) return;
        
        // Clear any pending overlay timeout
        if (state.showOverlayTimeout) {
            clearTimeout(state.showOverlayTimeout);
            state.showOverlayTimeout = null;
        }
        
        reconnectUI.overlay.classList.add('hidden');
        
        // Show status indicator when hiding overlay
        if (reconnectUI.statusIndicator) {
            reconnectUI.statusIndicator.style.display = 'block !important';
        }
    };

    /**
     * Show max attempts UI
     */
    const showMaxAttemptsUI = () => {
        if (reconnectUI?.overlay) {
            const statusDiv = document.querySelector('#reconnect-status');
            const spinnerDiv = reconnectUI.overlay.querySelector('.animate-spin')?.parentElement;
            
            if (statusDiv) {
                statusDiv.innerHTML = `
                    <p class="text-red-600 font-semibold">Connection Failed</p>
                    <p class="text-gray-600 text-xs mt-1">Unable to reconnect after multiple attempts</p>
                `;
            }
            
            if (spinnerDiv) {
                spinnerDiv.innerHTML = '';
            }
            
            reconnectUI.manualRetry.textContent = 'Try Again';
            reconnectUI.manualRetry.onclick = () => {
                state.reconnectAttempts = 0;
                state.currentDelay = state.baseDelay;
                startReconnectProcess();
            };
        }
    };

    /**
     * Show temporary toast message
     */
    const showToast = (message) => {
        if (!reconnectUI?.toast) return;
        
        reconnectUI.toast.textContent = message;
        reconnectUI.toast.classList.remove('hidden');
        
        setTimeout(() => {
            reconnectUI.toast.classList.add('hidden');
        }, 3000);
    };

    /**
     * Get current connection status
     */
    const getStatus = () => ({
        isConnected: state.isConnected,
        isReconnecting: state.isReconnecting,
        attempts: state.reconnectAttempts,
        maxAttempts: state.maxReconnectAttempts,
        nextRetryIn: state.currentDelay,
        lastSuccess: new Date(state.lastSuccessfulConnection)
    });

    /**
     * Cleanup
     */
    const destroy = () => {
        if (state.reconnectTimeout) clearTimeout(state.reconnectTimeout);
        if (state.healthCheckInterval) clearInterval(state.healthCheckInterval);
        
        if (reconnectUI?.overlay?.parentElement) {
            reconnectUI.overlay.parentElement.remove();
        }
    };

    // Public API
    return {
        init,
        getStatus,
        destroy,
        // For manual control if needed
        forceReconnect: startReconnectProcess,
        cancelReconnect: cancelReconnect
    };
})();

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.ReconnectManager.init());
} else {
    window.ReconnectManager.init();
}
