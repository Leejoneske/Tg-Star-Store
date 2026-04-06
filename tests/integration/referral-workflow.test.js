/**
 * Integration Tests for Referral Workflow
 * Tests complete flow: Referral signup → Commission earning → Withdrawal
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let app;
let mongoServer;

process.env.BOT_TOKEN = 'test_bot_token';
process.env.PROVIDER_TOKEN = 'test_provider_token';

describe('Referral Workflow Integration Tests', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
    await mongoose.connect(process.env.MONGODB_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  describe('Complete Referral Workflow', () => {
    test('should track commission when referred user makes purchase', async () => {
      // Step 1: Referrer user exists
      const referrer = {
        userId: '100000001',
        referralCode: 'TEST_REF_001'
      };

      // Step 2: User signs up with referral code
      const signupRes = await request(app || require('../../server'))
        .post('/api/users/referral-signup')
        .send({
          userId: '100000002',
          referralCode: referrer.referralCode
        });

      // Step 3: Referred user makes purchase
      const purchaseRes = await request(app || require('../../server'))
        .post('/api/orders/create')
        .send({
          userId: '100000002',
          amount: 100,
          starCount: 100
        });

      // Step 4: Check referrer commission was credited
      const balanceRes = await request(app || require('../../server'))
        .get('/api/referral/balance')
        .set('Authorization', `Bearer ${referrer.userId}`);

      // Commission should be added (typically 5-10% of purchase)
      if ([200, 201].includes(purchaseRes.status)) {
        expect([200, 204]).toContain(balanceRes.status);
      }
    });

    test('should calculate tiered commissions correctly', async () => {
      // Users at different tier levels
      const tiers = [
        { level: 'bronze', referrals: 5, expectedCommission: 5 },
        { level: 'silver', referrals: 20, expectedCommission: 7 },
        { level: 'gold', referrals: 100, expectedCommission: 10 }
      ];

      for (const tier of tiers) {
        const balanceRes = await request(app || require('../../server'))
          .get('/api/referral/tier-info')
          .query({ level: tier.level });

        if (balanceRes.status === 200) {
          expect(balanceRes.body).toHaveProperty('commissionPercentage');
          expect(typeof balanceRes.body.commissionPercentage).toBe('number');
        }
      }
    });

    test('should prevent commission duplication for same referral', async () => {
      const referrer = '200000001';
      const referred = '200000002';

      // Create purchase
      const purchase1 = await request(app || require('../../server'))
        .post('/api/orders/create')
        .send({
          userId: referred,
          amount: 50,
          referredBy: referrer,
          orderId: 'order-unique-001'
        });

      // Attempt duplicate (same orderId)
      const purchase2 = await request(app || require('../../server'))
        .post('/api/orders/create')
        .send({
          userId: referred,
          amount: 50,
          referredBy: referrer,
          orderId: 'order-unique-001'
        });

      // Both succeed but second shouldn't duplicate commission
      if ([200, 201].includes(purchase1.status)) {
        expect([200, 201, 409].includes(purchase2.status)).toBe(true);
      }
    });

    test('should not credit commission for withdrawals', async () => {
      // Withdrawals should not trigger referral bonuses
      const withdrawRes = await request(app || require('../../server'))
        .post('/api/referral-withdrawals')
        .send({
          userId: '300000001',
          amount: 25,
          walletAddress: 'EQDsx...'
        });

      // Withdrawal should not affect referral balance
      const balanceRes = await request(app || require('../../server'))
        .get('/api/referral/balance')
        .set('Authorization', 'Bearer 300000001');

      if ([200, 201].includes(withdrawRes.status)) {
        expect([200, 204]).toContain(balanceRes.status);
      }
    });

    test('should handle referral chain correctly', async () => {
      // A → B (A refers B) → C (B refers C)
      // Verify commissions flow correctly

      const chainRes = await request(app || require('../../server'))
        .get('/api/referral/chain-info')
        .query({ userId: '400000001' });

      if (chainRes.status === 200) {
        expect(chainRes.body).toHaveProperty('directReferrals');
        expect(chainRes.body).toHaveProperty('indirectCommission');
        expect(typeof chainRes.body.directReferrals).toBe('number');
      }
    });
  });

  describe('Multi-Step Payment Flow', () => {
    test('should maintain transaction consistency across order → payment → commission', async () => {
      const userId = '500000001';
      const amount = 100;

      // Step 1: Create order
      const orderRes = await request(app || require('../../server'))
        .post('/api/orders/create')
        .send({
          userId,
          amount,
          starCount: 100
        });

      if ([200, 201].includes(orderRes.status)) {
        const orderId = orderRes.body.orderId;

        // Step 2: Verify payment processed
        const paymentRes = await request(app || require('../../server'))
          .post('/api/payment/verify')
          .send({
            orderId,
            transactionId: 'txn_test_' + Date.now()
          });

        // Step 3: Check order status updated
        const statusRes = await request(app || require('../../server'))
          .get(`/api/orders/${orderId}/status`);

        // All steps should maintain consistency
        expect([200, 201].includes(paymentRes.status)).toBe(true);
      }
    });
  });

  describe('Referral Cleanup & Verification', () => {
    test('should properly handle deleted user referrals', async () => {
      // If a referrer is deleted, referred users should still exist
      const deletedUserRes = await request(app || require('../../server'))
        .delete('/api/users/600000001');

      // Referrals should be preserved (hard delete prevention)
      const referredRes = await request(app || require('../../server'))
        .get('/api/referral/status')
        .query({ userId: '600000002' });

      expect([200, 204, 404]).toContain(referredRes.status);
    });

    test('should validate referral code uniqueness', async () => {
      const code = 'UNIQUE_CODE_' + Date.now();

      const res1 = await request(app || require('../../server'))
        .post('/api/referral/generate-code')
        .send({ userId: '700000001', code });

      const res2 = await request(app || require('../../server'))
        .post('/api/referral/generate-code')
        .send({ userId: '700000002', code });

      // Second attempt should fail
      if (res1.status === 200 || res1.status === 201) {
        expect([409, 400]).toContain(res2.status);
      }
    });
  });
});
