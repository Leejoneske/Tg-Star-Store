# User Database Audit Queries

Run these MongoDB queries to check for duplicates and data issues.

## 1_TOTAL_USERS
**Description:** Get total number of users in database

```javascript
db.users.countDocuments({})
```

## 2_DUPLICATE_IDS
**Description:** Find duplicate user IDs (shouldn't exist due to unique index)

```javascript
db.users.aggregate([
    { $group: { _id: "$id", count: { $sum: 1 }, docs: { $push: "$$ROOT" } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
])
```

## 3_DUPLICATE_USERNAMES
**Description:** Find duplicate usernames with their corresponding user IDs

```javascript
db.users.aggregate([
    { $match: { username: { $ne: null } } },
    { $group: { _id: "$username", count: { $sum: 1 }, ids: { $push: "$id" } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
])
```

## 4_NULL_IDS
**Description:** Find users with null or missing IDs

```javascript
db.users.find({ id: null })
```

## 5_MISSING_USERNAMES
**Description:** Find users without a username

```javascript
db.users.find({ username: { $in: [null, undefined, ""] } })
```

## 6_MISSING_CREATED_AT
**Description:** Find users without createdAt timestamp

```javascript
db.users.find({ createdAt: null })
```

## 7_TIME_INCONSISTENCIES
**Description:** Find users where lastActive is before createdAt (data inconsistency)

```javascript
db.users.find({ $expr: { $gt: ["$createdAt", "$lastActive"] } })
```

## 8_DUPLICATE_EMAILS
**Description:** Find duplicate emails (if email field exists)

```javascript
db.users.aggregate([
    { $match: { email: { $ne: null } } },
    { $group: { _id: "$email", count: { $sum: 1 }, ids: { $push: "$id" } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
])
```

## 9_USERS_BY_CREATION_DATE
**Description:** Show user count by creation date (helps identify bulk insertions)

```javascript
db.users.aggregate([
    { $group: { 
        _id: { 
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } 
        }, 
        count: { $sum: 1 } 
    } },
    { $sort: { _id: -1 } }
])
```

## 10_LATEST_USERS
**Description:** Show the 10 most recently created users

```javascript
db.users.find().sort({ createdAt: -1 }).limit(10)
```

## 11_USERS_INDEX_INFO
**Description:** Show all indexes on the users collection

```javascript
db.users.getIndexes()
```

## 12_COLLECTION_STATS
**Description:** Get collection statistics

```javascript
db.users.stats()
```

## 13_USERS_DUPLICATE_WALLET
**Description:** Find users with duplicate wallet addresses

```javascript
db.users.aggregate([
    { $match: { walletAddress: { $ne: null } } },
    { $group: { _id: "$walletAddress", count: { $sum: 1 }, ids: { $push: "$id" } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
])
```

