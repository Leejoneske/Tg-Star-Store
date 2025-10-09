// Advanced Telegram Mini App Fullscreen Manager
class TelegramFullscreenManager {
    constructor() {
        this.webApp = null;
        this.isFullscreen = false;
        this.isImmersiveMode = false;
        this.originalViewport = null;
        this.init();
    }

    init() {
        // Check if we're in Telegram WebApp
        if (window.Telegram?.WebApp) {
            this.webApp = window.Telegram.WebApp;
            this.setupFullscreen();
            this.setupEventListeners();
            console.log('Telegram Fullscreen Manager initialized');
        } else {
            console.log('Not in Telegram WebApp environment');
        }
    }

    setupFullscreen() {
        // Initialize WebApp
        this.webApp.ready();
        
        // Enable fullscreen by default
        this.enableFullscreen();
        
        // Add fullscreen class to body
        document.body.classList.add('telegram-fullscreen');
        
        // Store original viewport
        this.originalViewport = document.querySelector('meta[name="viewport"]')?.getAttribute('content');
        
        console.log('Telegram fullscreen setup complete');
    }

    setupEventListeners() {
        // Listen for viewport changes
        window.addEventListener('resize', () => {
            this.handleViewportChange();
        });

        // Listen for orientation changes
        window.addEventListener('orientationchange', () => {
            setTimeout(() => {
                this.handleOrientationChange();
            }, 100);
        });

        // Listen for theme changes
        if (this.webApp.onEvent) {
            this.webApp.onEvent('themeChanged', () => {
                this.handleThemeChange();
            });
        }

        // Listen for back button
        if (this.webApp.BackButton) {
            this.webApp.BackButton.onClick(() => {
                this.handleBackButton();
            });
        }
    }

    enableFullscreen() {
        if (!this.webApp) return;

        try {
            // Expand the viewport to full screen
            this.webApp.expand();
            
            // Enable immersive mode if available
            if (this.webApp.enableClosingConfirmation) {
                this.webApp.enableClosingConfirmation();
            }

            // Hide the main button if visible
            if (this.webApp.MainButton) {
                this.webApp.MainButton.hide();
            }

            // Set up the header
            if (this.webApp.HeaderColor) {
                this.webApp.HeaderColor.setColor('#1a1a1a'); // Dark header
            }

            // Set background color
            if (this.webApp.backgroundColor) {
                this.webApp.backgroundColor = '#1a1a1a';
            }

            this.isFullscreen = true;
            console.log('Fullscreen mode enabled');
        } catch (error) {
            console.error('Error enabling fullscreen:', error);
        }
    }

    disableFullscreen() {
        if (!this.webApp) return;

        try {
            // Disable closing confirmation
            if (this.webApp.disableClosingConfirmation) {
                this.webApp.disableClosingConfirmation();
            }

            // Show main button
            if (this.webApp.MainButton) {
                this.webApp.MainButton.show();
            }

            this.isFullscreen = false;
            console.log('Fullscreen mode disabled');
        } catch (error) {
            console.error('Error disabling fullscreen:', error);
        }
    }

    enableImmersiveMode() {
        if (!this.webApp) return;

        try {
            // Enable immersive mode features
            this.webApp.expand();
            
            // Hide header if possible
            if (this.webApp.HeaderColor) {
                this.webApp.HeaderColor.setColor('transparent');
            }

            // Set viewport for immersive experience
            this.setImmersiveViewport();

            // Add immersive class
            document.body.classList.add('telegram-immersive');
            document.body.classList.add('telegram-gamify');

            this.isImmersiveMode = true;
            console.log('Immersive mode enabled');
        } catch (error) {
            console.error('Error enabling immersive mode:', error);
        }
    }

    disableImmersiveMode() {
        if (!this.webApp) return;

        try {
            // Restore header
            if (this.webApp.HeaderColor) {
                this.webApp.HeaderColor.setColor('#1a1a1a');
            }

            // Restore viewport
            this.restoreViewport();

            // Remove immersive classes
            document.body.classList.remove('telegram-immersive');
            document.body.classList.remove('telegram-gamify');

            this.isImmersiveMode = false;
            console.log('Immersive mode disabled');
        } catch (error) {
            console.error('Error disabling immersive mode:', error);
        }
    }

    setImmersiveViewport() {
        const viewport = document.querySelector('meta[name="viewport"]');
        if (viewport) {
            viewport.setAttribute('content', 
                'width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no, shrink-to-fit=no, viewport-fit=cover, interactive-widget=resizes-content'
            );
        }
    }

