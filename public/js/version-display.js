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
                version: '3.1.6',
                buildNumber: '2069',
                commitHash: '12de52f',
                buildDate: '2025-10-05',
                branch: 'cursor/debug-daily-page-functionality-046e',
                displayVersion: 'v3.1.6 (Build 2069)'
            };
        }
        
        this.updateAllDisplays();
    }

    updateAllDisplays() {
        this.updateVersionElements();
        this.updateBuildElements();
        this.updateCommitElements();
        this.updateDateElements();
    }

    updateVersionElements() {
        const elements = document.querySelectorAll('[data-version]');
        elements.forEach(element => {
            if (element.textContent.includes('StarStore')) {
                element.textContent = element.textContent.replace(/v[\d\.]+/, `v${this.versionInfo.version}`);
            }
        });
    }

    updateBuildElements() {
        const elements = document.querySelectorAll('[data-build-number]');
        elements.forEach(element => {
            element.textContent = this.versionInfo.buildNumber;
        });
    }

    updateCommitElements() {
        const elements = document.querySelectorAll('[data-commit-hash]');
        elements.forEach(element => {
            element.textContent = this.versionInfo.commitHash;
        });
    }

    updateDateElements() {
        const elements = document.querySelectorAll('[data-build-date]');
        elements.forEach(element => {
            element.textContent = this.versionInfo.buildDate;
        });
    }

    getVersionInfo() {
        return this.versionInfo;
    }

    getDisplayVersion() {
        return this.versionInfo ? this.versionInfo.displayVersion : 'v3.1.6 (Build 2069)';
    }

    getShortVersion() {
        return this.versionInfo ? `v${this.versionInfo.version}` : 'v3.1.6';
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
document.addEventListener('DOMContentLoaded', () => {
    window.versionDisplay = new VersionDisplay();
});

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VersionDisplay;
}