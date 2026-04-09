/**
 * Transaction Verification Service
 * Handles real-time blockchain confirmation checking
 * 
 * Features:
 * - Direct TON blockchain polling
 * - Pending → Confirmed status tracking
 * - Automatic success/failure detection
 * - Proper timeout handling
 * - No user manual close allowed
 */

window.TransactionVerifier = {
    /**
     * Verify a transaction using backend API
     * Returns: { status: 'pending'|'confirmed'|'failed', transaction: {...}, error?: string }
     */
    async verify(transactionHash, walletAddress, expectedAmount, orderId) {
        try {
            const response = await fetch('/api/verify-transaction', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-telegram-init-data': window.Telegram?.WebApp?.initData || '',
                    'x-telegram-id': window.Telegram?.WebApp?.initDataUnsafe?.user?.id || 'dev-user'
                },
                body: JSON.stringify({
                    transactionHash,
                    targetAddress: walletAddress,
                    expectedAmount
                })
            });

            if (!response.ok) {
                console.error('❌ Verification API error:', response.status);
                return {
                    status: 'failed',
                    error: `API error: ${response.status}`,
                    orderId
                };
            }

            const result = await response.json();
            
            // Map API response to verify result
            if (!result.success || !result.verified) {
                // Transaction not yet confirmed, or unknown status
                if (result.status === 'pending') {
                    console.log('⏳ Transaction pending in mempool...');
                    return {
                        status: 'pending',
                        transaction: result.transaction,
                        orderId
                    };
                }
                
                console.log('⏳ Transaction still being processed...');
                return {
                    status: 'pending',
                    transaction: result.transaction,
                    orderId
                };
            }

            // Transaction confirmed!
            console.log('✅ Transaction CONFIRMED on blockchain');
            return {
                status: 'confirmed',
                transaction: result.transaction,
                orderId
            };

        } catch (error) {
            console.error('❌ Verification error:', error.message);
            return {
                status: 'failed',
                error: error.message,
                orderId
            };
        }
    },

    /**
     * Start verification polling with automatic modal management
     * Opens modal, polls in background, auto-closes on result
     */
    async startAutoVerification(orderData) {
        const modal = new window.TransactionModal({
            timeout: 5 * 60 * 1000,        // 5 minute timeout
            pollInterval: 3000,             // Poll every 3 seconds  
            onSuccess: (result) => {
                console.log('✅ Transaction verified successfully');
                // Order already created on backend, just notify user
            },
            onFailure: (error) => {
                console.error('❌ Transaction verification failed:', error);
                // Show support contact info
            },
            onTimeout: (data) => {
                console.warn('⏱ Transaction verification timed out');
                // Order may still be processing on backend
            }
        });

        // Define verification function
        const verifyFn = async (data) => {
            return this.verify(
                orderData.transactionHash,
                orderData.walletAddress,
                orderData.totalAmount,
                orderData.orderId
            );
        };

        // Open modal with auto-verification
        await modal.open(verifyFn, {
            orderId: orderData.orderId,
            transactionHash: orderData.transactionHash
        });

        return modal;
    }
};

console.log('✅ Transaction Verifier loaded');
