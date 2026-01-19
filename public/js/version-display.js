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
                version: '2.1.19',
                buildNumber: 'N/A',
                commitHash: 'production',
                buildDate: new Date().toISOString().split('T')[0],
                branch: 'main',
                displayVersion: 'StarStore v2.1.19'
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
            console.log('Found version elements:', elements.length);
            
            if (elements.length === 0) {
                console.warn('No version elements found');
                // Try to find elements with hardcoded version text
                const allElements = document.querySelectorAll('*');
                const versionElements = Array.from(allElements).filter(el => 
                    el.textContent && el.textContent.includes('StarStore v2.1.19')
                );
                console.log('Found elements with hardcoded version:', versionElements.length);
                versionElements.forEach(el => {
                    el.setAttribute('data-version', '');
                    elements.push(el);
                });
            }
            
            const versionText = this.getDisplayVersion();
            console.log('Updating version to:', versionText);
            
            elements.forEach(element => {
                if (element) {
                    console.log('Updating element:', element.textContent, '->', versionText);
                    element.textContent = versionText;
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
        return this.versionInfo ? this.versionInfo.displayVersion : 'StarStore v2.1.19';
    }

    getShortVersion() {
        return this.versionInfo ? `StarStore v${this.versionInfo.version}` : 'StarStore v2.1.19';
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
    console.log('Initializing version display...');
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => {
                window.versionDisplay = new VersionDisplay();
                console.log('Version display initialized after DOM loaded');
            }, 100);
        });
    } else {
        // DOM is already loaded
        setTimeout(() => {
            window.versionDisplay = new VersionDisplay();
            console.log('Version display initialized immediately');
        }, 100);
    }
}

// Initialize immediately
initializeVersionDisplay();

// Also try to initialize after a delay to catch any missed cases
setTimeout(() => {
    if (!window.versionDisplay) {
        console.log('Version display not found, initializing...');
        window.versionDisplay = new VersionDisplay();
    }
}, 2000);

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VersionDisplay;
}