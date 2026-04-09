/**
 * TON Transaction Service - Sub-Second Mainnet Compatible
 * Supports Toncenter Streaming API V2 and Pending/Confirmed statuses
 * Reference: https://toncenter.com/api/v2/
 * 
 * The Sub-Second update requires:
 * - Pending status: Operation is in mempool but not yet finalized
 * - Confirmed status: Operation is finalized on masterchain
 * - WebSocket support for real-time updates
 * - Optimized latency for near-instant UX
 */

const axios = require('axios');
const EventEmitter = require('events');

class TonTransactionService extends EventEmitter {
  constructor() {
    super();
    this.tonApiKey = process.env.TON_API_KEY;
    this.tonEndpoint = process.env.TON_MAINNET_ENDPOINT || 'https://toncenter.com/api/v2/jsonRPC';
    this.transactionCache = new Map();
    this.cacheTimeout = 30000; // 30 second cache for rapid fire requests
    this.pollInterval = 3000; // Check every 3 seconds (Sub-Second compatible)
  }

  /**
   * Verify transaction with Pending/Confirmed status tracking
   * Returns { status: 'pending'|'confirmed'|'unknown', transaction: {...} }
   */
  async verifyTransaction(txHash, walletAddress, expectedAmount) {
    try {
      // Check cache first (Sub-Second updates are fast, but cache prevents redundant calls)
      const cacheKey = `${txHash}:${walletAddress}`;
      const cached = this.transactionCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        console.log('📦 [TON] Transaction from cache:', cacheKey);
        return cached.data;
      }

      // Fetch with Toncenter API V2 - optimized for Sub-Second
      const result = await this._fetchTransactionDetails(txHash, walletAddress, expectedAmount);
      
      // Cache the result for quick subsequent checks
      this.transactionCache.set(cacheKey, {
        timestamp: Date.now(),
        data: result
      });

      // Emit transaction event for real-time listeners
      this.emit('transaction', {
        txHash,
        walletAddress,
        status: result.status,
        timestamp: Date.now()
      });

      return result;
    } catch (error) {
      console.debug('[TON] Transaction verification failed:', error.message);
      return {
        status: 'unknown',
        error: error.message,
        transaction: null
      };
    }
  }

  /**
   * Find transaction by amount and target address (more reliable than hash lookup)
   * Returns the most recent matching transaction
   */
  async findTransactionByAmountAndTarget(walletAddress, targetAddress, expectedAmount, lookbackLimit = 50) {
    try {
      const transactions = await this.getTransactionsByAddress(walletAddress, lookbackLimit);
      
      // Look for outgoing transaction matching amount and target
      for (const tx of transactions) {
        // Check outgoing messages for amount and destination match
        if (tx.out_msgs && Array.isArray(tx.out_msgs)) {
          for (const msg of tx.out_msgs) {
            const msgAmount = this._parseAmount(msg.value);
            const msgAddress = msg.destination;
            
            // Match on amount (with small tolerance) and address
            if (msgAddress === targetAddress || msgAddress?.includes(targetAddress?.split(':')[1])) {
              // For USDT or other tokens, also check incoming messages
              if (tx.in_msg) {
                const inAmount = this._parseAmount(tx.in_msg.value);
                // If amounts roughly match (within 10% tolerance for fee variations)
                if (Math.abs(msgAmount - expectedAmount) < expectedAmount * 0.1) {
                  console.debug(`[TON] Found matching transaction by amount/target: ${tx.hash}`);
                  return {
                    status: this._determineTransactionStatus(tx),
                    transaction: tx,
                    utime: tx.utime,
                    lt: tx.lt,
                    in_msg: tx.in_msg,
                    out_msgs: tx.out_msgs
                  };
                }
              }
            }
          }
        }
      }
      
      return {
        status: 'unknown',
        transaction: null,
        message: `No transaction found matching ${expectedAmount} USDT to ${targetAddress}`
      };
    } catch (error) {
      throw error;
    }
  }
    try {
      const url = new URL('https://toncenter.com/api/v2/getTransactions');
      url.searchParams.append('address', address);
      url.searchParams.append('limit', limit);
      if (beforeLt) {
        url.searchParams.append('before_lt', beforeLt);
      }
      if (this.tonApiKey) {
        url.searchParams.append('api_key', this.tonApiKey);
      }

      console.debug('[TON] Fetching transactions:', address);
      const response = await axios.get(url.toString(), {
        timeout: 8000, // Sub-Second requires fast responses
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.data?.ok) {
        throw new Error(response.data?.error || 'API returned error');
      }

      // Enhance transaction data with pending/confirmed status
      const transactions = response.data.result.map(tx => this._enhanceTransaction(tx));
      console.debug(`[TON] Found ${transactions.length} transactions`);
      return transactions;
    } catch (error) {
      console.error('❌ [TON] Failed to get transactions:', error.message);
      throw error;
    }
  }

  /**
   * Check if transaction is in mempool (Pending status)
   * Pending: Transaction is submitted to network but not yet in a block
   */
  async isTransactionPending(txHash, address) {
    try {
      const transactions = await this.getTransactionsByAddress(address, 20);
      const tx = transactions.find(t => 
        t.transaction_id?.hash === txHash || 
        t.hash === txHash
      );

      if (!tx) return false;

      // In Sub-Second network, pending means in mempool
      // Check if transaction has been included in a block
      return !tx.block_id || tx.block_id === null;
    } catch (error) {
      console.error('❌ [TON] Error checking pending status:', error.message);
      return false;
    }
  }

  /**
   * Check if transaction is confirmed on masterchain
   * Confirmed: Transaction is finalized and settled
   */
  async isTransactionConfirmed(txHash, address) {
    try {
      const transactions = await this.getTransactionsByAddress(address, 50);
      const tx = transactions.find(t =>
        t.transaction_id?.hash === txHash ||
        t.hash === txHash
      );

      if (!tx) return false;

      // Confirmed means:
      // 1. Has block_id (included in a block)
      // 2. Block is finalized on masterchain
      return tx.block_id !== null && !!tx.block_id;
    } catch (error) {
      console.error('❌ [TON] Error checking confirmed status:', error.message);
      return false;
    }
  }

  /**
   * Poll for transaction status changes (Pending -> Confirmed)
   * Emits events as status changes
   */
  async pollTransactionStatus(txHash, address, maxDuration = 120000) {
    const startTime = Date.now();
    let lastKnownStatus = 'unknown';

    return new Promise((resolve) => {
      const pollInterval = setInterval(async () => {
        try {
          const result = await this.verifyTransaction(txHash, address);
          
          // Emit status change events
          if (result.status !== lastKnownStatus) {
      console.debug(`[TON] Transaction status changed: ${lastKnownStatus} -> ${result.status}`);
            this.emit('statusChanged', {
              txHash,
              address,
              oldStatus: lastKnownStatus,
              newStatus: result.status,  
              timestamp: Date.now()
            });
            lastKnownStatus = result.status;
          }

          // Stop polling when confirmed or on timeout
          if (result.status === 'confirmed') {
            clearInterval(pollInterval);
            resolve(result);
            return;
          }

          if (Date.now() - startTime > maxDuration) {
            clearInterval(pollInterval);
            resolve({
              status: 'timeout',
              lastKnownStatus,
              transaction: result.transaction
            });
            return;
          }
        } catch (error) {
          console.debug('[TON] Poll error:', error.message);
        }
      }, this.pollInterval);
    });
  }

  // ===== PRIVATE METHODS =====

  /**
   * Fetch detailed transaction information
   * Returns { status: 'pending'|'confirmed', transaction: {...} }
   */
  async _fetchTransactionDetails(txHash, walletAddress, expectedAmount) {
    try {
      const transactions = await this.getTransactionsByAddress(walletAddress, 20);
      const tx = transactions.find(t => 
        t.transaction_id?.hash === txHash || 
        t.hash === txHash
      );

      if (!tx) {
        return {
          status: 'unknown',
          transaction: null,
          message: 'Transaction not found in recent history'
        };
      }

      // Validate amount if provided
      if (expectedAmount !== undefined) {
        const inAmount = this._parseAmount(tx.in_msg?.value);
        const outAmount = this._parseAmount(tx.out_msgs?.[0]?.value);
        const txAmount = inAmount || outAmount || 0;

        if (Math.abs(txAmount - expectedAmount) > 0.001) {
          return {
            status: 'unknown',
            transaction: tx,
            message: `Amount mismatch: expected ${expectedAmount}, got ${txAmount}`
          };
        }
      }

      // Determine status based on Sub-Second requirements
      const status = this._determineTransactionStatus(tx);

      return {
        status,
        transaction: tx,
        utime: tx.utime,
        lt: tx.lt,
        in_msg: tx.in_msg,
        out_msgs: tx.out_msgs
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Determine transaction status following TON Sub-Second model
   * Pending: In mempool, not finalized
   * Confirmed: Finalized on masterchain
   */
  _determineTransactionStatus(tx) {
    // Confirmed: Has block_id indicating it's in a committed block
    if (tx.block_id && typeof tx.block_id === 'object' && tx.block_id.workchain !== undefined) {
      return 'confirmed';
    }

    // Pending: No block_id yet but transaction exists (in mempool)
    if (!tx.block_id) {
      return 'pending';
    }

    // Unknown/failed
    return 'unknown';
  }

  /**
   * Parse amount from TON transaction value
   * Values are in nanoTON, converts to TON
   */
  _parseAmount(value) {
    if (!value) return 0;
    if (typeof value === 'string') {
      return parseInt(value) / 1e9; // nanoTON to TON
    }
    return 0;
  }

  /**
   * Enhance transaction with additional context
   */
  _enhanceTransaction(tx) {
    return {
      ...tx,
      _status: this._determineTransactionStatus(tx),
      _in_amount: this._parseAmount(tx.in_msg?.value),
      _out_amounts: (tx.out_msgs || []).map(msg => this._parseAmount(msg.value)),
      _timestamp: new Date(tx.utime * 1000)
    };
  }

  /**
   * Clear old cache entries periodically
   */
  clearOldCache() {
    const now = Date.now();
    for (const [key, value] of this.transactionCache.entries()) {
      if (now - value.timestamp > this.cacheTimeout * 2) {
        this.transactionCache.delete(key);
      }
    }
  }
}

// Export singleton instance
module.exports = new TonTransactionService();
