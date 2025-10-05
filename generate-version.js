#!/usr/bin/env node

// Advanced version generator that uses git history and semantic versioning
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class VersionGenerator {
    constructor() {
        this.packagePath = path.join(__dirname, 'package.json');
        this.versionPath = path.join(__dirname, 'public', 'js', 'version.js');
        this.packageJson = JSON.parse(fs.readFileSync(this.packagePath, 'utf8'));
    }

    getGitInfo() {
        try {
            // Get total commit count
            const commitCount = execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim();
            
            // Get current branch
            const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
            
            // Get latest commit hash (short)
            const commitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
            
            // Get latest commit date
            const commitDate = execSync('git log -1 --format=%ci', { encoding: 'utf8' }).trim();
            
            // Get latest commit message
            const commitMessage = execSync('git log -1 --format=%s', { encoding: 'utf8' }).trim();
            
            return {
                commitCount: parseInt(commitCount),
                branch,
                commitHash,
                commitDate: new Date(commitDate).toISOString().split('T')[0],
                commitMessage
            };
        } catch (error) {
            console.warn('Could not get git info:', error.message);
            return {
                commitCount: 0,
                branch: 'unknown',
                commitHash: 'unknown',
                commitDate: new Date().toISOString().split('T')[0],
                commitMessage: 'Unknown'
            };
        }
    }

    generateVersion() {
        const gitInfo = this.getGitInfo();
        const baseVersion = this.packageJson.version || '1.0.0';
        
        // Parse base version (e.g., "1.0.0" -> [1, 0, 0])
        const [major, minor, patch] = baseVersion.split('.').map(Number);
        
        // Calculate version based on commit count
        // Major version: every 1000 commits
        // Minor version: every 100 commits  
        // Patch version: every 10 commits
        const newMajor = major + Math.floor(gitInfo.commitCount / 1000);
        const newMinor = minor + Math.floor((gitInfo.commitCount % 1000) / 100);
        const newPatch = patch + Math.floor((gitInfo.commitCount % 100) / 10);
        
        const version = `${newMajor}.${newMinor}.${newPatch}`;
        const buildNumber = gitInfo.commitCount;
        
        return {
            version,
            buildNumber,
            commitHash: gitInfo.commitHash,
            commitDate: gitInfo.commitDate,
            branch: gitInfo.branch,
            commitMessage: gitInfo.commitMessage,
            fullVersion: `${version}.${buildNumber}`,
            displayVersion: `v${version} (Build ${buildNumber})`
        };
    }

    updateVersionFiles(versionInfo) {
        // Update package.json
        this.packageJson.version = versionInfo.version;
        fs.writeFileSync(this.packagePath, JSON.stringify(this.packageJson, null, 2));
        console.log(`✅ Updated package.json to version ${versionInfo.version}`);

        // Update version.js
        let versionJs = fs.readFileSync(this.versionPath, 'utf8');
        
        // Update fallback version
        versionJs = versionJs.replace(
            /this\.version = '[^']+';/,
            `this.version = '${versionInfo.version}';`
        );
        
        // Update build date
        versionJs = versionJs.replace(
            /this\.buildDate = '[^']+';/,
            `this.buildDate = '${versionInfo.commitDate}';`
        );
        
        // Add build number and commit info
        if (!versionJs.includes('this.buildNumber')) {
            versionJs = versionJs.replace(
                /this\.buildDate = '[^']+';/,
                `this.buildDate = '${versionInfo.commitDate}';\n        this.buildNumber = ${versionInfo.buildNumber};\n        this.commitHash = '${versionInfo.commitHash}';`
            );
        } else {
            versionJs = versionJs.replace(
                /this\.buildNumber = \d+;/,
                `this.buildNumber = ${versionInfo.buildNumber};`
            );
            versionJs = versionJs.replace(
                /this\.commitHash = '[^']+';/,
                `this.commitHash = '${versionInfo.commitHash}';`
            );
        }
        
        fs.writeFileSync(this.versionPath, versionJs);
        console.log(`✅ Updated version.js with version ${versionInfo.version}`);
    }

    generate() {
        console.log('🚀 Generating version from git history...');
        
        const versionInfo = this.generateVersion();
        
        console.log('\n📊 Version Information:');
        console.log(`   Version: ${versionInfo.version}`);
        console.log(`   Build Number: ${versionInfo.buildNumber}`);
        console.log(`   Commit Hash: ${versionInfo.commitHash}`);
        console.log(`   Commit Date: ${versionInfo.commitDate}`);
        console.log(`   Branch: ${versionInfo.branch}`);
        console.log(`   Latest Commit: ${versionInfo.commitMessage}`);
        console.log(`   Display: ${versionInfo.displayVersion}`);
        
        this.updateVersionFiles(versionInfo);
        
        console.log('\n✅ Version generation complete!');
        return versionInfo;
    }
}

// Run the version generator
const generator = new VersionGenerator();
generator.generate();