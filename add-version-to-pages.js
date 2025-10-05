#!/usr/bin/env node

// Script to add version information to all HTML pages
const fs = require('fs');
const path = require('path');

const pages = [
    'daily.html',
    'referral.html', 
    'history.html',
    'index.html'
];

const versionScript = `
    <script src="js/version-display.js"></script>
    <script>
        // Auto-update version display
        setTimeout(() => {
            if (window.versionDisplay) {
                console.log('Version:', window.versionDisplay.getDisplayVersion());
            }
        }, 1000);
    </script>`;

pages.forEach(page => {
    const pagePath = path.join(__dirname, 'public', page);
    
    if (fs.existsSync(pagePath)) {
        let content = fs.readFileSync(pagePath, 'utf8');
        
        // Check if version-display.js is already included
        if (!content.includes('version-display.js')) {
            // Find the last script tag before closing head or body
            const scriptRegex = /(<script[^>]*>[\s\S]*?<\/script>)/g;
            const scripts = content.match(scriptRegex);
            
            if (scripts && scripts.length > 0) {
                const lastScript = scripts[scripts.length - 1];
                content = content.replace(lastScript, lastScript + versionScript);
                fs.writeFileSync(pagePath, content);
                console.log(`✅ Added version display to ${page}`);
            } else {
                console.log(`⚠️  No script tags found in ${page}`);
            }
        } else {
            console.log(`ℹ️  Version display already exists in ${page}`);
        }
    } else {
        console.log(`❌ Page not found: ${page}`);
    }
});

console.log('\n🎉 Version display setup complete!');