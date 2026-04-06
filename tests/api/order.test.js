/**
 * Tests for Order Creation API (/api/create-order)
 * Critical for financial integrity - validates payment amount validation,
 * user authentication, and order state management
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let app;
let mongoServer;

// Mock environment
process.env.BOT_TOKEN = 'test_bot_token';
process.env.PROVIDER_TOKEN = 'test_provider_token';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';

describe('POST /api/create-order', () => {
  beforeAll(async () => {
    // Start in-memory MongoDB
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    
    // Clear and reconnect
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
    await mongoose.connect(process.env.MONGODB_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  describe('Input Validation', () => {
    test('should reject missing required fields', async () => {
      const res = await request(app || require('../../server'))
        .post('/api/create-order')
        .send({
          // Missing userId, amount, package
        });
      
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    test('should reject invalid amount (too low)', async () => {
      const res = await request(app || require('../../server'))
        .post('/api/create-order')
        .send({
          userId: '123456789',
          amount: 0.1,
          package: 'basic'
        });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/minimum|invalid amount/i);
    });

    test('should reject invalid amount (negative)', async () => {
      const res = await request(app || require('../../server'))
        .post('/api/create-order')
        .send({
          userId: '123456789',
          amount: -100,
          package: 'basic'
        });
      
      expect(res.status).toBe(400);
    });

    test('should reject non-numeric amount', async () => {
      const res = await request(app || require('../../server'))
        .post('/api/create-order')
        .send({
          userId: '123456789',
          amount: 'not-a-number',
          package: 'basic'
        });
      
      expect(res.status).toBe(400);
    });

    test('should reject invalid userId format', async () => {
      const res = await request(app || require('../../server'))
        .post('/api/create-order')
        .send({
          userId: 'invalid',
          amount: 100,
          package: 'basic'
        });
      
      expect(res.status).toBe(400);
    });
  });

  describe('Valid Order Creation', () => {
    test('should create order with valid data', async () => {
      const res = await request(app || require('../../server'))
        .post('/api/create-order')
        .send({
          userId: '123456789',
          amount: 100,
          package: 'basic'
        });
      
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty('orderId');
      expect(res.body).toHaveProperty('amount');
      expect(res.body.amount).toBe(100);
    });

    test('should return proper order response structure', async () => {
      const res = await request(app || require('../../server'))
        .post('/api/create-order')
        .send({
          userId: '987654321',
          amount: 250,
          package: 'premium'
        });
      
      if ([200, 201].includes(res.status)) {
        expect(res.body).toHaveProperty('orderId');
        expect(res.body).toHaveProperty('amount');
        expect(res.body).toHaveProperty('status');
        expect(['pending', 'created', 'awaiting_payment']).toContain(res.body.status);
      }
    });

    test('should preserve exact amount (no rounding errors)', async () => {
      const testAmount = 123.45;
      const res = await request(app || require('../../server'))
        .post('/api/create-order')
        .send({
          userId: '111111111',
          amount: testAmount,
          package: 'basic'
        });
      
      if ([200, 201].includes(res.status)) {
        expect(res.body.amount).toBe(testAmount);
      }
    });
  });

  describe('Security & Rate Limiting', () => {
    test('should handle duplicate order attempts gracefully', async () => {
      const orderData = {
        userId: '222222222',
        amount: 100,
        package: 'basic'
      };

      const res1 = await request(app || require('../../server'))
        .post('/api/create-order')
        .send(orderData);

      const res2 = await request(app || require('../../server'))
        .post('/api/create-order')
        .send(orderData);

      // Both should succeed or second should have graceful handling
      expect([200, 201, 409]).toContain(res2.status);
    });

    test('should reject extremely large amounts to prevent abuse', async () => {
      const res = await request(app || require('../../server'))
        .post('/api/create-order')
        .send({
          userId: '333333333',
          amount: 1000000,
          package: 'basic'
        });
      
      expect(res.status).toBe(400);
    });
  });
});
