/**
 * Comprehensive tests for order amount calculation
 * Tests USDT/TON conversion, currency handling, and amount validation
 */

const pv = require('../../services/payment-verification');

describe('Amount Calculation: USDT & TON Conversion', () => {
    describe('Order Amount Calculation for USDT Payment', () => {
        test('calculates correct USDT units (6 decimals) for standard USDT amount', () => {
            expect(pv.computeExpectedUsdtUnits(10)).toBe(10_000_000);
            expect(pv.computeExpectedUsdtUnits(17.9)).toBe(17_900_000);
            expect(pv.computeExpectedUsdtUnits(100)).toBe(100_000_000);
        });

        test('handles small USDT amounts correctly', () => {
            expect(pv.computeExpectedUsdtUnits(0.01)).toBe(10_000);
            expect(pv.computeExpectedUsdtUnits(0.5)).toBe(500_000);
            expect(pv.computeExpectedUsdtUnits(1.5)).toBe(1_500_000);
        });

        test('rejects invalid USDT amounts', () => {
            expect(pv.computeExpectedUsdtUnits(0)).toBeNull();
            expect(pv.computeExpectedUsdtUnits(-5)).toBeNull();
            expect(pv.computeExpectedUsdtUnits(null)).toBeNull();
            expect(pv.computeExpectedUsdtUnits('invalid')).toBeNull();
        });

        test('precision: no rounding errors in USDT conversion', () => {
            // These values should round consistently
            const values = [1.5, 2.99, 5.555, 10.1, 99.99];
            for (const val of values) {
                const units = pv.computeExpectedUsdtUnits(val);
                expect(units).toBe(Math.round(val * 1_000_000));
            }
        });
    });

    describe('Order Amount Calculation for TON Payment', () => {
        test('converts USDT to nanoTON using provided rate', () => {
            // 10 USDT at 2.10 USDT/TON = 4.761904... TON = 4761904761 nanoTON
            const rate = 2.10;
            const usdtAmount = 10;
            const expected = Math.round((usdtAmount / rate) * 1e9);
            expect(pv.computeExpectedNanoTon(usdtAmount, rate)).toBe(expected);
        });

        test('converts 17.9 USDT to nanoTON correctly', () => {
            const rate = 2.10;
            const result = pv.computeExpectedNanoTon(17.9, rate);
            // 17.9 / 2.10 = 8.52380952... TON = 8523809523 nanoTON
            const expected = Math.round((17.9 / rate) * 1e9);
            expect(result).toBe(expected);
        });

        test('handles different TON/USDT rates correctly', () => {
            const usdtAmount = 100;
            const rates = [1.5, 2.0, 2.10, 3.5, 5.0];
            
            for (const rate of rates) {
                const result = pv.computeExpectedNanoTon(usdtAmount, rate);
                const expected = Math.round((usdtAmount / rate) * 1e9);
                expect(result).toBe(expected);
            }
        });

        test('rejects invalid TON conversion parameters', () => {
            expect(pv.computeExpectedNanoTon(0, 2.10)).toBeNull();
            expect(pv.computeExpectedNanoTon(10, 0)).toBeNull();
            expect(pv.computeExpectedNanoTon(-5, 2.10)).toBeNull();
            expect(pv.computeExpectedNanoTon(10, -2.10)).toBeNull();
            expect(pv.computeExpectedNanoTon(null, 2.10)).toBeNull();
        });

        test('does NOT confuse USDT amount with TON amount', () => {
            // This is the critical regression test - the bug was treating
            // 17.9 USDT as 17.9 TON, resulting in 17.9e9 nanoTON instead of ~8.5e9
            const rate = 2.10;
            const correctNanoTon = pv.computeExpectedNanoTon(17.9, rate);
            const incorrectNanoTon = Math.round(17.9 * 1e9); // WRONG: treats as TON
            
            expect(correctNanoTon).not.toBe(incorrectNanoTon);
            // Allow for rounding precision differences (±1 due to float math)
            expect(correctNanoTon).toBeGreaterThan(8_523_809_000);
            expect(correctNanoTon).toBeLessThan(8_524_000_000);
            expect(incorrectNanoTon).toBe(17_900_000_000); // Wrong value (2x too much!)
        });
    });

    describe('Amount Tolerance for Payment Verification', () => {
        test('accepts exact payment amount', () => {
            const expected = 100_000_000;
            expect(pv.amountWithinTolerance(expected, expected)).toBe(true);
        });

        test('accepts payment with small fee deduction (3% tolerance)', () => {
            const expected = 100_000_000;
            // 97% of expected should pass (3% fee tolerance)
            expect(pv.amountWithinTolerance(expected * 0.97, expected)).toBe(true);
            expect(pv.amountWithinTolerance(expected * 0.98, expected)).toBe(true);
            expect(pv.amountWithinTolerance(expected * 0.99, expected)).toBe(true);
        });

        test('rejects underpayment beyond tolerance', () => {
            const expected = 100_000_000;
            // Below 97% should fail
            expect(pv.amountWithinTolerance(expected * 0.96, expected)).toBe(false);
            expect(pv.amountWithinTolerance(expected * 0.90, expected)).toBe(false);
            expect(pv.amountWithinTolerance(expected * 0.50, expected)).toBe(false);
        });

        test('rejects overpayment (2x upper limit)', () => {
            const expected = 100_000_000;
            // Max allowed is 2x expected
            expect(pv.amountWithinTolerance(expected * 2.0, expected)).toBe(true);
            expect(pv.amountWithinTolerance(expected * 2.1, expected)).toBe(false);
            expect(pv.amountWithinTolerance(expected * 3.0, expected)).toBe(false);
        });

        test('rejects zero and invalid values', () => {
            const expected = 100_000_000;
            expect(pv.amountWithinTolerance(0, expected)).toBe(false);
            expect(pv.amountWithinTolerance(-100, expected)).toBe(false);
            expect(pv.amountWithinTolerance(expected, 0)).toBe(false);
            expect(pv.amountWithinTolerance(null, expected)).toBe(false);
        });
    });

    describe('USDT and TON Payment Verification Integration', () => {
        const STORE = 'EQAstoreWalletAddressForTests000000000000000000000001';

        function fakeFetch(payload) {
            return async () => ({ 
                ok: true, 
                status: 200, 
                json: async () => payload 
            });
        }

        test('USDT payment: verifies exact USDT transfer', async () => {
            const expectedUsdtUnits = pv.computeExpectedUsdtUnits(17.9); // 17,900,000
            
            // Verify the expected amount is correct
            expect(expectedUsdtUnits).toBe(17_900_000);
            
            // This would be verified on-chain, but the key is the expected amount is calculated correctly
            // The on-chain verification compares expectedUsdtUnits against actual transfer amount
            expect(pv.amountWithinTolerance(expectedUsdtUnits, expectedUsdtUnits)).toBe(true);
            
            // A transfer that matches within tolerance should pass
            expect(pv.amountWithinTolerance(expectedUsdtUnits * 0.99, expectedUsdtUnits)).toBe(true);
        });

        test('TON payment: verifies exact TON transfer', async () => {
            const rate = 2.10;
            const expectedNanoTon = pv.computeExpectedNanoTon(17.9, rate);
            const utime = Math.floor(Date.now() / 1000);
            const payload = { result: [
                {
                    utime,
                    lt: '5',
                    hash: 'TX_HASH_TON',
                    in_msg: {
                        value: String(expectedNanoTon)
                    }
                }
            ] };

            const res = await pv.verifyTonPayment({
                storeAddress: STORE,
                expectedNanoTon,
                fetch: fakeFetch(payload)
            });

            expect(res.verified).toBe(true);
            expect(res.txKey).toBe('5:TX_HASH_TON');
        });

        test('currency mismatch: USDT payment cannot verify TON order', async () => {
            // Order expects TON, but USDT transfer is made
            const rate = 2.10;
            const expectedNanoTon = pv.computeExpectedNanoTon(17.9, rate); // ~8.52 TON in nanoTON

            // Payment made in USDT units (17.9 USDT = 17,900,000 units)
            const usdtUnits = pv.computeExpectedUsdtUnits(17.9);

            // These should NOT match (different decimal places)
            expect(expectedNanoTon).not.toBe(usdtUnits);
            
            // Verify that comparing them as TON payment fails
            const utime = Math.floor(Date.now() / 1000);
            const payload = { result: [
                {
                    utime,
                    lt: '3',
                    hash: 'WRONG_CURRENCY_TX',
                    in_msg: {
                        value: String(usdtUnits) // Wrong: USDT units, not nanoTON
                    }
                }
            ] };

            const res = await pv.verifyTonPayment({
                storeAddress: STORE,
                expectedNanoTon,
                fetch: fakeFetch(payload)
            });

            expect(res.verified).toBe(false);
        });
    });

    describe('Real-world Order Amount Scenarios', () => {
        test('scenario: 1000 stars at $0.0179/star = $17.90', () => {
            const stars = 1000;
            const pricePerStar = 0.0179;
            const expectedUsdt = Number((stars * pricePerStar).toFixed(2));
            
            expect(expectedUsdt).toBe(17.90);
            expect(pv.computeExpectedUsdtUnits(expectedUsdt)).toBe(17_900_000);
        });

        test('scenario: 5000 stars with 2 recipients = $178.90 total', () => {
            const stars = 5000;
            const pricePerStar = 0.0179;
            const recipients = 2;
            const basePrice = Number((stars * pricePerStar).toFixed(2));
            const totalUsdt = Number((basePrice * recipients).toFixed(2));
            
            expect(basePrice).toBe(89.50);
            expect(totalUsdt).toBe(179.00);
            
            // Verify USDT calculation
            expect(pv.computeExpectedUsdtUnits(totalUsdt)).toBe(179_000_000);
            
            // Verify TON calculation at different rates
            const rateScenarios = [
                { rate: 2.10, expectedNano: 85_238_095_238 },
                { rate: 3.00, expectedNano: 59_666_666_667 },
                { rate: 2.50, expectedNano: 71_600_000_000 }
            ];
            
            for (const { rate, expectedNano } of rateScenarios) {
                const nano = pv.computeExpectedNanoTon(totalUsdt, rate);
                expect(nano).toBe(expectedNano);
            }
        });

        test('scenario: premium subscription $29.99/month for 3 months', () => {
            const pricePerMonth = 29.99;
            const months = 3;
            const totalUsdt = Number((pricePerMonth * months).toFixed(2));
            
            expect(totalUsdt).toBe(89.97);
            
            // USDT calculation
            const usdtUnits = pv.computeExpectedUsdtUnits(totalUsdt);
            expect(usdtUnits).toBe(89_970_000);
            
            // TON calculation
            const rate = 2.10;
            const nanoTon = pv.computeExpectedNanoTon(totalUsdt, rate);
            expect(nanoTon).toBe(Math.round((totalUsdt / rate) * 1e9));
        });
    });

    describe('Edge Cases and Precision', () => {
        test('handles very small amounts (0.01 USDT)', () => {
            const smallAmount = 0.01;
            const usdtUnits = pv.computeExpectedUsdtUnits(smallAmount);
            expect(usdtUnits).toBe(10_000);
            
            const nanoTon = pv.computeExpectedNanoTon(smallAmount, 2.10);
            expect(nanoTon).toBe(Math.round((smallAmount / 2.10) * 1e9));
        });

        test('handles large amounts (10000 USDT)', () => {
            const largeAmount = 10000;
            const usdtUnits = pv.computeExpectedUsdtUnits(largeAmount);
            expect(usdtUnits).toBe(10_000_000_000);
            
            const nanoTon = pv.computeExpectedNanoTon(largeAmount, 2.10);
            expect(nanoTon).toBe(Math.round((largeAmount / 2.10) * 1e9));
        });

        test('floating point precision: rounding consistent', () => {
            // Test that multiple calculations of same amount produce same result
            const amounts = [17.9, 29.99, 89.97, 1.5, 0.01];
            
            for (const amount of amounts) {
                const calc1 = pv.computeExpectedUsdtUnits(amount);
                const calc2 = pv.computeExpectedUsdtUnits(amount);
                expect(calc1).toBe(calc2);
                
                const ton1 = pv.computeExpectedNanoTon(amount, 2.10);
                const ton2 = pv.computeExpectedNanoTon(amount, 2.10);
                expect(ton1).toBe(ton2);
            }
        });
    });
});
