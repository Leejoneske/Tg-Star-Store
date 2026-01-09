#!/usr/bin/env node

/**
 * MongoDB User Audit Queries
 * Run these queries directly in MongoDB/Compass to check for duplicates
 * Usage: node generate-audit-queries.js
 */

const fs = require('fs');
const path = require('path');

const auditQueries = {
    "1_TOTAL_USERS": {
        description: "Get total number of users in database",
        query: 'db.users.countDocuments({})'
    },
    "2_DUPLICATE_IDS": {
        description: "Find duplicate user IDs (shouldn't exist due to unique index)",
        query: `db.users.aggregate([
    { $group: { _id: "$id", count: { $sum: 1 }, docs: { $push: "$$ROOT" } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
])`
    },
    "3_DUPLICATE_USERNAMES": {
        description: "Find duplicate usernames with their corresponding user IDs",
        query: `db.users.aggregate([
    { $match: { username: { $ne: null } } },
    { $group: { _id: "$username", count: { $sum: 1 }, ids: { $push: "$id" } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
])`
    },
    "4_NULL_IDS": {
        description: "Find users with null or missing IDs",
        query: 'db.users.find({ id: null })'
    },
    "5_MISSING_USERNAMES": {
        description: "Find users without a username",
        query: 'db.users.find({ username: { $in: [null, undefined, ""] } })'
    },
    "6_MISSING_CREATED_AT": {
        description: "Find users without createdAt timestamp",
        query: 'db.users.find({ createdAt: null })'
    },
    "7_TIME_INCONSISTENCIES": {
        description: "Find users where lastActive is before createdAt (data inconsistency)",
        query: 'db.users.find({ $expr: { $gt: ["$createdAt", "$lastActive"] } })'
    },
    "8_DUPLICATE_EMAILS": {
        description: "Find duplicate emails (if email field exists)",
        query: `db.users.aggregate([
    { $match: { email: { $ne: null } } },
    { $group: { _id: "$email", count: { $sum: 1 }, ids: { $push: "$id" } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
])`
    },
    "9_USERS_BY_CREATION_DATE": {
        description: "Show user count by creation date (helps identify bulk insertions)",
        query: `db.users.aggregate([
    { $group: { 
        _id: { 
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } 
        }, 
        count: { $sum: 1 } 
    } },
    { $sort: { _id: -1 } }
])`
    },
    "10_LATEST_USERS": {
        description: "Show the 10 most recently created users",
        query: 'db.users.find().sort({ createdAt: -1 }).limit(10)'
    },
    "11_USERS_INDEX_INFO": {
        description: "Show all indexes on the users collection",
        query: 'db.users.getIndexes()'
    },
    "12_COLLECTION_STATS": {
        description: "Get collection statistics",
        query: 'db.users.stats()'
    },
    "13_USERS_DUPLICATE_WALLET": {
        description: "Find users with duplicate wallet addresses",
        query: `db.users.aggregate([
    { $match: { walletAddress: { $ne: null } } },
    { $group: { _id: "$walletAddress", count: { $sum: 1 }, ids: { $push: "$id" } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
])`
    }
};

console.log('📋 MongoDB User Audit Queries\n');
console.log('═══════════════════════════════════════════════════════════\n');
console.log('Run these queries in MongoDB Compass or mongo shell:\n');

Object.entries(auditQueries).forEach(([key, query]) => {
    console.log(`\n${key}`);
    console.log('─'.repeat(60));
    console.log(`Description: ${query.description}`);
    console.log(`\nQuery:\n${query.query}\n`);
});

// Also generate a file with just the queries
const queriesFile = path.join(__dirname, 'AUDIT_QUERIES.md');
let markdown = '# User Database Audit Queries\n\n';
markdown += 'Run these MongoDB queries to check for duplicates and data issues.\n\n';

Object.entries(auditQueries).forEach(([key, query]) => {
    markdown += `## ${key}\n`;
    markdown += `**Description:** ${query.description}\n\n`;
    markdown += '```javascript\n';
    markdown += query.query;
    markdown += '\n```\n\n';
});

fs.writeFileSync(queriesFile, markdown);
console.log(`\n✅ Queries also saved to: AUDIT_QUERIES.md`);
