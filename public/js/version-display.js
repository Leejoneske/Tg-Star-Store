// Comprehensive version display component
class VersionDisplay {
    constructor() {
        this.versionInfo = null;
        this.init();
    }

    async init() {
        try {
            // Try to get version from server
            const response = await fetch('/api/version');
            if (response.ok) {
                this.versionInfo = await response.json();
                console.log('Version info loaded from server:', this.versionInfo);
            } else {
                throw new Error('Server response not ok');
            }
        } catch (error) {
            console.warn('Could not fetch version from server, using fallback');
            this.versionInfo = {
                version: '9.1.27',
                buildNumber: 'N/A',
                commitHash: 'production',
                buildDate: new Date().toISOString().split('T')[0],
                branch: 'main',
                displayVersion: 'v9.1.27 (Production)'
            };
        }
        
        this.updateAllDisplays();
    }

    updateAllDisplays() {
        this.updateVersionElements();
    }

    updateVersionElements() {
        try {
            const elements = document.querySelectorAll('[data-version]');
            if (elements.length === 0) {
                console.warn('No version elements found');
                return;
            }
            
            elements.forEach(element => {
                if (element && element.textContent && element.textContent.includes('StarStore')) {
                    element.textContent = `StarStore v${this.versionInfo.version}`;
                }
            });
        } catch (error) {
            console.error('Error updating version elements:', error);
        }
    }


    getVersionInfo() {
        return this.versionInfo;
    }

    getDisplayVersion() {
        return this.versionInfo ? this.versionInfo.displayVersion : 'v9.1.27 (Production)';
    }

    getShortVersion() {
        return this.versionInfo ? `v${this.versionInfo.version}` : 'v9.1.27';
    }

    getBuildInfo() {
        return this.versionInfo ? {
            build: this.versionInfo.buildNumber,
            commit: this.versionInfo.commitHash,
            date: this.versionInfo.buildDate,
            branch: this.versionInfo.branch
        } : null;
    }
}

// Initialize when DOM is loaded
function initializeVersionDisplay() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => {
                window.versionDisplay = new VersionDisplay();
            }, 100);
        });
    } else {
        // DOM is already loaded
        setTimeout(() => {
            window.versionDisplay = new VersionDisplay();
        }, 100);
    }
}

// Initialize immediately
initializeVersionDisplay();

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VersionDisplay;
}