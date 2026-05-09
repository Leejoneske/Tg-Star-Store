## 2025-05-15 - [Database Indexing and Geolocation Optimization]
**Learning:** Found multiple Mongoose schemas missing critical indexes on fields used in frequent queries (e.g., `telegramId`, `userId`, `referrerUserId`). Also noticed redundant geolocation lookups in some API endpoints where the data was already available.
**Action:** Always check schema definitions for missing indexes on foreign keys and frequently queried fields. Ensure geolocation data is passed between functions when already fetched to avoid redundant API/cache calls.
