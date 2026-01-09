# User Database Audit

This directory contains tools to audit the User collection for duplicates and data inconsistencies without modifying any data.

## Files

- **audit-users.js** - Node.js script that connects to MongoDB and performs a comprehensive audit
- **generate-audit-queries.js** - Generates MongoDB queries that you can run directly in MongoDB Compass or mongo shell
- **AUDIT_QUERIES.md** - Reference guide with all audit queries

## Quick Start

### Option 1: Run Node Script (Automatic)

If you have MongoDB connection available:

```bash
# Using environment variables (.env)
node audit-users.js

# Or with explicit MongoDB URI
node audit-users.js "mongodb+srv://user:pass@cluster.mongodb.net/starstore"
```

### Option 2: Manual MongoDB Queries

If you prefer to run queries manually in MongoDB Compass or mongo shell:

1. Open MongoDB Compass or mongo shell
2. Select the `starstore` database and `users` collection
3. Copy-paste any query from `AUDIT_QUERIES.md`
4. Run the query

## What Gets Checked

The audit checks for:

1. **Duplicate User IDs** - Should NOT exist (unique index)
2. **Duplicate Usernames** - Might indicate data issues
3. **Null/Missing IDs** - Data integrity issue
4. **Missing Usernames** - Users without username field
5. **Missing createdAt** - Incomplete user records
6. **Time Inconsistencies** - lastActive before createdAt
7. **Duplicate Emails** - If email field is used
8. **Duplicate Wallet Addresses** - If wallet addresses should be unique
9. **User Creation Dates** - Shows user count by date
10. **Database Indexes** - Verifies unique constraints

## Expected Results

After fixing the user detection issues, you should see:

```
✅ DATABASE AUDIT PASSED - No issues found!

AUDIT SUMMARY:
- Duplicate IDs: 0
- Duplicate Usernames: 0
- Users without username: 0
- Data inconsistencies: 0
```

## Understanding Results

### Duplicate IDs (Count > 0)
- **Should be:** 0
- **Problem:** User ID is supposed to be unique
- **Cause:** Data corruption or concurrent insertion errors
- **Action:** Report immediately

### Duplicate Usernames (Count > 0)
- **Should be:** 0
- **Problem:** Same username assigned to multiple users
- **Cause:** Username field not being validated properly
- **Action:** Check which users have duplicate usernames and consolidate

### Duplicate Wallet Addresses (Count > 0)
- **Can be:** Multiple users can share wallets (allowed)
- **Problem:** Only if wallets should be exclusive
- **Action:** Depends on business logic

### Users By Creation Date
- **Shows:** User count grouped by date
- **Use:** Identify bulk insertions or suspicious patterns
- **Example:** Sudden spike on one date = possible bot/spam insertion

## Sample Queries

### Find users with duplicate usernames
```javascript
db.users.aggregate([
    { $match: { username: { $ne: null } } },
    { $group: { _id: "$username", count: { $sum: 1 }, ids: { $push: "$id" } } },
    { $match: { count: { $gt: 1 } } }
])
```

### Find total users
```javascript
db.users.countDocuments({})
```

### Find all indexes
```javascript
db.users.getIndexes()
```

### Show users with specific ID pattern
```javascript
db.users.find({ id: "6653402592" })
```

## Commands Reference

```bash
# Run full audit with environment variables
node audit-users.js

# Run full audit with explicit connection
node audit-users.js "mongodb+srv://username:password@cluster.mongodb.net/starstore"

# Generate queries reference
node generate-audit-queries.js

# View the queries reference
cat AUDIT_QUERIES.md
```

## Troubleshooting

### "connect ECONNREFUSED" Error
- MongoDB is not running or not reachable
- Use explicit connection string with valid credentials
- Check your MongoDB URI in .env or Railway environment

### Queries timeout
- MongoDB server is slow or overloaded
- Increase timeout: add `?serverSelectionTimeoutMS=30000` to URI
- Run during off-peak hours

### Permission denied
- Your MongoDB user doesn't have read permissions on the collection
- Contact your MongoDB admin or check credentials

## Running on Production Server

If running on Railway or cloud deployment:

1. Get the MONGODB_URI from Railway dashboard
2. Run in terminal connected to deployment:
   ```bash
   node audit-users.js "your-mongodb-uri-here"
   ```

## Related Issues

This audit was created to investigate:
- User duplicate detection in `/detect_users` command
- /start command user creation
- E11000 duplicate key errors

See commit: 7ee96d9 (Fix user detection system)
