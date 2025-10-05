// Auto-updating version system
// This file automatically updates the app version from package.json

class VersionManager {
    constructor() {
        this.version = '3.1.6'; // Fallback version - should match package.json (1.1.0)
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
                console.log('Version loaded from server:', this.version);
            } else {
                console.warn('Server returned error, using fallback version');
            }
        } catch (error) {
            console.warn('Could not fetch version from server, using fallback:', error.message);
        }
        
        this.updateVersionDisplay();
    }

    updateVersionDisplay() {
        console.log('Updating version display:', this.version);
        
        // Update all elements with data-version attribute
        const versionElements = document.querySelectorAll('[data-version]');
        console.log('Found version elements:', versionElements.length);
        
        versionElements.forEach(element => {
            const originalText = element.textContent;
            if (originalText.includes('v1.0.0') || originalText.includes('v1.1.0')) {
                element.textContent = originalText.replace(/v[\d\.]+/, `v${this.version}`);
                console.log('Updated version element:', originalText, '->', element.textContent);
            } else if (originalText.includes('StarStore')) {
                // Handle case where version might already be updated
                element.textContent = originalText.replace(/v[\d\.]+/, `v${this.version}`);
                console.log('Updated existing version element:', originalText, '->', element.textContent);
            }
        });

        // Update elements with data-build-date attribute
        const buildDateElements = document.querySelectorAll('[data-build-date]');
        console.log('Found build date elements:', buildDateElements.length);
        
        buildDateElements.forEach(element => {
            element.textContent = this.buildDate;
            console.log('Updated build date element:', element.textContent);
        });

        // Update elements with data-build-number attribute
        const buildNumberElements = document.querySelectorAll('[data-build-number]');
        console.log('Found build number elements:', buildNumberElements.length);
        
        buildNumberElements.forEach(element => {
            element.textContent = this.buildNumber || 'Unknown';
            console.log('Updated build number element:', element.textContent);
        });

        // Update elements with data-commit-hash attribute
        const commitHashElements = document.querySelectorAll('[data-commit-hash]');
        console.log('Found commit hash elements:', commitHashElements.length);
        
        commitHashElements.forEach(element => {
            element.textContent = this.commitHash || 'Unknown';
            console.log('Updated commit hash element:', element.textContent);
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

    // Method to manually set version (for development)
    setVersion(version) {
        this.version = version;
        this.updateVersionDisplay();
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