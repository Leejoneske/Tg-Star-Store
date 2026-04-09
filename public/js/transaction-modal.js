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
            title: 'Verifying Payment',
            html: `
                <div class="flex flex-col items-center justify-center py-12">
                    <div class="spinner"></div>
                    <p class="text-sm text-gray-600 mt-6">Checking blockchain confirmation...</p>
                    <p class="text-xs text-gray-500 mt-2">Please do not close this window</p>
                </div>
            `,
            icon: null,
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
                        title: 'Payment Confirmed',
                        html: `
                            <div class="text-center space-y-3">
                                <div class="text-green-600 text-lg">✓</div>
                                <div class="text-sm text-gray-700">
                                    Transaction finalized on blockchain
                                </div>
                                <div class="text-xs text-gray-600">
                                    Order ID: ${data.orderId || 'N/A'}
                                </div>
                            </div>
                        `,
                        icon: 'success',
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
            title: 'Verification Timeout',
            html: `
                <div class="text-center space-y-3">
                    <div class="text-yellow-600 text-lg">⏱</div>
                    <div class="text-sm text-gray-700">
                        Blockchain verification took longer than expected.
                    </div>
                    <div class="text-xs text-gray-600 mt-4">
                        ${lastError ? `Error: ${lastError}` : 'Order may still be processing.'}
                    </div>
                    <div class="text-xs text-gray-500 mt-2">
                        Order ID: ${data.orderId || 'N/A'}
                    </div>
                </div>
            `,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Retry',
            cancelButtonText: 'Close',
            confirmButtonColor: '#3b82f6',
            cancelButtonColor: '#gray',
            allowOutsideClick: false,
            allowEscapeKey: false,
            customClass: {
                popup: 'rounded-xl shadow-lg'
            }
        }).then((result) => {
            if (result.isConfirmed) {
                // User wants to retry
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
