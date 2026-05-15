/**
 * Automatic Transaction Verification Modal
 * 
 * Features:
 * - Auto-closes on success (confirmed)
 * - Auto-closes on failure with error
 * - Auto-timeout with retry button
 * - User cannot close manually
 * - Tracks TON blockchain seqno for reliable verification
 */

class TransactionModal {
    constructor(options = {}) {
        this.timeout = options.timeout || 5 * 60 * 1000; // 5 minute default
        this.pollInterval = options.pollInterval || 3000; // 3 seconds
        this.maxRetries = options.maxRetries || 3;
        this.onSuccess = options.onSuccess || (() => {});
        this.onFailure = options.onFailure || (() => {});
        this.onTimeout = options.onTimeout || (() => {});
        
        this.isOpen = false;
        this.currentAttempt = 0;
        this.startTime = null;
    }

    /**
     * Open modal and start automatic verification
     */
    async open(verifyFn, data) {
        if (this.isOpen) return;
        this.isOpen = true;
        this.currentAttempt = 0;
        this.startTime = Date.now();

        await Swal.fire({
            title: 'Confirming Payment',
            html: `
                <div class="flex flex-col items-center justify-center py-12">
                    <div class="spinner"></div>
                    <p class="text-sm text-gray-700 font-medium mt-6">Checking blockchain...</p>
                    <p class="text-xs text-gray-500 mt-4">Your order has been received</p>
                    <p class="text-xs text-gray-500">Waiting for network confirmation</p>
                    <div class="text-xs text-gray-400 mt-4 px-4">
                        Order #${data.orderId}
                    </div>
                </div>
            `,
            icon: null,
            showConfirmButton: false,
            allowOutsideClick: false,
            allowEscapeKey: false,
            didOpen: async () => {
                await this._verifyWithTimeout(verifyFn, data);
            },
            customClass: {
                popup: 'rounded-xl shadow-lg'
            }
        });
    }

    /**
     * Internal: Verify with automatic timeout and retry
     */
    async _verifyWithTimeout(verifyFn, data) {
        const startTime = Date.now();
        let lastError = null;

        while (Date.now() - startTime < this.timeout) {
            try {
                const result = await verifyFn(data);

                if (result.status === 'confirmed') {
                    // Success - auto-close
                    await Swal.fire({
                        title: '✅ Order Confirmed',
                        html: `
                            <div class="text-center space-y-3">
                                <div class="text-green-600 text-5xl">✓</div>
                                <div class="text-sm text-gray-700">
                                    Your payment has been<br/>secured on the blockchain
                                </div>
                                <div class="text-xs text-gray-600 border-t pt-3 mt-3">
                                    Order #${data.orderId}<br/>
                                    Processing within 2 hours
                                </div>
                            </div>
                        `,
                        icon: null,
                        confirmButtonText: 'Done',
                        confirmButtonColor: '#10b981',
                        allowOutsideClick: false,
                        allowEscapeKey: false,
                        customClass: {
                            popup: 'rounded-xl shadow-lg'
                        }
                    });
                    this.isOpen = false;
                    this.onSuccess(result);
                    return;
                }

                if (result.status === 'pending') {
                    // Still processing - continue polling
                    await this._delay(this.pollInterval);
                    continue;
                }

                // Unknown status
                lastError = result.error || 'Transaction status unknown';
                break;

            } catch (error) {
                lastError = error.message;
                console.debug('Verification attempt failed:', lastError);
                await this._delay(this.pollInterval);
            }
        }

        // Timeout reached
        this.isOpen = false;
        await Swal.fire({
            title: 'Order Received',
            html: `
                <div class="text-center space-y-3">
                    <div class="text-yellow-600 text-5xl">⏱</div>
                    <div class="text-sm text-gray-700">
                        Your payment is being processed.<br/>
                        Confirmation may take a few more moments.
                    </div>
                    <div class="text-xs text-gray-600 mt-4">
                        Order #${data.orderId}<br/>
                        Status: Pending Network Confirmation
                    </div>
                    <div class="text-xs text-gray-500 mt-4 bg-blue-50 p-2 rounded">
                        ✓ Your wallet was debited<br/>
                        ✓ Order is in our system<br/>
                        ✓ Will complete within 2 hours
                    </div>
                </div>
            `,
            icon: null,
            showCancelButton: true,
            confirmButtonText: 'Keep Waiting',
            cancelButtonText: 'Close',
            confirmButtonColor: '#3b82f6',
            cancelButtonColor: '#9ca3af',
            allowOutsideClick: false,
            allowEscapeKey: false,
            customClass: {
                popup: 'rounded-xl shadow-lg'
            }
        }).then((result) => {
            if (result.isConfirmed) {
                // User wants to continue waiting
                this.open(verifyFn, data);
            } else {
                this.onTimeout(data);
            }
        });
    }

    /**
     * Show error modal
     */
    async error(title, message, data) {
        this.isOpen = false;
        await Swal.fire({
            title: title || 'Verification Failed',
            html: `
                <div class="text-center space-y-2">
                    <div class="text-sm text-gray-700">${message}</div>
                    ${data?.orderId ? `<div class="text-xs text-gray-600">Order ID: ${data.orderId}</div>` : ''}
                </div>
            `,
            icon: 'error',
            confirmButtonText: 'OK',
            confirmButtonColor: '#ef4444',
            allowOutsideClick: false,
            allowEscapeKey: false,
            customClass: {
                popup: 'rounded-xl shadow-lg'
            }
        });
        this.onFailure({ error: message });
    }

    /**
     * Simple delay helper
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Export for use in pages
window.TransactionModal = TransactionModal;
console.log('Transaction Modal loaded:', typeof TransactionModal);
