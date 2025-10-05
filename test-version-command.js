#!/usr/bin/env node

// Test script to simulate the version command
const { execSync } = require('child_process');

try {
    console.log('🧪 Testing Version Command...\n');
    
    // Get current version info
    const packageJson = require('./package.json');
    
    // Get git information
    const gitInfo = {
        commitCount: execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim(),
        currentHash: execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(),
        branch: execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(),
        lastCommitDate: execSync('git log -1 --format=%ci', { encoding: 'utf8' }).trim(),
        lastCommitMessage: execSync('git log -1 --format=%s', { encoding: 'utf8' }).trim(),
        lastCommitAuthor: execSync('git log -1 --format=%an', { encoding: 'utf8' }).trim()
    };
    
    // Get recent commits (last 5)
    const recentCommits = execSync('git log -5 --oneline', { encoding: 'utf8' }).trim().split('\n');
    
    // Calculate time since last update
    const lastUpdate = new Date(gitInfo.lastCommitDate);
    const now = new Date();
    const timeDiff = now - lastUpdate;
    const hoursAgo = Math.floor(timeDiff / (1000 * 60 * 60));
    const daysAgo = Math.floor(hoursAgo / 24);
    
    let timeAgo;
    if (daysAgo > 0) {
        timeAgo = `${daysAgo} day${daysAgo > 1 ? 's' : ''} ago`;
    } else if (hoursAgo > 0) {
        timeAgo = `${hoursAgo} hour${hoursAgo > 1 ? 's' : ''} ago`;
    } else {
        const minutesAgo = Math.floor(timeDiff / (1000 * 60));
        timeAgo = `${minutesAgo} minute${minutesAgo > 1 ? 's' : ''} ago`;
    }
    
    console.log('📊 StarStore Version Information\n');
    
    console.log('🔢 Current Version:');
    console.log(`• Version: ${packageJson.version}`);
    console.log(`• Build Number: ${gitInfo.commitCount}`);
    console.log(`• Commit Hash: ${gitInfo.currentHash}`);
    console.log(`• Branch: ${gitInfo.branch}\n`);
    
    console.log('⏰ Last Update:');
    console.log(`• Date: ${gitInfo.lastCommitDate}`);
    console.log(`• Time Ago: ${timeAgo}`);
    console.log(`• Author: ${gitInfo.lastCommitAuthor}`);
    console.log(`• Message: ${gitInfo.lastCommitMessage}\n`);
    
    console.log('📈 Recent Updates:');
    recentCommits.forEach((commit, index) => {
        console.log(`• ${index + 1}. ${commit}`);
    });
    
    console.log('\n🕐 Server Status:');
    console.log(`• Server Time: ${now.toISOString()}`);
    console.log(`• Uptime: ${Math.floor(process.uptime() / 3600)} hours`);
    console.log(`• Memory Usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB\n`);
    
    console.log('📱 App Information:');
    console.log(`• Name: ${packageJson.name}`);
    console.log(`• Description: ${packageJson.description}`);
    console.log(`• Node Version: ${process.version}`);
    
    console.log('\n✅ Version command test completed successfully!');
    
} catch (error) {
    console.error('❌ Error testing version command:', error.message);
    process.exit(1);
}