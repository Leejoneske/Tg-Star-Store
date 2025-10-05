#!/usr/bin/env node

// Simple script to update version in version.js to match package.json
const fs = require('fs');
const path = require('path');

try {
    // Read package.json
    const packagePath = path.join(__dirname, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const version = packageJson.version;

    // Read version.js
    const versionPath = path.join(__dirname, 'public', 'js', 'version.js');
    let versionJs = fs.readFileSync(versionPath, 'utf8');

    // Update the fallback version
    const versionRegex = /this\.version = '[^']+';/;
    const newVersionLine = `this.version = '${version}';`;
    
    if (versionRegex.test(versionJs)) {
        versionJs = versionJs.replace(versionRegex, newVersionLine);
        fs.writeFileSync(versionPath, versionJs);
        console.log(`✅ Updated version.js fallback version to ${version}`);
    } else {
        console.log('❌ Could not find version line to update');
    }

    // Also update the comment
    const commentRegex = /\/\/ Fallback version - should match package\.json/;
    if (commentRegex.test(versionJs)) {
        versionJs = versionJs.replace(commentRegex, `// Fallback version - should match package.json (${version})`);
        fs.writeFileSync(versionPath, versionJs);
    }

} catch (error) {
    console.error('❌ Error updating version:', error.message);
    process.exit(1);
}