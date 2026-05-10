#!/usr/bin/env node

// Railway-compatible version generator
// Works with Railway's deployment environment and limited git history
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class RailwayVersionGenerator {
    constructor() {
        this.packagePath = path.join(__dirname, '..', 'package.json');
        this.versionPath = path.join(__dirname, '..', 'public', 'js', 'version.js');
        this.versionDisplayPath = path.join(__dirname, '..', 'public', 'js', 'version-display.js');
        this.packageJson = JSON.parse(fs.readFileSync(this.packagePath, 'utf8'));
    }

    getDeploymentInfo() {
        try {
            const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID || 'local';
            const environment = process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || 'development';
            const serviceName = process.env.RAILWAY_SERVICE_NAME || 'starstore';
            const deployTime = new Date().toISOString();
            
            // Try to get git info if available (with timeout to prevent hangs)
            let gitInfo = {
                commitHash: 'unknown',
                branch: 'main',
                commitDate: new Date().toISOString().split('T')[0]
            };

            try {
                // Use timeout: 2 seconds max for git commands to prevent deployment hangs
                gitInfo.commitHash = execSync('git rev-parse --short HEAD', { 
                    encoding: 'utf8', 
                    stdio: ['pipe', 'pipe', 'pipe'],
                    timeout: 2000  // 2 second timeout
                }).trim();
                gitInfo.branch = execSync('git rev-parse --abbrev-ref HEAD', { 
                    encoding: 'utf8', 
                    stdio: ['pipe', 'pipe', 'pipe'],
                    timeout: 2000
                }).trim();
                const commitDate = execSync('git log -1 --format=%ci', { 
                    encoding: 'utf8', 
                    stdio: ['pipe', 'pipe', 'pipe'],
                    timeout: 2000
                }).trim();
                gitInfo.commitDate = new Date(commitDate).toISOString().split('T')[0];
            } catch (gitError) {
                // Silently use defaults (git not available in Docker environments or timed out)
            }

            return {
                deploymentId: deploymentId.substring(0, 8), // Short deployment ID
                environment,
                serviceName,
                deployTime,
                buildDate: new Date().toISOString().split('T')[0],
                ...gitInfo
            };
        } catch (error) {
            console.warn('Could not get deployment info:', error.message);
            return {
                deploymentId: 'unknown',
                environment: 'production',
                serviceName: 'starstore',
                deployTime: new Date().toISOString(),
                buildDate: new Date().toISOString().split('T')[0],
                commitHash: 'unknown',
                branch: 'main',
                commitDate: new Date().toISOString().split('T')[0]
            };
        }
    }

    generateVersion() {
        const deployInfo = this.getDeploymentInfo();
        const baseVersion = this.packageJson.version || '1.0.0';
        
        // Generate version based on current date and deployment
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        
        // Create a more dynamic version system
        // Format: MAJOR.MINOR.PATCH where:
        // MAJOR = year - 2024 (so 2025 = 1, 2026 = 2, etc.)
        // MINOR = month (1-12)  
        // PATCH = day (1-31)
        const major = Math.max(1, year - 2024);
        const minor = month;
        const patch = day;
        
        const version = `${major}.${minor}.${patch}`;
        const buildNumber = deployInfo.deploymentId;
        
        return {
            version,
            buildNumber,
            commitHash: deployInfo.commitHash,
            commitDate: deployInfo.commitDate,
            branch: deployInfo.branch,
            environment: deployInfo.environment,
            deployTime: deployInfo.deployTime,
            buildDate: deployInfo.buildDate,
            fullVersion: `${version}-${buildNumber}`,
            displayVersion: `StarStore v${version}`,
            shortVersion: version
        };
    }

    updatePackageJson(versionInfo) {
        this.packageJson.version = versionInfo.version;
        fs.writeFileSync(this.packagePath, JSON.stringify(this.packageJson, null, 2));
        console.log(`✅ Updated package.json to version ${versionInfo.version}`);
    }

    updateVersionJs(versionInfo) {
        if (!fs.existsSync(this.versionPath)) {
            console.warn('version.js not found, skipping update');
            return;
        }

        let versionJs = fs.readFileSync(this.versionPath, 'utf8');
        
        // Update fallback version
        versionJs = versionJs.replace(
            /this\.version = '[^']+';/,
            `this.version = '${versionInfo.version}';`
        );
        
        // Update build date
        versionJs = versionJs.replace(
            /this\.buildDate = new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\];/,
            `this.buildDate = '${versionInfo.buildDate}';`
        );

        // Update comment with new version
        versionJs = versionJs.replace(
            /\/\/ Fallback version - should match package\.json.*$/m,
            `// Fallback version - should match package.json (${versionInfo.version})`
        );
        
        fs.writeFileSync(this.versionPath, versionJs);
        console.log(`✅ Updated version.js with version ${versionInfo.version}`);
    }

    updateVersionDisplayJs(versionInfo) {
        if (!fs.existsSync(this.versionDisplayPath)) {
            console.warn('version-display.js not found, skipping update');
            return;
        }

        let versionDisplayJs = fs.readFileSync(this.versionDisplayPath, 'utf8');
        
        // Update fallback version in version-display.js
        versionDisplayJs = versionDisplayJs.replace(
            /version: '[^']+'/g,
            `version: '${versionInfo.version}'`
        );

        versionDisplayJs = versionDisplayJs.replace(
            /StarStore v[\d\.]+/g,
            `StarStore v${versionInfo.version}`
        );
        
        fs.writeFileSync(this.versionDisplayPath, versionDisplayJs);
        console.log(`✅ Updated version-display.js with version ${versionInfo.version}`);
    }

    updateHtmlFiles(versionInfo) {
        // OPTIMIZATION: Skip HTML file updates to avoid slow regex on large files during deployment
        // Version info is primarily displayed via version.js and version-display.js which are much smaller
        // HTML version strings are rarely loaded from the git repository (usually served from dist)
        console.log(`ℹ️  Skipping HTML file updates (version.js/version-display.js are sufficient)`);
    }

    generate() {
        console.log('🚀 Generating version for Railway deployment...');
        
        const versionInfo = this.generateVersion();
        
        console.log('\n📊 Version Information:');
        console.log(`   Version: ${versionInfo.version}`);
        console.log(`   Build Number: ${versionInfo.buildNumber}`);
        console.log(`   Commit Hash: ${versionInfo.commitHash}`);
        console.log(`   Build Date: ${versionInfo.buildDate}`);
        console.log(`   Branch: ${versionInfo.branch}`);
        console.log(`   Environment: ${versionInfo.environment}`);
        console.log(`   Display: ${versionInfo.displayVersion}`);
        
        // Update all files
        this.updatePackageJson(versionInfo);
        this.updateVersionJs(versionInfo);
        this.updateVersionDisplayJs(versionInfo);
        this.updateHtmlFiles(versionInfo);
        
        console.log('\n✅ Railway version generation complete!');
        return versionInfo;
    }
}

// Only run if called directly (not when required)
if (require.main === module) {
    const generator = new RailwayVersionGenerator();
    generator.generate();
}

module.exports = RailwayVersionGenerator;