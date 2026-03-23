# PDF Export Codebase Analysis

## 1. HTML UI Elements (history.html)

### Export Buttons and Modals

**Location:** [public/history.html](public/history.html#L465-L487)

#### Transactions Export Button
```html
<button id="exportTransactions" class="export-btn">
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
    <span data-translate="exportTransactions">Export Transactions</span>
</button>

<!-- Export Format Modal - PDF Only -->
<div id="exportFormatModal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-end z-50" style="display: none;">
    <div class="w-full bg-white rounded-t-2xl p-6 space-y-4 animate-slide-up">
        <h3 class="text-lg font-bold text-gray-900">Download Statement</h3>
        <p class="text-sm text-gray-600">Your transactions will be exported as a professional PDF statement</p>
        <div class="flex flex-col gap-3">
            <button id="exportFormatPDF" class="export-format-btn w-full p-4 border-2 border-indigo-500 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors">
                <div class="text-3xl mb-2">📄</div>
                <div class="font-semibold text-gray-900">Download as PDF</div>
                <div class="text-xs text-gray-600">View all your transactions</div>
            </button>
        </div>
        <button id="exportFormatCancel" class="w-full py-2 text-gray-700 font-medium border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
        </button>
    </div>
</div>
```

#### Referrals Export Button
**Location:** [public/history.html](public/history.html#L524-L552)

```html
<button id="exportReferrals" class="export-btn">
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
    <span data-translate="exportReferrals">Export Referrals</span>
</button>

<!-- Referral Export Format Modal - PDF Only -->
<div id="exportFormatReferralsModal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-end z-50" style="display: none;">
    <div class="w-full bg-white rounded-t-2xl p-6 space-y-4 animate-slide-up">
        <h3 class="text-lg font-bold text-gray-900">Download Statement</h3>
        <p class="text-sm text-gray-600">Your referral earnings will be exported as a professional PDF statement</p>
        <div class="flex flex-col gap-3">
            <button id="exportFormatReferralsPDF" class="export-format-btn w-full p-4 border-2 border-indigo-500 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors">
                <div class="text-3xl mb-2">📄</div>
                <div class="font-semibold text-gray-900">Download as PDF</div>
                <div class="text-xs text-gray-600">Professional earnings statement</div>
            </button>
        </div>
        <button id="exportFormatReferralsCancel" class="w-full py-2 text-gray-700 font-medium border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
        </button>
    </div>
</div>
```

---

## 2. JavaScript Export Functions (history.html)

**Location:** [public/history.html](public/history.html#L1258-L1490)

### Transaction Export Flow

```javascript
async function exportTransactions() {
    // Show PDF download modal
    const modal = document.getElementById('exportFormatModal');
    modal.style.display = 'flex';
    
    // Cancel button
    document.getElementById('exportFormatCancel').onclick = () => {
        modal.style.display = 'none';
    };
    
    // PDF export
    document.getElementById('exportFormatPDF').onclick = async () => {
        modal.style.display = 'none';
        await doExportTransactions('pdf');
    };
}

async function doExportTransactions(format) {
    try {
        // Show loading state
        const exportBtn = document.getElementById('exportTransactions');
        const originalText = exportBtn.innerHTML;
        exportBtn.innerHTML = '<div class="spinner"></div> Generating PDF...';
        exportBtn.disabled = true;

        const headers = {
            'Content-Type': 'application/json'
        };
        
        // Add Telegram authentication headers
        if (window.Telegram?.WebApp?.initData) {
            headers['x-telegram-init-data'] = window.Telegram.WebApp.initData;
            console.log('Using x-telegram-init-data header');
        } else if (user?.id && user.id !== undefined && user.id !== null && user.id !== 'undefined') {
            headers['x-telegram-id'] = user.id.toString();
            console.log('Using x-telegram-id header from user object:', user.id);
        } else {
            const telegramUserId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
            if (telegramUserId && telegramUserId !== undefined && telegramUserId !== null && telegramUserId !== 'undefined') {
                headers['x-telegram-id'] = telegramUserId.toString();
                console.log('Using x-telegram-id header from initDataUnsafe:', telegramUserId);
            }
        }

        // Call API endpoint
        const response = await fetch(`${BASE_API_URL}/api/export-transactions-pdf`, {
            method: 'POST',
            headers: headers
        });

        console.log('Export response status:', response.status);
        const respContentType = response.headers.get('content-type') || '';
        
        // Error handling
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Export response error:', errorText);
            let errorMessage = 'Export failed';
            try {
                const errorData = JSON.parse(errorText);
                errorMessage = errorData.error || errorMessage;
            } catch (e) {
                errorMessage = errorText || errorMessage;
            }
            throw new Error(`HTTP ${response.status}: ${errorMessage}`);
        }
        
        // Handle PDF blob
        let blob;
        if (respContentType.includes('application/pdf')) {
            blob = await response.blob();
        } else if (respContentType.includes('application/json')) {
            const result = await response.json();
            if (result && result.success) {
                Swal.fire({
                    title: TranslationUtils.get('success'),
                    text: '📄 PDF has been sent to your Telegram!',
                    icon: 'success',
                    confirmButtonText: TranslationUtils.get('close'),
                    confirmButtonColor: '#4f46e5'
                });
                return;
            }
            throw new Error(result && result.error || 'Export failed');
        } else {
            throw new Error('Unexpected response format');
        }
        
        // Download the PDF
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `transactions_${user?.id || 'user'}_${new Date().toISOString().slice(0, 10)}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        
        Swal.fire({
            title: TranslationUtils.get('success'),
            text: '📄 PDF statement downloaded!',
            icon: 'success',
            confirmButtonText: TranslationUtils.get('close'),
            confirmButtonColor: '#4f46e5'
        });
    } catch (error) {
        console.error('Export error:', error);
        Swal.fire({
            title: TranslationUtils.get('error'),
            text: 'Failed to export statement. Please try again.',
            icon: 'error',
            confirmButtonText: TranslationUtils.get('close'),
            confirmButtonColor: '#dc2626'
        });
    } finally {
        // Restore button state
        const exportBtn = document.getElementById('exportTransactions');
        exportBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg><span data-translate="exportTransactions">Export Transactions</span>';
        exportBtn.disabled = false;
    }
}
```

### Referral Export Flow

```javascript
async function exportReferrals() {
    // Show PDF download modal
    const modal = document.getElementById('exportFormatReferralsModal');
    modal.style.display = 'flex';
    
    // Cancel button
    document.getElementById('exportFormatReferralsCancel').onclick = () => {
        modal.style.display = 'none';
    };
    
    // PDF export
    document.getElementById('exportFormatReferralsPDF').onclick = async () => {
        modal.style.display = 'none';
        await doExportReferrals('pdf');
    };
}

async function doExportReferrals(format) {
    try {
        // Show loading state
        const exportBtn = document.getElementById('exportReferrals');
        const originalText = exportBtn.innerHTML;
        exportBtn.innerHTML = '<div class="spinner"></div> Generating PDF...';
        exportBtn.disabled = true;

        const headers = {
            'Content-Type': 'application/json'
        };
        
        // Add Telegram authentication headers
        if (window.Telegram?.WebApp?.initData) {
            headers['x-telegram-init-data'] = window.Telegram.WebApp.initData;
        } else if (user?.id && user.id !== undefined && user.id !== null && user.id !== 'undefined') {
            headers['x-telegram-id'] = user.id.toString();
        } else {
            const telegramUserId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
            if (telegramUserId && telegramUserId !== undefined && telegramUserId !== null && telegramUserId !== 'undefined') {
                headers['x-telegram-id'] = telegramUserId.toString();
            }
        }

        // Call API endpoint
        const response = await fetch(`${BASE_API_URL}/api/export-referrals-pdf`, {
            method: 'POST',
            headers: headers
        });

        // Error handling
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Export referrals response error:', errorText);
            let errorMessage = 'Export failed';
            try {
                const errorData = JSON.parse(errorText);
                errorMessage = errorData.error || errorMessage;
            } catch (e) {
                errorMessage = errorText || errorMessage;
            }
            throw new Error(`HTTP ${response.status}: ${errorMessage}`);
        }

        const respContentType = response.headers.get('content-type') || '';
        let blob;
        if (respContentType.includes('application/pdf')) {
            blob = await response.blob();
        } else if (respContentType.includes('application/json')) {
            const result = await response.json();
            if (result && result.success) {
                Swal.fire({
                    title: TranslationUtils.get('success'),
                    text: '📄 PDF has been sent to your Telegram!',
                    icon: 'success',
                    confirmButtonText: TranslationUtils.get('close'),
                    confirmButtonColor: '#4f46e5'
                });
                return;
            }
            throw new Error(result && result.error || 'Export failed');
        } else {
            throw new Error('Unexpected response format');
        }
        
        // Download the PDF
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `referrals_${user?.id || 'user'}_${new Date().toISOString().slice(0, 10)}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        
        Swal.fire({
            title: TranslationUtils.get('success'),
            text: '📄 PDF statement downloaded!',
            icon: 'success',
            confirmButtonText: TranslationUtils.get('close'),
            confirmButtonColor: '#4f46e5'
        });

    } catch (error) {
        console.error('Export error:', error);
        Swal.fire({
            title: TranslationUtils.get('error'),
            text: 'Failed to export statement. Please try again.',
            icon: 'error',
            confirmButtonText: TranslationUtils.get('close'),
            confirmButtonColor: '#dc2626'
        });
    } finally {
        // Restore button state
        const exportBtn = document.getElementById('exportReferrals');
        exportBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg><span data-translate="exportReferrals">Export Referrals</span>';
        exportBtn.disabled = false;
    }
}
```

---

## 3. API Endpoints (server.js)

**Location:** [server.js](server.js#L65-L70)

### PDF Generator Initialization

```javascript
// PDF Generator for professional statements
let pdfGenerator = null;
try {
  pdfGenerator = require('./services/pdf-generator');
} catch {
  // noop if missing - PDF export will be skipped gracefully
}
```

### Export Transactions PDF Endpoint

**Location:** [server.js](server.js#L12429-L12525)

```javascript
// Export transactions as PDF (professional formatted statement)
app.post('/api/export-transactions-pdf', requireTelegramAuth, async (req, res) => {
    try {
        if (!pdfGenerator) {
            return res.status(501).json({ error: 'PDF export not available' });
        }

        const userId = req.user.id;
        const userInfo = req.user || {};
        
        // Fetch transactions
        let buyOrders = [];
        let sellOrders = [];
        
        try {
            buyOrders = await BuyOrder.find({ telegramId: userId })
                .sort({ dateCreated: -1 })
                .lean();
        } catch (err) {
            console.error('Error fetching buy orders:', err.message);
            buyOrders = [];
        }
        
        try {
            sellOrders = await SellOrder.find({ telegramId: userId })
                .sort({ dateCreated: -1 })
                .lean();
        } catch (err) {
            console.error('Error fetching sell orders:', err.message);
            sellOrders = [];
        }

        // Format transactions
        const transactions = [];
        
        if (buyOrders && buyOrders.length > 0) {
            buyOrders.forEach(order => {
                try {
                    transactions.push({
                        id: order.id || 'N/A',
                        type: 'Buy Stars',
                        amount: order.stars || 0,
                        status: (order.status || 'unknown').toLowerCase(),
                        date: order.dateCreated || new Date(),
                        usdtValue: order.amount || 0
                    });
                } catch (err) {
                    console.error('Error processing buy order:', err.message);
                }
            });
        }
        
        if (sellOrders && sellOrders.length > 0) {
            sellOrders.forEach(order => {
                try {
                    transactions.push({
                        id: order.id || 'N/A',
                        type: 'Sell Stars',
                        amount: order.stars || 0,
                        status: (order.status || 'unknown').toLowerCase(),
                        date: order.dateCreated || new Date(),
                        usdtValue: order.amount || 0
                    });
                } catch (err) {
                    console.error('Error processing sell order:', err.message);
                }
            });
        }

        // Generate PDF
        const docDefinition = pdfGenerator.generateTransactionPDF(
            userId,
            userInfo.username,
            transactions
        );
        
        const buffer = await pdfGenerator.createPDFBuffer(docDefinition);
        const filename = `transactions_${userId}_${new Date().toISOString().slice(0, 10)}.pdf`;

        // Send via Telegram if possible
        if (process.env.BOT_TOKEN) {
            try {
                await bot.sendDocument(userId, buffer, {
                    caption: 'Your StarStore transaction statement PDF is ready for download.'
                });
                console.log('PDF sent via Telegram to user:', userId);
                return res.json({ success: true, message: 'PDF file sent to your Telegram' });
            } catch (botError) {
                console.error('Bot sendDocument failed, falling back to direct download:', botError.message);
            }
        }

        // Direct download fallback
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(buffer);
    } catch (error) {
        console.error('Error exporting transactions PDF:', error);
        res.status(500).json({ error: 'Failed to generate PDF: ' + error.message });
    }
});
```

### Export Referrals PDF Endpoint

**Location:** [server.js](server.js#L12743-L12835)

```javascript
// Export referrals as PDF (professional formatted statement)
app.post('/api/export-referrals-pdf', requireTelegramAuth, async (req, res) => {
    try {
        if (!pdfGenerator) {
            return res.status(501).json({ error: 'PDF export not available' });
        }

        const userId = req.user.id;
        const userInfo = req.user;
        
        const referrals = await Referral.find({ referrerUserId: userId })
            .sort({ dateReferred: -1 })
            .lean();

        // Generate PDF
        const docDefinition = pdfGenerator.generateReferralPDF(
            userId,
            userInfo.username,
            referrals
        );
        
        const buffer = await pdfGenerator.createPDFBuffer(docDefinition);
        const filename = `referrals_${userId}_${new Date().toISOString().slice(0, 10)}.pdf`;

        // Send via Telegram if possible
        if (process.env.BOT_TOKEN) {
            try {
                await bot.sendDocument(userId, buffer, {
                    caption: 'Your StarStore referral earnings statement PDF is ready for download.'
                });
                console.log('Referral PDF sent via Telegram to user:', userId);
                return res.json({ success: true, message: 'PDF file sent to your Telegram' });
            } catch (botError) {
                console.error('Bot sendDocument failed, falling back to direct download:', botError.message);
            }
        }

        // Direct download fallback
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(buffer);
    } catch (error) {
        console.error('Error exporting referrals PDF:', error);
        res.status(500).json({ error: 'Failed to generate PDF: ' + error.message });
    }
});
```

### Direct PDF Download Endpoints

**Location:** [server.js](server.js#L12527-L12580) and [server.js](server.js#L12837-L12850)

These endpoints (`/api/export-transactions-pdf-download` and `/api/export-referrals-pdf-download`) provide GET-based alternatives for direct downloads, useful when POST isn't available.

---

## 4. PDF Generator Service

**Location:** [services/pdf-generator.js](services/pdf-generator.js)

### Module Initialization

```javascript
/**
 * Professional PDF Statement Generator
 * Generates branded, colored PDF documents with professional banking statement design
 */

const PdfPrinter = require('pdfmake/src/printer');

// Load VFS fonts
const vfsFonts = require('pdfmake/build/vfs_fonts');
PdfPrinter.vfs = vfsFonts;

// Professional banking color scheme
const COLORS = {
  primary: '#2C3E50',        // Dark gray-blue (professional)
  success: '#27AE60',        // Green for deposits/buy
  danger: '#E74C3C',         // Red for withdrawals/sell
  warning: '#F39C12',        // Orange for processing
  info: '#3498DB',           // Blue for transfers
  lightBg: '#ECF0F1',        // Light gray background
  border: '#BDC3C7',         // Border color
  text: '#2C3E50',           // Main text
  lightText: '#7F8C8D',      // Secondary text
  white: '#FFFFFF'
};

// Fonts configuration - using default fonts
const fonts = {
  Roboto: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique'
  }
};

const printer = new PdfPrinter(fonts);
```

### Generate Transaction PDF

**Location:** [services/pdf-generator.js](services/pdf-generator.js#L44-L250)

The function creates a professional PDF with:
- Account details (User ID, Username)
- Balance summary
- Key metrics (Total Transactions, Total Earned, Total Spent)
- Transaction table with columns: Date, Time, Type, Stars, Amount (USD), Running Balance, Status
- Statement summary section
- Footer with disclaimer and support contact

### Generate Referral PDF

**Location:** [services/pdf-generator.js](services/pdf-generator.js#L350-L600)

The function creates a professional PDF with:
- Account details
- Earnings summary
- Key metrics (Total Referrals, Active Referrals, Avg Per Referral)
- Referral table with columns: Date, Time, Username, Amount, Running Total, Status
- Summary section
- Footer with support contact

### Create PDF Buffer

**Location:** [services/pdf-generator.js](services/pdf-generator.js#L612-L628)

```javascript
/**
 * Create PDF from document definition and return as buffer
 */
function createPDFBuffer(docDefinition) {
  return new Promise((resolve, reject) => {
    const pdfDoc = printer.createPdfKitDocument(docDefinition);
    const chunks = [];

    pdfDoc.on('data', (chunk) => {
      chunks.push(chunk);
    });

    pdfDoc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve(buffer);
    });

    pdfDoc.on('error', (err) => {
      reject(err);
    });

    pdfDoc.end();
  });
}
```

### Module Exports

**Location:** [services/pdf-generator.js](services/pdf-generator.js#L634-L637)

```javascript
module.exports = {
  generateTransactionPDF,
  generateReferralPDF,
  createPDFBuffer
};
```

---

## 5. Translation Strings

**Location:** [public/js/translations.js](public/js/translations.js#L492-L597)

```javascript
// English translations
exportTransactions: "Export Transactions",
exportReferrals: "Export Referrals",
download: "Download",
generatingCsv: "Generating PDF...",
generatingPdf: "Generating PDF...",

// Russian translations
exportTransactions: "Экспорт транзакций",
exportReferrals: "Экспорт рефералов",
download: "Скачать",
generatingCsv: "Генерация PDF...",
generatingPdf: "Генерация PDF...",

// Hindi translations
exportTransactions: "लेन-देन निर्यात करें",
exportReferrals: "रेफरल निर्यात करें",
download: "डाउनलोड करें",
```

---

## Error Handling Summary

### Client-Side (history.html)
1. **HTTP Status Check**: Validates `response.ok` before processing
2. **Content-Type Validation**: Checks if response is PDF or JSON
3. **JSON Error Parsing**: Attempts to parse error response as JSON to extract error message
4. **User Feedback**: Shows SweetAlert modal with error message
5. **Button State Recovery**: Restores button to original state in `finally` block

### Server-Side (server.js)
1. **PDF Generator Check**: Returns 501 if `pdfGenerator` module is not loaded
2. **Database Error Handling**: Wraps BuyOrder/SellOrder fetches in try-catch with empty fallback
3. **Order Processing**: Wraps individual order mapping in try-catch to continue on errors
4. **Error Response**: Returns 500 with descriptive error message including original error details
5. **Fallback Mechanism**: If Telegram send fails, falls back to direct download

### PDF Generator (pdf-generator.js)
1. **Promise-based**: Returns Promise that rejects on PDF generation errors
2. **Stream Error Handling**: Listens for 'error' event on PDF document
3. **Data Buffering**: Accumulates PDF chunks, concatenates when complete

---

## Dependencies

The PDF export feature requires:
- **pdfmake**: NPM package for PDF generation (uses `/pdfmake/src/printer` and `/pdfmake/build/vfs_fonts`)
- **Telegram Bot API**: Optional - attempts to send PDF via bot before falling back to direct download
- **Authentication**: Requires `requireTelegramAuth` middleware

---

## API Flow Diagram

```
Client (history.html)
  ↓
[User clicks Export Transactions/Referrals]
  ↓
[Modal dialog displayed]
  ↓
[User selects PDF format]
  ↓
POST /api/export-transactions-pdf or export-referrals-pdf
  ↓
Server (server.js)
  ├─ Verify pdfGenerator available
  ├─ Fetch data from database
  ├─ Call pdfGenerator.generateTransactionPDF/generateReferralPDF
  ├─ Create PDF buffer via createPDFBuffer
  ├─ Try: Send via Telegram bot
  └─ Fallback: Return PDF blob directly
  ↓
Client receives response
  ├─ If JSON: Show success message
  └─ If PDF blob: Trigger download via blob URL
```
