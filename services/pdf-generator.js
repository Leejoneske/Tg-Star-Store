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

/**
 * Calculate running balance through transactions
 */
function calculateRunningBalance(transactions) {
  let balance = 0;
  return transactions.map(txn => {
    const amount = txn.type.includes('Buy') ? txn.usdtValue : -txn.usdtValue;
    balance += amount;
    return { ...txn, runningBalance: balance };
  });
}

/**
 * Generate professional transaction statement PDF
 */
function generateTransactionPDF(userId, username, transactions) {
  const now = new Date();
  const formattedDate = now.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  const formattedTime = now.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: true
  });

  // Calculate totals and running balances
  const transactionsWithBalance = calculateRunningBalance(transactions);
  const totalTransactions = transactions.length;
  const buyCount = transactions.filter(t => t.type.includes('Buy')).length;
  const sellCount = transactions.filter(t => t.type.includes('Sell')).length;
  const completedCount = transactions.filter(t => t.status === 'completed').length;
  const totalStarsTraded = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
  const totalSpent = transactions.filter(t => t.type.includes('Buy')).reduce((sum, t) => sum + (t.usdtValue || 0), 0);
  const totalEarned = transactions.filter(t => t.type.includes('Sell')).reduce((sum, t) => sum + (t.usdtValue || 0), 0);
  const finalBalance = totalEarned - totalSpent;

  // Build transaction rows with running balance
  const transactionRows = transactionsWithBalance.map((txn) => {
    const dateObj = new Date(txn.date);
    const dateStr = dateObj.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
    const timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    
    const isBuy = txn.type.includes('Buy');
    const typeColor = isBuy ? COLORS.danger : COLORS.success;
    const typeDisplay = isBuy ? 'Buy Stars' : 'Sell Stars';
    const statusColor = 
      txn.status === 'completed' ? COLORS.success :
      txn.status === 'processing' ? COLORS.warning :
      COLORS.danger;

    return [
      { text: `${dateStr}`, fontSize: 9, color: COLORS.text, alignment: 'center' },
      { text: `${timeStr}`, fontSize: 9, color: COLORS.lightText },
      { text: typeDisplay, fontSize: 9, bold: true, color: typeColor },
      { text: `${txn.amount.toFixed(2)} ★`, fontSize: 9, color: COLORS.text, alignment: 'right' },
      { text: `$${txn.usdtValue.toFixed(2)}`, fontSize: 9, bold: true, color: typeColor, alignment: 'right' },
      { text: `$${txn.runningBalance.toFixed(2)}`, fontSize: 9, bold: true, color: txn.runningBalance >= 0 ? COLORS.success : COLORS.danger, alignment: 'right' },
      { text: txn.status.charAt(0).toUpperCase() + txn.status.slice(1), fontSize: 8, bold: true, color: statusColor, alignment: 'center' }
    ];
  });

  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [30, 50, 30, 60],
    header: function(currentPage, pageCount) {
      if (currentPage === 1) {
        return {
          text: 'STARSTORE',
          fontSize: 28,
          bold: true,
          color: COLORS.primary,
          alignment: 'left',
          margin: [30, 15, 0, 0]
        };
      }
      return null;
    },
    footer: function(currentPage, pageCount) {
      return {
        columns: [
          {
            text: `Page ${currentPage} of ${pageCount}`,
            fontSize: 8,
            color: COLORS.lightText,
            alignment: 'right'
          }
        ],
        margin: [30, 10, 30, 10],
        border: [false, true, false, false],
        borderColor: COLORS.border
      };
    },
    content: [
      // Title and subtitle
      {
        text: 'TRANSACTION STATEMENT',
        fontSize: 16,
        bold: true,
        color: COLORS.primary,
        margin: [0, 5, 0, 3]
      },
      {
        text: `Statement Period: All Transactions | Generated: ${formattedDate} at ${formattedTime}`,
        fontSize: 10,
        color: COLORS.lightText,
        margin: [0, 0, 0, 20]
      },

      // Account Summary Box
      {
        border: [true, true, true, true],
        borderColor: COLORS.border,
        borderWidth: 1,
        background: COLORS.lightBg,
        padding: [15, 15, 15, 15],
        margin: [0, 0, 0, 20],
        columns: [
          {
            width: '50%',
            stack: [
              { text: 'Account Details', fontSize: 10, bold: true, color: COLORS.primary, margin: [0, 0, 0, 8] },
              { text: `Username: ${username ? '@' + username : 'Unknown'}`, fontSize: 9, color: COLORS.text },
              { text: `User ID: ${userId}`, fontSize: 9, color: COLORS.text, margin: [0, 2, 0, 0] }
            ]
          },
          {
            width: '50%',
            stack: [
              { text: 'Balance Summary', fontSize: 10, bold: true, color: COLORS.primary, margin: [0, 0, 0, 8] },
              {
                columns: [
                  { text: 'Current Balance:', fontSize: 9, color: COLORS.text, width: '70%' },
                  { text: `$${finalBalance.toFixed(2)}`, fontSize: 10, bold: true, color: finalBalance >= 0 ? COLORS.success : COLORS.danger, width: '30%', alignment: 'right' }
                ]
              }
            ]
          }
        ]
      },

      // Key Metrics
      {
        columns: [
          {
            border: [true, true, true, true],
            borderColor: COLORS.info,
            borderWidth: 1,
            background: '#EBF5FB',
            padding: 12,
            stack: [
              { text: 'Total Transactions', fontSize: 9, color: COLORS.lightText, bold: true },
              { text: totalTransactions.toString(), fontSize: 18, bold: true, color: COLORS.info, margin: [0, 3, 0, 0] }
            ]
          },
          {
            border: [true, true, true, true],
            borderColor: COLORS.success,
            borderWidth: 1,
            background: '#EAFAF1',
            padding: 12,
            stack: [
              { text: 'Total Earned', fontSize: 9, color: COLORS.lightText, bold: true },
              { text: `$${totalEarned.toFixed(2)}`, fontSize: 18, bold: true, color: COLORS.success, margin: [0, 3, 0, 0] }
            ]
          },
          {
            border: [true, true, true, true],
            borderColor: COLORS.danger,
            borderWidth: 1,
            background: '#FADBD8',
            padding: 12,
            stack: [
              { text: 'Total Spent', fontSize: 9, color: COLORS.lightText, bold: true },
              { text: `$${totalSpent.toFixed(2)}`, fontSize: 18, bold: true, color: COLORS.danger, margin: [0, 3, 0, 0] }
            ]
          }
        ],
        gap: 8,
        margin: [0, 0, 0, 20]
      },

      // Transaction Details Section
      {
        text: 'TRANSACTION DETAILS',
        fontSize: 12,
        bold: true,
        color: COLORS.primary,
        margin: [0, 0, 0, 10]
      },
      {
        table: {
          headerRows: 1,
          widths: ['9%', '10%', '12%', '13%', '13%', '15%', '10%'],
          dontBreakRows: false,
          body: [
            [
              { text: 'Date', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'center', padding: [5, 3, 5, 3] },
              { text: 'Time', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'center', padding: [5, 3, 5, 3] },
              { text: 'Type', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'center', padding: [5, 3, 5, 3] },
              { text: 'Stars', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'center', padding: [5, 3, 5, 3] },
              { text: 'Amount (USD)', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'center', padding: [5, 3, 5, 3] },
              { text: 'Running Balance', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'center', padding: [5, 3, 5, 3] },
              { text: 'Status', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'center', padding: [5, 3, 5, 3] }
            ],
            ...transactionRows
          ]
        },
        layout: {
          hLineWidth: (i) => i === 0 ? 2 : 0.5,
          vLineWidth: () => 0.5,
          hLineColor: COLORS.border,
          vLineColor: COLORS.border,
          paddingLeft: () => 5,
          paddingRight: () => 5,
          paddingTop: () => 4,
          paddingBottom: () => 4,
          fillColor: (i, node) => i > 0 && i % 2 === 0 ? COLORS.lightBg : null
        },
        margin: [0, 0, 0, 20]
      },

      // Summary Section
      {
        border: [true, true, true, true],
        borderColor: COLORS.primary,
        borderWidth: 2,
        background: '#F8F9FA',
        padding: 15,
        stack: [
          {
            text: 'STATEMENT SUMMARY',
            fontSize: 11,
            bold: true,
            color: COLORS.primary,
            margin: [0, 0, 0, 10]
          },
          {
            columns: [
              { text: 'Buy Transactions:', fontSize: 10, color: COLORS.text },
              { text: `${buyCount}`, fontSize: 10, bold: true, color: COLORS.danger, alignment: 'right' }
            ],
            margin: [0, 3, 0, 0]
          },
          {
            columns: [
              { text: 'Sell Transactions:', fontSize: 10, color: COLORS.text },
              { text: `${sellCount}`, fontSize: 10, bold: true, color: COLORS.success, alignment: 'right' }
            ],
            margin: [0, 3, 0, 0]
          },
          {
            columns: [
              { text: 'Completed:', fontSize: 10, color: COLORS.text },
              { text: `${completedCount}/${totalTransactions}`, fontSize: 10, bold: true, color: COLORS.success, alignment: 'right' }
            ],
            margin: [0, 3, 0, 0]
          },
          { text: '', margin: [0, 5, 0, 0] },
          {
            columns: [
              { text: 'Total Stars Traded:', fontSize: 11, bold: true, color: COLORS.primary },
              { text: `${totalStarsTraded.toFixed(2)} ★`, fontSize: 11, bold: true, color: COLORS.primary, alignment: 'right' }
            ]
          },
          {
            columns: [
              { text: 'Net Balance:', fontSize: 11, bold: true, color: COLORS.primary },
              { text: `$${finalBalance.toFixed(2)}`, fontSize: 11, bold: true, color: finalBalance >= 0 ? COLORS.success : COLORS.danger, alignment: 'right' }
            ],
            margin: [0, 3, 0, 0]
          }
        ]
      },

      // Footer disclaimer
      {
        text: [
          { text: 'OFFICIAL STATEMENT\n', bold: true, fontSize: 9, color: COLORS.primary },
          { text: 'This is an official StarStore transaction record. Keep this statement for your records.\n', fontSize: 8, color: COLORS.text },
          { text: 'For support: ', fontSize: 8, color: COLORS.text },
          { text: 'support@starstore.site ', bold: true, fontSize: 8, color: COLORS.info },
          { text: '| ', fontSize: 8, color: COLORS.text },
          { text: 'https://starstore.site', fontSize: 8, color: COLORS.info }
        ],
        margin: [0, 25, 0, 0],
        border: [true, true, true, true],
        borderColor: COLORS.border,
        padding: 12,
        background: COLORS.lightBg,
        alignment: 'center'
      }
    ]
  };

  return docDefinition;
}

