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
        this.updateBuildElements();
        this.updateCommitElements();
        this.updateDateElements();
        this.updateBuildInfoElements();
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

    updateBuildInfoElements() {
        const elements = document.querySelectorAll('[data-build-info]');
        elements.forEach(element => {
            const buildNumber = element.querySelector('[data-build-number]');
            const commitHash = element.querySelector('[data-commit-hash]');
            if (buildNumber) buildNumber.textContent = this.versionInfo.buildNumber;
            if (commitHash) commitHash.textContent = this.versionInfo.commitHash;
        });
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
document.addEventListener('DOMContentLoaded', () => {
    window.versionDisplay = new VersionDisplay();
});

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VersionDisplay;
}