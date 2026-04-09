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
    async verify(orderId, userWalletAddress) {
        try {
            const response = await fetch('/api/verify-transaction', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-telegram-init-data': window.Telegram?.WebApp?.initData || '',
                    'x-telegram-id': window.Telegram?.WebApp?.initDataUnsafe?.user?.id || 'dev-user'
                },
                body: JSON.stringify({
                    orderId,
                    userWalletAddress
                })
            });

            if (!response.ok) {
                console.error('❌ Verification API error:', response.status);
                return {
                    status: 'pending',  // Return pending on error to keep polling
                    error: `Verification service error`,
                    orderId
                };
            }

            const result = await response.json();
            
            // Map API response to verify result
            if (!result.success || !result.verified) {
                // Transaction not yet confirmed, keep polling
                if (result.status === 'pending') {
                    console.log('⏳ Waiting for blockchain confirmation...');
                    return {
                        status: 'pending',
                        orderId
                    };
                }
                
                console.log('⏳ Still verifying transaction...');
                return {
                    status: 'pending',
                    orderId
                };
            }

            // Transaction confirmed!
            console.log('✅ Transaction CONFIRMED on blockchain');
            return {
                status: 'confirmed',
                orderId
            };

        } catch (error) {
            console.error('❌ Verification error:', error.message);
            // Return pending on network errors to retry
            return {
                status: 'pending',
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
                orderData.orderId,
                orderData.userWalletAddress
            );
        };

        // Open modal with auto-verification
        await modal.open(verifyFn, {
            orderId: orderData.orderId
        });

        return modal;
    }
};

console.log('✅ Transaction Verifier loaded');