/**
 * Generate professional referral earnings statement PDF
 */
function generateReferralPDF(userId, username, referrals) {
  const now = new Date();
  const formattedDate = now.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  const formattedTime = now.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: true
  });

  const totalReferrals = referrals.length;
  const activeCount = referrals.filter(r => r.status === 'active').length;
  const inactiveCount = referrals.filter(r => r.status !== 'active').length;
  const totalEarnings = referrals.reduce((sum, r) => sum + (r.amount || 0), 0);
  const avgPerReferral = totalReferrals > 0 ? totalEarnings / totalReferrals : 0;

  // Build referral table rows with running total
  let runningTotal = 0;
  const referralRows = referrals.map((ref) => {
    runningTotal += ref.amount || 0;
    const dateObj = new Date(ref.dateReferred);
    const dateStr = dateObj.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
    const timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    
    const statusColor = ref.status === 'active' ? COLORS.success : COLORS.warning;
    const statusDisplay = ref.status.charAt(0).toUpperCase() + ref.status.slice(1);

    return [
      { text: dateStr, fontSize: 9, color: COLORS.text, alignment: 'center' },
      { text: timeStr, fontSize: 9, color: COLORS.lightText },
      { text: ref.referredUsername || 'Unknown', fontSize: 9, color: COLORS.text },
      { text: `$${(ref.amount || 0).toFixed(2)}`, fontSize: 9, bold: true, color: COLORS.success, alignment: 'right' },
      { text: `$${runningTotal.toFixed(2)}`, fontSize: 9, bold: true, color: COLORS.info, alignment: 'right' },
      { text: statusDisplay, fontSize: 8, bold: true, color: statusColor, alignment: 'center' }
    ];
  });

  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [30, 50, 30, 60],
    header: function(currentPage, pageCount) {
      if (currentPage === 1) {
        return {
          text: 'STARSTORE',
          fontSize: 28,
          bold: true,
          color: COLORS.primary,
          alignment: 'left',
          margin: [30, 15, 0, 0]
        };
      }
      return null;
    },
    footer: function(currentPage, pageCount) {
      return {
        columns: [
          {
            text: `Page ${currentPage} of ${pageCount}`,
            fontSize: 8,
            color: COLORS.lightText,
            alignment: 'right'
          }
        ],
        margin: [30, 10, 30, 10],
        border: [false, true, false, false],
        borderColor: COLORS.border
      };
    },
    content: [
      // Title and subtitle
      {
        text: 'REFERRAL EARNINGS STATEMENT',
        fontSize: 16,
        bold: true,
        color: COLORS.primary,
        margin: [0, 5, 0, 3]
      },
      {
        text: `Statement Period: All Referrals | Generated: ${formattedDate} at ${formattedTime}`,
        fontSize: 10,
        color: COLORS.lightText,
        margin: [0, 0, 0, 20]
      },

      // Account Summary Box
      {
        border: [true, true, true, true],
        borderColor: COLORS.border,
        borderWidth: 1,
        background: COLORS.lightBg,
        padding: [15, 15, 15, 15],
        margin: [0, 0, 0, 20],
        columns: [
          {
            width: '50%',
            stack: [
              { text: 'Account Details', fontSize: 10, bold: true, color: COLORS.primary, margin: [0, 0, 0, 8] },
              { text: `Username: ${username ? '@' + username : 'Unknown'}`, fontSize: 9, color: COLORS.text },
              { text: `User ID: ${userId}`, fontSize: 9, color: COLORS.text, margin: [0, 2, 0, 0] }
            ]
          },
          {
            width: '50%',
            stack: [
              { text: 'Earnings Summary', fontSize: 10, bold: true, color: COLORS.primary, margin: [0, 0, 0, 8] },
              {
                columns: [
                  { text: 'Total Earnings:', fontSize: 9, color: COLORS.text, width: '70%' },
                  { text: `$${totalEarnings.toFixed(2)}`, fontSize: 10, bold: true, color: COLORS.success, width: '30%', alignment: 'right' }
                ]
              }
            ]
          }
        ]
      },

      // Key Metrics
      {
        columns: [
          {
            border: [true, true, true, true],
            borderColor: COLORS.info,
            borderWidth: 1,
            background: '#EBF5FB',
            padding: 12,
            stack: [
              { text: 'Total Referrals', fontSize: 9, color: COLORS.lightText, bold: true },
              { text: totalReferrals.toString(), fontSize: 18, bold: true, color: COLORS.info, margin: [0, 3, 0, 0] }
            ]
          },
          {
            border: [true, true, true, true],
            borderColor: COLORS.success,
            borderWidth: 1,
            background: '#EAFAF1',
            padding: 12,
            stack: [
              { text: 'Active Referrals', fontSize: 9, color: COLORS.lightText, bold: true },
              { text: activeCount.toString(), fontSize: 18, bold: true, color: COLORS.success, margin: [0, 3, 0, 0] }
            ]
          },
          {
            border: [true, true, true, true],
            borderColor: COLORS.warning,
            borderWidth: 1,
            background: '#FEF5E7',
            padding: 12,
            stack: [
              { text: 'Avg Per Referral', fontSize: 9, color: COLORS.lightText, bold: true },
              { text: `$${avgPerReferral.toFixed(2)}`, fontSize: 16, bold: true, color: COLORS.warning, margin: [0, 3, 0, 0] }
            ]
          }
        ],
        gap: 8,
        margin: [0, 0, 0, 20]
      },

      // Referral Details Section
      {
        text: 'REFERRAL DETAILS',
        fontSize: 12,
        bold: true,
        color: COLORS.primary,
        margin: [0, 0, 0, 10]
      },
      {
        table: {
          headerRows: 1,
          widths: ['12%', '10%', '20%', '14%', '18%', '12%'],
          dontBreakRows: false,
          body: [
            [
              { text: 'Date', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'center', padding: [5, 3, 5, 3] },
              { text: 'Time', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'center', padding: [5, 3, 5, 3] },
              { text: 'Referred User', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'left', padding: [5, 3, 5, 3] },
              { text: 'Earnings', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'center', padding: [5, 3, 5, 3] },
              { text: 'Running Total', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'center', padding: [5, 3, 5, 3] },
              { text: 'Status', bold: true, color: COLORS.white, fontSize: 9, background: COLORS.primary, alignment: 'center', padding: [5, 3, 5, 3] }
            ],
            ...referralRows
          ]
        },
        layout: {
          hLineWidth: (i) => i === 0 ? 2 : 0.5,
          vLineWidth: () => 0.5,
          hLineColor: COLORS.border,
          vLineColor: COLORS.border,
          paddingLeft: () => 5,
          paddingRight: () => 5,
          paddingTop: () => 4,
          paddingBottom: () => 4,
          fillColor: (i, node) => i > 0 && i % 2 === 0 ? COLORS.lightBg : null
        },
        margin: [0, 0, 0, 20]
      },

      // Summary Section
      {
        border: [true, true, true, true],
        borderColor: COLORS.primary,
        borderWidth: 2,
        background: '#F8F9FA',
        padding: 15,
        stack: [
          {
            text: 'EARNINGS SUMMARY',
            fontSize: 11,
            bold: true,
            color: COLORS.primary,
            margin: [0, 0, 0, 10]
          },
          {
            columns: [
              { text: 'Active Referrals:', fontSize: 10, color: COLORS.text },
              { text: `${activeCount}`, fontSize: 10, bold: true, color: COLORS.success, alignment: 'right' }
            ],
            margin: [0, 3, 0, 0]
          },
          {
            columns: [
              { text: 'Inactive Referrals:', fontSize: 10, color: COLORS.text },
              { text: `${inactiveCount}`, fontSize: 10, bold: true, color: COLORS.warning, alignment: 'right' }
            ],
            margin: [0, 3, 0, 0]
          },
          { text: '', margin: [0, 5, 0, 0] },
          {
            columns: [
              { text: 'Total Referrals:', fontSize: 11, bold: true, color: COLORS.primary },
              { text: totalReferrals.toString(), fontSize: 11, bold: true, color: COLORS.primary, alignment: 'right' }
            ]
          },
          {
            columns: [
              { text: 'Total Earnings:', fontSize: 11, bold: true, color: COLORS.primary },
              { text: `$${totalEarnings.toFixed(2)}`, fontSize: 11, bold: true, color: COLORS.success, alignment: 'right' }
            ],
            margin: [0, 3, 0, 0]
          }
        ]
      },

      // Footer disclaimer
      {
        text: [
          { text: 'OFFICIAL STATEMENT\n', bold: true, fontSize: 9, color: COLORS.primary },
          { text: 'This is an official StarStore referral earnings record. Keep this statement for your records.\n', fontSize: 8, color: COLORS.text },
          { text: 'For support: ', fontSize: 8, color: COLORS.text },
          { text: 'support@starstore.site ', bold: true, fontSize: 8, color: COLORS.info },
          { text: '| ', fontSize: 8, color: COLORS.text },
          { text: 'https://starstore.site', fontSize: 8, color: COLORS.info }
        ],
        margin: [0, 25, 0, 0],
        border: [true, true, true, true],
        borderColor: COLORS.border,
        padding: 12,
        background: COLORS.lightBg,
        alignment: 'center'
      }
    ]
  };

  return docDefinition;
}

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

module.exports = {
  generateTransactionPDF,
  generateReferralPDF,
  createPDFBuffer
};
