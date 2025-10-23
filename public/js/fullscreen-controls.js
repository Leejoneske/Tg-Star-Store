// Fullscreen Control Panel
class FullscreenControlPanel {
    constructor() {
        this.panel = null;
        this.isVisible = false;
        this.init();
    }

    init() {
        this.createPanel();
        this.setupEventListeners();
        console.log('Fullscreen Control Panel initialized');
    }

    createPanel() {
        // Create control panel HTML
        this.panel = document.createElement('div');
        this.panel.id = 'fullscreen-control-panel';
        this.panel.className = 'fullscreen-control-panel';
        this.panel.innerHTML = `
            <div class="control-panel-header">
                <h3>Fullscreen Controls</h3>
                <button class="close-panel" onclick="fullscreenControlPanel.hide()">×</button>
            </div>
            <div class="control-panel-content">
                <div class="control-group">
                    <label class="control-label">
                        <input type="checkbox" id="fullscreen-toggle" checked>
                        <span class="control-text">Fullscreen Mode</span>
                    </label>
                </div>
                <div class="control-group">
                    <label class="control-label">
                        <input type="checkbox" id="immersive-toggle">
                        <span class="control-text">Immersive Mode</span>
                    </label>
                </div>
                <div class="control-group">
                    <label class="control-label">
                        <input type="checkbox" id="gamify-toggle">
                        <span class="control-text">Gamify Features</span>
                    </label>
                </div>
                <div class="control-group">
                    <label class="control-label">
                        <input type="checkbox" id="haptic-toggle">
                        <span class="control-text">Haptic Feedback</span>
                    </label>
                </div>
                <div class="control-group">
                    <label class="control-label">
                        <input type="checkbox" id="vibration-toggle">
                        <span class="control-text">Vibration</span>
                    </label>
                </div>
                <div class="control-actions">
                    <button class="control-btn primary" onclick="fullscreenControlPanel.applySettings()">
                        Apply Settings
                    </button>
                    <button class="control-btn secondary" onclick="fullscreenControlPanel.resetSettings()">
                        Reset
                    </button>
                </div>
                <div class="control-info">
                    <p><strong>Fullscreen:</strong> Expands app to full viewport</p>
                    <p><strong>Immersive:</strong> Hides header for maximum screen usage</p>
                    <p><strong>Gamify:</strong> Adds animations and interactive effects</p>
                </div>
            </div>
        `;

        // Add styles
        const style = document.createElement('style');
        style.textContent = `
            .fullscreen-control-panel {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 320px;
                max-width: 90vw;
                background: var(--surface);
                border: 1px solid var(--border);
                border-radius: 12px;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
                z-index: 10000;
                display: none;
                font-family: 'Inter', sans-serif;
            }

            .fullscreen-control-panel.show {
                display: block;
                animation: slideInScale 0.3s ease-out;
            }

            .control-panel-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 16px 20px;
                border-bottom: 1px solid var(--border);
            }

            .control-panel-header h3 {
                margin: 0;
                font-size: 18px;
                font-weight: 600;
                color: var(--text);
            }

            .close-panel {
                background: none;
                border: none;
                font-size: 24px;
                color: var(--text-muted);
                cursor: pointer;
                padding: 0;
                width: 30px;
                height: 30px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                transition: all 0.2s ease;
            }

            .close-panel:hover {
                background: var(--surface-elevated);
                color: var(--text);
            }

            .control-panel-content {
                padding: 20px;
            }

            .control-group {
                margin-bottom: 16px;
            }

            .control-label {
                display: flex;
                align-items: center;
                cursor: pointer;
                user-select: none;
            }

            .control-label input[type="checkbox"] {
                margin-right: 12px;
                width: 18px;
                height: 18px;
                accent-color: var(--brand);
            }

            .control-text {
                font-size: 14px;
                color: var(--text);
                font-weight: 500;
            }

            .control-actions {
                display: flex;
                gap: 12px;
                margin-top: 24px;
            }

            .control-btn {
                flex: 1;
                padding: 12px 16px;
                border: none;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
            }

            .control-btn.primary {
                background: var(--brand);
                color: white;
            }

            .control-btn.primary:hover {
                background: var(--brand-hover);
                transform: translateY(-1px);
            }

            .control-btn.secondary {
                background: var(--surface-elevated);
                color: var(--text);
                border: 1px solid var(--border);
            }

            .control-btn.secondary:hover {
                background: var(--surface);
                transform: translateY(-1px);
            }

            .control-info {
                margin-top: 20px;
                padding: 16px;
                background: var(--surface-elevated);
                border-radius: 8px;
                border: 1px solid var(--border);
            }

            .control-info p {
                margin: 0 0 8px 0;
                font-size: 12px;
                color: var(--text-muted);
                line-height: 1.4;
            }

            .control-info p:last-child {
                margin-bottom: 0;
            }

            .control-info strong {
                color: var(--text);
            }

            @keyframes slideInScale {
                from {
                    transform: translate(-50%, -50%) scale(0.9);
                    opacity: 0;
                }
                to {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }
            }

            /* Dark theme adjustments */
            [data-theme="dark"] .fullscreen-control-panel {
                background: var(--surface);
                border-color: var(--border);
            }

            [data-theme="dark"] .control-panel-header {
                border-bottom-color: var(--border);
            }

            [data-theme="dark"] .control-info {
                background: var(--background);
                border-color: var(--border);
            }
        `;

        document.head.appendChild(style);
        document.body.appendChild(this.panel);
    }

