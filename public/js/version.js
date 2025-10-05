// Auto-updating version system
// This file automatically updates the app version from package.json

class VersionManager {
    constructor() {
        this.version = '1.0.0'; // Fallback version
        this.buildDate = new Date().toISOString().split('T')[0];
        this.init();
    }

    async init() {
        try {
            // Try to fetch version from server endpoint
            const response = await fetch('/api/version');
            if (response.ok) {
                const data = await response.json();
                this.version = data.version;
                this.buildDate = data.buildDate;
            }
        } catch (error) {
            console.warn('Could not fetch version from server, using fallback');
        }
        
        this.updateVersionDisplay();
    }

    updateVersionDisplay() {
        // Update all elements with data-version attribute
        const versionElements = document.querySelectorAll('[data-version]');
        versionElements.forEach(element => {
            if (element.textContent.includes('v1.0.0')) {
                element.textContent = element.textContent.replace('v1.0.0', `v${this.version}`);
            }
        });

        // Update elements with data-build-date attribute
        const buildDateElements = document.querySelectorAll('[data-build-date]');
        buildDateElements.forEach(element => {
            element.textContent = this.buildDate;
        });
    }

    getVersion() {
        return this.version;
    }

    getBuildDate() {
        return this.buildDate;
    }

    getVersionInfo() {
        return {
            version: this.version,
            buildDate: this.buildDate,
            fullVersion: `v${this.version} (${this.buildDate})`
        };
    }
}

// Initialize version manager when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.versionManager = new VersionManager();
});

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VersionManager;
}