/**
 * Professional PDF Statement Generator
 * Generates branded, colored PDF documents for transactions and referrals
 */

const PdfPrinter = require('pdfmake');

// Define professional color scheme
const COLORS = {
  primary: '#2563EB',      // Professional blue
  success: '#10B981',      // Green for completed
  warning: '#F59E0B',      // Amber for processing
  danger: '#EF4444',       // Red for declined
  dark: '#1F2937',         // Dark gray for text
  light: '#F9FAFB',        // Light gray for backgrounds
  border: '#E5E7EB',       // Border gray
};

// Fonts configuration
const fonts = {
  Roboto: {
    normal: require('pdfmake/build/Roboto-Regular.js'),
    bold: require('pdfmake/build/Roboto-Bold.js'),
    italics: require('pdfmake/build/Roboto-Italic.js'),
    bolditalics: require('pdfmake/build/Roboto-BoldItalic.js')
  }
};

const printer = new PdfPrinter(fonts);

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
    second: '2-digit',
    hour12: true
  });

  const totalTransactions = transactions.length;
  const completedCount = transactions.filter(t => t.status === 'completed').length;
  const processingCount = transactions.filter(t => t.status === 'processing').length;
  const declinedCount = transactions.filter(t => t.status === 'declined').length;
  const totalStarsTraded = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
  const totalUsdtValue = transactions.reduce((sum, t) => sum + (t.usdtValue || 0), 0);
  const avgPerTransaction = totalTransactions > 0 ? totalUsdtValue / totalTransactions : 0;

  // Build transaction table rows
  const transactionRows = transactions.map((txn, index) => {
    const dateObj = new Date(txn.date);
    const dateStr = dateObj.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
    const timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    
    const statusColor = 
      txn.status === 'completed' ? COLORS.success :
      txn.status === 'processing' ? COLORS.warning :
      txn.status === 'declined' ? COLORS.danger : COLORS.dark;
    
    const statusDisplay = txn.status.charAt(0).toUpperCase() + txn.status.slice(1);
    const typeDisplay = txn.type.replace(' Stars', '');

    return [
      { text: `${dateStr}`, fontSize: 10, color: COLORS.dark },
      { text: `${timeStr}`, fontSize: 10, color: COLORS.dark },
      { text: typeDisplay, fontSize: 10, color: COLORS.dark },
      { text: txn.amount.toFixed(2), fontSize: 10, color: COLORS.dark, alignment: 'right' },
      { text: `$${txn.usdtValue.toFixed(2)}`, fontSize: 10, color: COLORS.dark, alignment: 'right', bold: true },
      { text: statusDisplay, fontSize: 10, bold: true, color: statusColor }
    ];
  });

  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 60],
    header: function(currentPage, pageCount) {
      return {
        columns: [
          {
            text: 'STARSTORE',
            fontSize: 16,
            bold: true,
            color: COLORS.primary,
            width: '70%'
          },
          {
            text: `Page ${currentPage} of ${pageCount}`,
            fontSize: 10,
            alignment: 'right',
            color: COLORS.dark
          }
        ],
        margin: [40, 20, 40, 0],
        columnGap: 10
      };
    },
    footer: function(currentPage, pageCount) {
      return {
        text: [
          { text: 'STARSTORE ', bold: true, color: COLORS.primary },
          { text: '| Your Trusted Telegram Stars Marketplace | ', color: COLORS.dark },
          { text: 'https://starstore.site', color: COLORS.primary }
        ],
        alignment: 'center',
        fontSize: 9,
        color: COLORS.dark,
        margin: [40, 10, 40, 0],
        border: [false, true, false, false],
        borderColor: COLORS.border
      };
    },
    content: [
      // Title
      {
        text: 'TRANSACTION STATEMENT',
        fontSize: 24,
        bold: true,
        color: COLORS.primary,
        margin: [0, 0, 0, 20]
      },

      // Account Info Box
      {
        table: {
          widths: ['50%', '50%'],
          body: [
            [
              { text: 'Account Holder', bold: true, color: COLORS.dark, fontSize: 10 },
              { text: username ? `@${username}` : 'Unknown', color: COLORS.dark, fontSize: 10 }
            ],
            [
              { text: 'Account ID', bold: true, color: COLORS.dark, fontSize: 10 },
              { text: userId, color: COLORS.dark, fontSize: 10 }
            ],
            [
              { text: 'Statement Date', bold: true, color: COLORS.dark, fontSize: 10 },
              { text: formattedDate, color: COLORS.dark, fontSize: 10 }
            ],
            [
              { text: 'Generated Time', bold: true, color: COLORS.dark, fontSize: 10 },
              { text: `${formattedTime} UTC`, color: COLORS.dark, fontSize: 10 }
            ]
          ]
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          hLineColor: COLORS.border,
          vLineColor: COLORS.border,
          paddingLeft: () => 10,
          paddingRight: () => 10,
          paddingTop: () => 8,
          paddingBottom: () => 8
        },
        margin: [0, 0, 0, 25]
      },

      // Summary Cards
      {
        columns: [
          {
            border: [true, true, true, true],
            borderColor: COLORS.success,
            background: '#F0FDF4',
            padding: 15,
            stack: [
              { text: 'Total Transactions', fontSize: 11, color: COLORS.dark, bold: true },
              { text: totalTransactions.toString(), fontSize: 20, bold: true, color: COLORS.success, margin: [0, 5, 0, 0] }
            ]
          },
          {
            border: [true, true, true, true],
            borderColor: COLORS.primary,
            background: '#EFF6FF',
            padding: 15,
            stack: [
              { text: 'Total USDT Value', fontSize: 11, color: COLORS.dark, bold: true },
              { text: `$${totalUsdtValue.toFixed(2)}`, fontSize: 20, bold: true, color: COLORS.primary, margin: [0, 5, 0, 0] }
            ]
          },
          {
            border: [true, true, true, true],
            borderColor: COLORS.warning,
            background: '#FFFBEB',
            padding: 15,
            stack: [
              { text: 'Stars Traded', fontSize: 11, color: COLORS.dark, bold: true },
              { text: totalStarsTraded.toFixed(2), fontSize: 20, bold: true, color: COLORS.warning, margin: [0, 5, 0, 0] }
            ]
          }
        ],
        gap: 10,
        margin: [0, 0, 0, 25]
      },

      // Status breakdown
      {
        columns: [
          {
            width: '25%',
            stack: [
              { text: 'Completed', fontSize: 10, bold: true, color: COLORS.dark },
              { text: completedCount.toString(), fontSize: 16, bold: true, color: COLORS.success, margin: [0, 5, 0, 0] }
            ]
          },
          {
            width: '25%',
            stack: [
              { text: 'Processing', fontSize: 10, bold: true, color: COLORS.dark },
              { text: processingCount.toString(), fontSize: 16, bold: true, color: COLORS.warning, margin: [0, 5, 0, 0] }
            ]
          },
          {
            width: '25%',
            stack: [
              { text: 'Declined', fontSize: 10, bold: true, color: COLORS.dark },
              { text: declinedCount.toString(), fontSize: 16, bold: true, color: COLORS.danger, margin: [0, 5, 0, 0] }
            ]
          },
          {
            width: '25%',
            stack: [
              { text: 'Average', fontSize: 10, bold: true, color: COLORS.dark },
              { text: `$${avgPerTransaction.toFixed(2)}`, fontSize: 16, bold: true, color: COLORS.primary, margin: [0, 5, 0, 0] }
            ]
          }
        ],
        margin: [0, 0, 0, 25]
      },

      // Transactions Table
      {
        text: 'TRANSACTION DETAILS',
        fontSize: 14,
        bold: true,
        color: COLORS.dark,
        margin: [0, 0, 0, 12]
      },
      {
        table: {
          headerRows: 1,
          widths: ['12%', '12%', '15%', '15%', '15%', '15%'],
          body: [
            [
              { text: 'Date', bold: true, color: '#fff', fontSize: 10, background: COLORS.primary, alignment: 'center' },
              { text: 'Time', bold: true, color: '#fff', fontSize: 10, background: COLORS.primary, alignment: 'center' },
              { text: 'Type', bold: true, color: '#fff', fontSize: 10, background: COLORS.primary, alignment: 'center' },
              { text: 'Stars', bold: true, color: '#fff', fontSize: 10, background: COLORS.primary, alignment: 'center' },
              { text: 'Amount (USD)', bold: true, color: '#fff', fontSize: 10, background: COLORS.primary, alignment: 'center' },
              { text: 'Status', bold: true, color: '#fff', fontSize: 10, background: COLORS.primary, alignment: 'center' }
            ],
            ...transactionRows
          ]
        },
        layout: {
          hLineWidth: (i) => i === 0 ? 2 : 0.5,
          vLineWidth: () => 0.5,
          hLineColor: COLORS.border,
          vLineColor: COLORS.border,
          paddingLeft: () => 8,
          paddingRight: () => 8,
          paddingTop: () => 6,
          paddingBottom: () => 6,
          fillColor: (i) => i > 0 && i % 2 === 0 ? COLORS.light : null
        },
        margin: [0, 0, 0, 30]
      },

      // Footer summary
      {
        border: [true, true, true, true],
        borderColor: COLORS.primary,
        padding: 15,
        stack: [
          {
            columns: [
              { text: 'Total Stars Traded:', fontSize: 12, bold: true, color: COLORS.dark, width: '70%' },
              { text: totalStarsTraded.toFixed(2), fontSize: 12, bold: true, color: COLORS.primary, width: '30%', alignment: 'right' }
            ]
          },
          {
            columns: [
              { text: 'Total USDT Value:', fontSize: 12, bold: true, color: COLORS.dark, width: '70%' },
              { text: `$${totalUsdtValue.toFixed(2)}`, fontSize: 12, bold: true, color: COLORS.success, width: '30%', alignment: 'right' }
            ],
            margin: [0, 5, 0, 0]
          }
        ]
      },

      // Disclaimer
      {
        text: [
          { text: 'OFFICIAL STATEMENT: ', bold: true, color: COLORS.dark, fontSize: 10 },
          { text: 'This is an official StarStore transaction record. For support or disputes, contact ', color: COLORS.dark, fontSize: 9 },
          { text: 'support@starstore.site', bold: true, color: COLORS.primary, fontSize: 9 },
          { text: ' or visit ', color: COLORS.dark, fontSize: 9 },
          { text: 'https://starstore.site', color: COLORS.primary, fontSize: 9, link: 'https://starstore.site' }
        ],
        margin: [0, 25, 0, 0],
        border: [true, true, true, true],
        borderColor: COLORS.border,
        padding: 12,
        background: COLORS.light,
        fontSize: 9
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
    second: '2-digit',
    hour12: true
  });

  const totalReferrals = referrals.length;
  const activeCount = referrals.filter(r => r.status === 'active').length;
  const inactiveCount = referrals.filter(r => r.status !== 'active').length;
  const totalEarnings = referrals.reduce((sum, r) => sum + (r.amount || 0), 0);
  const avgPerReferral = totalReferrals > 0 ? totalEarnings / totalReferrals : 0;

  // Build referral table rows
  const referralRows = referrals.map((ref) => {
    const dateObj = new Date(ref.dateReferred);
    const dateStr = dateObj.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
    const timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    
    const statusColor = ref.status === 'active' ? COLORS.success : COLORS.warning;
    const statusDisplay = ref.status.charAt(0).toUpperCase() + ref.status.slice(1);

    return [
      { text: dateStr, fontSize: 10, color: COLORS.dark },
      { text: timeStr, fontSize: 10, color: COLORS.dark },
      { text: ref.referredUsername || 'Unknown', fontSize: 10, color: COLORS.dark },
      { text: `$${(ref.amount || 0).toFixed(2)}`, fontSize: 10, color: COLORS.dark, alignment: 'right', bold: true },
      { text: statusDisplay, fontSize: 10, bold: true, color: statusColor }
    ];
  });

  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 60],
    header: function(currentPage, pageCount) {
      return {
        columns: [
          {
            text: 'STARSTORE',
            fontSize: 16,
            bold: true,
            color: COLORS.primary,
            width: '70%'
          },
          {
            text: `Page ${currentPage} of ${pageCount}`,
            fontSize: 10,
            alignment: 'right',
            color: COLORS.dark
          }
        ],
        margin: [40, 20, 40, 0],
        columnGap: 10
      };
    },
    footer: function(currentPage, pageCount) {
      return {
        text: [
          { text: 'STARSTORE ', bold: true, color: COLORS.primary },
          { text: '| Your Trusted Telegram Stars Marketplace | ', color: COLORS.dark },
          { text: 'https://starstore.site', color: COLORS.primary }
        ],
        alignment: 'center',
        fontSize: 9,
        color: COLORS.dark,
        margin: [40, 10, 40, 0],
        border: [false, true, false, false],
        borderColor: COLORS.border
      };
    },
    content: [
      // Title
      {
        text: 'REFERRAL EARNINGS STATEMENT',
        fontSize: 24,
        bold: true,
        color: COLORS.primary,
        margin: [0, 0, 0, 20]
      },

      // Account Info Box
      {
        table: {
          widths: ['50%', '50%'],
          body: [
            [
              { text: 'Account Holder', bold: true, color: COLORS.dark, fontSize: 10 },
              { text: username ? `@${username}` : 'Unknown', color: COLORS.dark, fontSize: 10 }
            ],
            [
              { text: 'Account ID', bold: true, color: COLORS.dark, fontSize: 10 },
              { text: userId, color: COLORS.dark, fontSize: 10 }
            ],
            [
              { text: 'Statement Date', bold: true, color: COLORS.dark, fontSize: 10 },
              { text: formattedDate, color: COLORS.dark, fontSize: 10 }
            ],
            [
              { text: 'Generated Time', bold: true, color: COLORS.dark, fontSize: 10 },
              { text: `${formattedTime} UTC`, color: COLORS.dark, fontSize: 10 }
            ]
          ]
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          hLineColor: COLORS.border,
          vLineColor: COLORS.border,
          paddingLeft: () => 10,
          paddingRight: () => 10,
          paddingTop: () => 8,
          paddingBottom: () => 8
        },
        margin: [0, 0, 0, 25]
      },

      // Summary Cards
      {
        columns: [
          {
            border: [true, true, true, true],
            borderColor: COLORS.success,
            background: '#F0FDF4',
            padding: 15,
            stack: [
              { text: 'Total Referrals', fontSize: 11, color: COLORS.dark, bold: true },
              { text: totalReferrals.toString(), fontSize: 20, bold: true, color: COLORS.success, margin: [0, 5, 0, 0] }
            ]
          },
          {
            border: [true, true, true, true],
            borderColor: COLORS.primary,
            background: '#EFF6FF',
            padding: 15,
            stack: [
              { text: 'Total Earnings', fontSize: 11, color: COLORS.dark, bold: true },
              { text: `$${totalEarnings.toFixed(2)}`, fontSize: 20, bold: true, color: COLORS.primary, margin: [0, 5, 0, 0] }
            ]
          },
          {
            border: [true, true, true, true],
            borderColor: COLORS.warning,
            background: '#FFFBEB',
            padding: 15,
            stack: [
              { text: 'Active Referrals', fontSize: 11, color: COLORS.dark, bold: true },
              { text: activeCount.toString(), fontSize: 20, bold: true, color: COLORS.warning, margin: [0, 5, 0, 0] }
            ]
          }
        ],
        gap: 10,
        margin: [0, 0, 0, 25]
      },

      // Additional metrics
      {
        columns: [
          {
            width: '33%',
            stack: [
              { text: 'Active', fontSize: 10, bold: true, color: COLORS.dark },
              { text: activeCount.toString(), fontSize: 16, bold: true, color: COLORS.success, margin: [0, 5, 0, 0] }
            ]
          },
          {
            width: '33%',
            stack: [
              { text: 'Inactive', fontSize: 10, bold: true, color: COLORS.dark },
              { text: inactiveCount.toString(), fontSize: 16, bold: true, color: COLORS.warning, margin: [0, 5, 0, 0] }
            ]
          },
          {
            width: '33%',
            stack: [
              { text: 'Avg Per Referral', fontSize: 10, bold: true, color: COLORS.dark },
              { text: `$${avgPerReferral.toFixed(2)}`, fontSize: 16, bold: true, color: COLORS.primary, margin: [0, 5, 0, 0] }
            ]
          }
        ],
        margin: [0, 0, 0, 25]
      },

      // Referrals Table
      {
        text: 'REFERRAL DETAILS',
        fontSize: 14,
        bold: true,
        color: COLORS.dark,
        margin: [0, 0, 0, 12]
      },
      {
        table: {
          headerRows: 1,
          widths: ['15%', '15%', '30%', '20%', '20%'],
          body: [
            [
              { text: 'Date', bold: true, color: '#fff', fontSize: 10, background: COLORS.primary, alignment: 'center' },
              { text: 'Time', bold: true, color: '#fff', fontSize: 10, background: COLORS.primary, alignment: 'center' },
              { text: 'Referred User', bold: true, color: '#fff', fontSize: 10, background: COLORS.primary, alignment: 'center' },
              { text: 'Earnings', bold: true, color: '#fff', fontSize: 10, background: COLORS.primary, alignment: 'center' },
              { text: 'Status', bold: true, color: '#fff', fontSize: 10, background: COLORS.primary, alignment: 'center' }
            ],
            ...referralRows
          ]
        },
        layout: {
          hLineWidth: (i) => i === 0 ? 2 : 0.5,
          vLineWidth: () => 0.5,
          hLineColor: COLORS.border,
          vLineColor: COLORS.border,
          paddingLeft: () => 8,
          paddingRight: () => 8,
          paddingTop: () => 6,
          paddingBottom: () => 6,
          fillColor: (i) => i > 0 && i % 2 === 0 ? COLORS.light : null
        },
        margin: [0, 0, 0, 30]
      },

      // Footer summary
      {
        border: [true, true, true, true],
        borderColor: COLORS.primary,
        padding: 15,
        stack: [
          {
            columns: [
              { text: 'Total Referrals:', fontSize: 12, bold: true, color: COLORS.dark, width: '70%' },
              { text: totalReferrals.toString(), fontSize: 12, bold: true, color: COLORS.primary, width: '30%', alignment: 'right' }
            ]
          },
          {
            columns: [
              { text: 'Total Earnings:', fontSize: 12, bold: true, color: COLORS.dark, width: '70%' },
              { text: `$${totalEarnings.toFixed(2)}`, fontSize: 12, bold: true, color: COLORS.success, width: '30%', alignment: 'right' }
            ],
            margin: [0, 5, 0, 0]
          }
        ]
      },

      // Disclaimer
      {
        text: [
          { text: 'OFFICIAL STATEMENT: ', bold: true, color: COLORS.dark, fontSize: 10 },
          { text: 'This is an official StarStore referral earnings record. For support or disputes, contact ', color: COLORS.dark, fontSize: 9 },
          { text: 'support@starstore.site', bold: true, color: COLORS.primary, fontSize: 9 },
          { text: ' or visit ', color: COLORS.dark, fontSize: 9 },
          { text: 'https://starstore.site', color: COLORS.primary, fontSize: 9, link: 'https://starstore.site' }
        ],
        margin: [0, 25, 0, 0],
        border: [true, true, true, true],
        borderColor: COLORS.border,
        padding: 12,
        background: COLORS.light,
        fontSize: 9
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