    setupEventListeners() {
        // Listen for keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + Shift + F to toggle panel
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
                e.preventDefault();
                this.toggle();
            }
        });

        // Listen for settings changes
        const checkboxes = this.panel.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                this.handleSettingChange(checkbox.id);
            });
        });
    }

    show() {
        this.panel.classList.add('show');
        this.isVisible = true;
        this.loadSettings();
    }

    hide() {
        this.panel.classList.remove('show');
        this.isVisible = false;
    }

    toggle() {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    loadSettings() {
        // Load settings from localStorage
        const settings = JSON.parse(localStorage.getItem('fullscreenSettings') || '{}');
        
        document.getElementById('fullscreen-toggle').checked = settings.fullscreen !== false;
        document.getElementById('immersive-toggle').checked = settings.immersive === true;
        document.getElementById('gamify-toggle').checked = settings.gamify === true;
        document.getElementById('haptic-toggle').checked = settings.haptic === true;
        document.getElementById('vibration-toggle').checked = settings.vibration === true;
    }

    saveSettings() {
        const settings = {
            fullscreen: document.getElementById('fullscreen-toggle').checked,
            immersive: document.getElementById('immersive-toggle').checked,
            gamify: document.getElementById('gamify-toggle').checked,
            haptic: document.getElementById('haptic-toggle').checked,
            vibration: document.getElementById('vibration-toggle').checked
        };

        localStorage.setItem('fullscreenSettings', JSON.stringify(settings));
        console.log('Fullscreen settings saved:', settings);
    }

    handleSettingChange(settingId) {
        const isChecked = document.getElementById(settingId).checked;
        console.log(`Setting ${settingId} changed to:`, isChecked);

        // Apply setting immediately
        switch (settingId) {
            case 'fullscreen-toggle':
                if (window.telegramFullscreenManager) {
                    if (isChecked) {
                        window.telegramFullscreenManager.enableFullscreen();
                    } else {
                        window.telegramFullscreenManager.disableFullscreen();
                    }
                }
                break;
            case 'immersive-toggle':
                if (window.telegramFullscreenManager) {
                    if (isChecked) {
                        window.telegramFullscreenManager.enableImmersiveMode();
                    } else {
                        window.telegramFullscreenManager.disableImmersiveMode();
                    }
                }
                break;
            case 'gamify-toggle':
                if (window.telegramFullscreenManager) {
                    if (isChecked) {
                        window.telegramFullscreenManager.setupGamifyFeatures();
                    }
                }
                break;
        }

        this.saveSettings();
    }

    applySettings() {
        this.saveSettings();
        this.hide();
        
        // Show confirmation
        if (window.Swal) {
            Swal.fire({
                title: 'Settings Applied',
                text: 'Fullscreen settings have been applied successfully!',
                icon: 'success',
                timer: 2000,
                showConfirmButton: false
            });
        }
    }

    resetSettings() {
        // Reset to defaults
        document.getElementById('fullscreen-toggle').checked = true;
        document.getElementById('immersive-toggle').checked = false;
        document.getElementById('gamify-toggle').checked = false;
        document.getElementById('haptic-toggle').checked = false;
        document.getElementById('vibration-toggle').checked = false;

        // Clear localStorage
        localStorage.removeItem('fullscreenSettings');

        // Apply reset settings
        this.handleSettingChange('fullscreen-toggle');
        this.handleSettingChange('immersive-toggle');
        this.handleSettingChange('gamify-toggle');

        console.log('Settings reset to defaults');
    }
}

// Initialize control panel
let fullscreenControlPanel;

// Initialize when DOM is loaded
function initializeFullscreenControlPanel() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            fullscreenControlPanel = new FullscreenControlPanel();
        });
    } else {
        fullscreenControlPanel = new FullscreenControlPanel();
    }
}

// Initialize immediately
initializeFullscreenControlPanel();

// Export for global access
window.FullscreenControlPanel = FullscreenControlPanel;
window.fullscreenControlPanel = fullscreenControlPanel;

// Add utility functions
window.showFullscreenControls = () => {
    if (fullscreenControlPanel) {
        fullscreenControlPanel.show();
    }
};

window.hideFullscreenControls = () => {
    if (fullscreenControlPanel) {
        fullscreenControlPanel.hide();
    }
};

window.toggleFullscreenControls = () => {
    if (fullscreenControlPanel) {
        fullscreenControlPanel.toggle();
    }
};