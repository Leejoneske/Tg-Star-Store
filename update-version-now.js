#!/usr/bin/env node

// Manual version update script for immediate deployment
const RailwayVersionGenerator = require('./generate-railway-version.js');

console.log('🔄 Manually updating version...');

const generator = new RailwayVersionGenerator();
const versionInfo = generator.generate();

console.log('\n🎉 Version update complete!');
console.log(`New version: ${versionInfo.displayVersion}`);
console.log(`Build: ${versionInfo.buildNumber}`);
console.log(`Date: ${versionInfo.buildDate}`);

// Also show what the API endpoint will return
console.log('\n📡 API endpoint will return:');
console.log(`  /api/version -> ${versionInfo.displayVersion}`);
console.log(`  Full version: ${versionInfo.fullVersion}`);