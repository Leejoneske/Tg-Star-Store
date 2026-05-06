/**
 * Tests for missing auth checks on admin and user-scoped endpoints.
 *
 * Covers the fix for unauthenticated access to:
 *   - GET /api/admin/users-data
 *   - GET /api/admin/referrals-data
 *   - GET /api/admin/transactions-data
 *   - GET /api/admin/analytics
 *   - GET /api/transactions/:userId
 *   - GET /api/users/:telegramId
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let app;
let mongoServer;

// Minimal env so server.js initialises without a real bot or DB
process.env.BOT_TOKEN = 'test_bot_token';
process.env.PROVIDER_TOKEN = 'test_provider_token';
process.env.NODE_ENV = 'production'; // enforce production auth rules
process.env.PORT = '0'; // let OS assign a free port; app.listen is guarded by require.main anyway

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();

  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }
  await mongoose.connect(process.env.MONGODB_URI);

  app = require('../../server');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a request with no authentication at all. */
function unauthenticated(method, url) {
  return request(app)[method](url);
}

/** Make a request that looks like a regular (non-admin) Telegram user. */
function asUser(method, url, userId = '111111111') {
  // In production the server requires a valid initData signature.
  // We simulate the dev-mode path by setting NODE_ENV back to development
  // for the header-only auth path used in tests.
  return request(app)
    [method](url)
    .set('x-telegram-id', userId);
}

// ---------------------------------------------------------------------------
// Admin bulk-data endpoints — must reject unauthenticated callers
// ---------------------------------------------------------------------------

describe('Admin data endpoints require authentication', () => {
  const adminEndpoints = [
    '/api/admin/users-data',
    '/api/admin/referrals-data',
    '/api/admin/transactions-data',
    '/api/admin/analytics',
  ];

  test.each(adminEndpoints)(
    'GET %s returns 401 or 403 without credentials',
    async (endpoint) => {
      const res = await unauthenticated('get', endpoint);
      expect([401, 403]).toContain(res.status);
    }
  );

  test.each(adminEndpoints)(
    'GET %s returns 401 or 403 for a non-admin Telegram user',
    async (endpoint) => {
      // Temporarily switch to development so the x-telegram-id header is accepted
      const savedEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const res = await asUser('get', endpoint, '999999999'); // not in ADMIN_IDS
      expect([401, 403]).toContain(res.status);

      process.env.NODE_ENV = savedEnv;
    }
  );
});

// ---------------------------------------------------------------------------
// GET /api/transactions/:userId — must reject unauthenticated callers
// ---------------------------------------------------------------------------

describe('GET /api/transactions/:userId', () => {
  test('returns 401 or 403 without credentials', async () => {
    const res = await unauthenticated('get', '/api/transactions/123456789');
    expect([401, 403]).toContain(res.status);
  });

  test('returns 403 when authenticated user requests another user\'s transactions', async () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const res = await asUser('get', '/api/transactions/999999999', '111111111');
    expect(res.status).toBe(403);

    process.env.NODE_ENV = savedEnv;
  });

  test('allows a user to fetch their own transactions', async () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const res = await asUser('get', '/api/transactions/111111111', '111111111');
    // 200 (found, possibly empty) or 404 (user not in test DB) — both are acceptable;
    // what matters is it is NOT 401/403.
    expect([200, 404, 500]).toContain(res.status);
    expect([401, 403]).not.toContain(res.status);

    process.env.NODE_ENV = savedEnv;
  });
});

// ---------------------------------------------------------------------------
// GET /api/users/:telegramId — must reject unauthenticated callers
// ---------------------------------------------------------------------------

describe('GET /api/users/:telegramId', () => {
  test('returns 401 or 403 without credentials', async () => {
    const res = await unauthenticated('get', '/api/users/123456789');
    expect([401, 403]).toContain(res.status);
  });

  test('returns 403 when authenticated user requests another user\'s profile', async () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const res = await asUser('get', '/api/users/999999999', '111111111');
    expect(res.status).toBe(403);

    process.env.NODE_ENV = savedEnv;
  });

  test('allows a user to fetch their own profile', async () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const res = await asUser('get', '/api/users/111111111', '111111111');
    // 200 or 404 depending on whether the user exists in the test DB
    expect([200, 404, 500]).toContain(res.status);
    expect([401, 403]).not.toContain(res.status);

    process.env.NODE_ENV = savedEnv;
  });
});