    restoreViewport() {
        const viewport = document.querySelector('meta[name="viewport"]');
        if (viewport && this.originalViewport) {
            viewport.setAttribute('content', this.originalViewport);
        }
    }

    handleViewportChange() {
        // Adjust layout for viewport changes
        this.updateLayout();
    }

    handleOrientationChange() {
        // Handle orientation changes
        setTimeout(() => {
            this.updateLayout();
        }, 200);
    }

    handleThemeChange() {
        // Handle theme changes
        const isDark = this.webApp.colorScheme === 'dark';
        document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    }

    handleBackButton() {
        // Handle back button press
        if (this.isImmersiveMode) {
            this.disableImmersiveMode();
        } else {
            // Default back behavior
            window.history.back();
        }
    }

    updateLayout() {
        // Update layout based on current state
        const container = document.querySelector('.app-container');
        if (container) {
            if (this.isImmersiveMode) {
                container.style.paddingTop = '0';
                container.style.paddingBottom = '0';
            } else {
                container.style.paddingTop = '';
                container.style.paddingBottom = '';
            }
        }
    }

    // Public API methods
    toggleFullscreen() {
        if (this.isFullscreen) {
            this.disableFullscreen();
        } else {
            this.enableFullscreen();
        }
    }

    toggleImmersiveMode() {
        if (this.isImmersiveMode) {
            this.disableImmersiveMode();
        } else {
            this.enableImmersiveMode();
        }
    }

    // Get current state
    getState() {
        return {
            isFullscreen: this.isFullscreen,
            isImmersiveMode: this.isImmersiveMode,
            webAppAvailable: !!this.webApp
        };
    }

    // Setup gamify features
    setupGamifyFeatures() {
        if (!this.webApp) return;

        // Add haptic feedback
        this.addHapticFeedback();
        
        // Add vibration patterns
        this.addVibrationPatterns();
        
        // Add immersive animations
        this.addImmersiveAnimations();
        
        console.log('Gamify features enabled');
    }

    addHapticFeedback() {
        // Add haptic feedback to interactive elements
        const interactiveElements = document.querySelectorAll('button, .clickable, .interactive');
        
        interactiveElements.forEach(element => {
            element.addEventListener('click', () => {
                if (this.webApp.HapticFeedback) {
                    this.webApp.HapticFeedback.impactOccurred('medium');
                }
            });
        });
    }

    addVibrationPatterns() {
        // Add vibration patterns for different actions
        this.vibrationPatterns = {
            success: [100, 50, 100],
            error: [200, 100, 200],
            warning: [150, 75, 150],
            info: [100, 25, 100]
        };
    }

    triggerVibration(pattern) {
        if (this.webApp.HapticFeedback && this.vibrationPatterns[pattern]) {
            this.webApp.HapticFeedback.notificationOccurred('success');
        }
    }

    addImmersiveAnimations() {
        // Add immersive animations for fullscreen mode
        const style = document.createElement('style');
        style.textContent = `
            .telegram-immersive .app-container {
                animation: slideInFromTop 0.3s ease-out;
            }
            
            .telegram-gamify .package-card {
                transition: transform 0.2s ease, box-shadow 0.2s ease;
            }
            
            .telegram-gamify .package-card:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
            }
            
            @keyframes slideInFromTop {
                from {
                    transform: translateY(-100%);
                    opacity: 0;
                }
                to {
                    transform: translateY(0);
                    opacity: 1;
                }
            }
        `;
        document.head.appendChild(style);
    }
}

// Initialize the fullscreen manager
let telegramFullscreenManager;

// Initialize when DOM is loaded
function initializeTelegramFullscreen() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            telegramFullscreenManager = new TelegramFullscreenManager();
        });
    } else {
        telegramFullscreenManager = new TelegramFullscreenManager();
    }
}

// Initialize immediately
initializeTelegramFullscreen();

// Export for global access
window.TelegramFullscreenManager = TelegramFullscreenManager;
window.telegramFullscreenManager = telegramFullscreenManager;

// Add utility functions to window
window.toggleTelegramFullscreen = () => {
    if (telegramFullscreenManager) {
        telegramFullscreenManager.toggleFullscreen();
    }
};

window.toggleTelegramImmersive = () => {
    if (telegramFullscreenManager) {
        telegramFullscreenManager.toggleImmersiveMode();
    }
};

window.setupTelegramGamify = () => {
    if (telegramFullscreenManager) {
        telegramFullscreenManager.setupGamifyFeatures();
    }
};