/**
 * TON Address Utilities
 * Handles conversion and formatting of TON wallet addresses
 */

window.TonUtils = {
    /**
     * Converts hex TON address to user-friendly format
     * Handles both hex format (0:deadbeef...) and standard format (EQ... or UQ...)
     */
    formatAddress(address) {
        if (!address) return '';
        
        const trimmed = address.trim();
        
        // Already in standard format (starts with EQ or UQ)
        if (trimmed.startsWith('EQ') || trimmed.startsWith('UQ')) {
            return trimmed;
        }
        
        // Hex format: 0:deadbeef... or -1:deadbeef...
        if (trimmed.includes(':') && /^[-0-9]+:[a-fA-F0-9]+$/.test(trimmed)) {
            return this.hexToBase64(trimmed);
        }
        
        return trimmed;
    },

    /**
     * Convert hex TON address (0:hex or -1:hex) to base64url format
     */
    hexToBase64(hexAddress) {
        try {
            const parts = hexAddress.split(':');
            if (parts.length !== 2) return hexAddress;
            
            const workchain = parseInt(parts[0], 10);
            const hash = parts[1];
            
            // Validate hex
            if (!/^[a-fA-F0-9]{64}$/i.test(hash)) {
                console.warn('Invalid hex address format:', hexAddress);
                return hexAddress;
            }
            
            // Reconstruct address bytes: workchain (4 bytes) + hash (32 bytes)
            const addressBytes = [];
            
            // Add workchain (big-endian, 4 bytes)
            addressBytes.push((workchain >> 24) & 0xFF);
            addressBytes.push((workchain >> 16) & 0xFF);
            addressBytes.push((workchain >> 8) & 0xFF);
            addressBytes.push(workchain & 0xFF);
            
            // Add hash
            for (let i = 0; i < hash.length; i += 2) {
                addressBytes.push(parseInt(hash.substr(i, 2), 16));
            }
            
            // Calculate CRC16-CCITT checksum
            const crc = this.crc16(addressBytes);
            addressBytes.push((crc >> 8) & 0xFF);
            addressBytes.push(crc & 0xFF);
            
            // Convert to base64url
            const binaryString = String.fromCharCode(...addressBytes);
            const base64 = btoa(binaryString);
            const base64url = base64
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=/g, '');
            
            // Determine prefix based on workchain
            const prefix = workchain === -1 ? 'U' : 'E';
            const isTestnet = false; // Set to true if needed
            const testnetPrefix = isTestnet ? 't' : '';
            
            return prefix + testnetPrefix + 'Q' + base64url;
        } catch (error) {
            console.error('Error converting hex to base64:', error);
            return hexAddress;
        }
    },

    /**
     * CRC16-CCITT checksum calculation
     */
    crc16(data) {
        let crc = 0;
        
        for (let byte of data) {
            crc ^= (byte << 8);
            
            for (let i = 0; i < 8; i++) {
                crc <<= 1;
                if (crc & 0x10000) {
                    crc ^= 0x1021;
                }
            }
            crc &= 0xFFFF;
        }
        
        return crc;
    },

    /**
     * Get shortened display format: "EQAb...c5aw"
     */
    getShortAddress(address, startChars = 5, endChars = 4) {
        const formatted = this.formatAddress(address);
        if (formatted.length <= 10) {
            return formatted;
        }
        return `${formatted.slice(0, startChars)}...${formatted.slice(-endChars)}`;
    },

    /**
     * Get friendly display: "EQAB...5aw (full tooltip on hover)"
     */
    getDisplayAddress(address) {
        const formatted = this.formatAddress(address);
        return {
            short: this.getShortAddress(formatted),
            full: formatted,
            isFormatted: formatted !== address
        };
    },

    /**
     * Validate if address looks like a valid TON address
     */
    isValidAddress(address) {
        if (!address) return false;
        
        const trimmed = address.trim();
        
        // Standard format
        if ((trimmed.startsWith('EQ') || trimmed.startsWith('UQ') || trimmed.startsWith('tEQ') || trimmed.startsWith('tUQ')) 
            && trimmed.length > 40 && trimmed.length < 50) {
            return true;
        }
        
        // Hex format
        if (/^[-0-9]+:[a-fA-F0-9]{64}$/.test(trimmed)) {
            return true;
        }
        
        return false;
    }
};

console.log('✅ TON Utils loaded:', window.TonUtils);
