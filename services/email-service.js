/**
 * Email Service using Resend API
 * Handles all email notifications for ambassador program, newsletter, and system events
 * Requires: RESEND_API_KEY environment variable
 * Gracefully fails if API key is not available
 */

let resend = null;
let emailAvailable = false;

// Initialize Resend API
try {
    if (process.env.RESEND_API_KEY) {
        const { Resend } = require('resend');
        resend = new Resend(process.env.RESEND_API_KEY);
        emailAvailable = true;
        console.log('✓ Resend email service initialized');
    } else {
        console.warn('⚠️ RESEND_API_KEY not set - email notifications disabled');
    }
} catch (error) {
    console.error('Failed to initialize Resend service:', error.message);
    console.warn('Email notifications will be disabled');
}

/**
 * Helper function to generate email headers and footer HTML
 */
function getEmailTemplate(title, content) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #333; line-height: 1.6; }
        .container { max-width: 600px; margin: 0 auto; padding: 0; }
        .header { background-color: #f8f9fa; padding: 32px 24px; text-align: center; border-bottom: 1px solid #e9ecef; }
        .header h1 { margin: 0; font-size: 24px; color: #212529; font-weight: 600; }
        .logo { font-size: 12px; color: #6c757d; margin-top: 8px; }
        .content { padding: 32px 24px; }
        .content h2 { font-size: 18px; color: #212529; margin: 0 0 16px 0; font-weight: 600; }
        .content p { margin: 0 0 16px 0; color: #495057; }
        .footer { background-color: #f8f9fa; padding: 24px; text-align: center; border-top: 1px solid #e9ecef; }
        .footer p { margin: 0; font-size: 12px; color: #6c757d; }
        .cta-button { display: inline-block; padding: 10px 24px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px; margin: 16px 0; font-weight: 500; }
        .highlight { color: #007bff; font-weight: 500; }
        .success-box { background-color: #f0f7ff; border-left: 4px solid #007bff; padding: 16px; margin: 16px 0; }
        .info-box { background-color: #f8f9fa; border-left: 4px solid #6c757d; padding: 16px; margin: 16px 0; }
        .divider { border-top: 1px solid #e9ecef; margin: 24px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${title}</h1>
            <div class="logo">StarStore Ambassador Program</div>
        </div>
        <div class="content">
            ${content}
        </div>
        <div class="footer">
            <p>StarStore | Professional Trading Platform</p>
            <p style="margin-top: 8px; color: #999;">© 2024 StarStore. All rights reserved.</p>
        </div>
    </div>
</body>
</html>
    `;
}

/**
 * Send notification email
 */
async function sendEmail(to, subject, htmlContent) {
    if (!emailAvailable || !resend) {
        console.log(`📧 [OFFLINE] Email not sent to ${to}: ${subject}`);
        return { success: false, reason: 'Email service not available', offline: true };
    }

    try {
        const result = await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'StarStore <noreply@starstore.app>',
            to,
            subject,
            html: htmlContent,
            reply_to: 'support@starstore.app'
        });

        if (result.error) {
            console.error(`❌ Email failed: ${result.error.message}`);
            return { success: false, error: result.error.message };
        }

        console.log(`✓ Email sent to ${to}: ${subject}`);
        return { success: true, messageId: result.data.id };
    } catch (error) {
        console.error(`❌ Error sending email: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Ambassador Application Submitted - Notify User
 */
async function sendAmbassadorApplicationSubmitted(email, username, socialLinks) {
    const content = `
<h2>Application Received</h2>
<p>Hi ${username || 'there'},</p>
<p>We've received your application for the StarStore Ambassador Program. Our team will review it and get back to you soon.</p>
<div class="info-box">
    <p><strong>What's next?</strong></p>
    <p>Our admins will review your application, social links, and engagement. You'll receive a notification once a decision has been made.</p>
</div>
<p>In the meantime, feel free to explore the platform and familiarize yourself with our features.</p>
<p>Questions? Contact our support team anytime.</p>
<p style="margin-top: 24px; font-size: 12px; color: #6c757d;">Application submitted: ${new Date().toLocaleString()}</p>
    `;
    
    return sendEmail(email, 'Ambassador Application Received - StarStore', getEmailTemplate('Application Received', content));
}

/**
 * Ambassador Application Denied - Notify User
 */
async function sendAmbassadorApplicationDenied(email, username) {
    const content = `
<h2>Application Status Update</h2>
<p>Hi ${username || 'there'},</p>
<p>Thank you for applying for the StarStore Ambassador Program. After careful review, we've decided not to move forward with your application at this time.</p>
<div class="info-box">
    <p>This doesn't mean your application was rejected permanently. Feel free to reapply in the future as you build your presence on social platforms and increase your engagement with the community.</p>
</div>
<p>We appreciate your interest and hope to work together in the future.</p>
<p style="margin-top: 24px; font-size: 12px; color: #6c757d;">If you have questions, please contact our support team.</p>
    `;
    
    return sendEmail(email, 'Ambassador Application Status - StarStore', getEmailTemplate('Application Update', content));
}

/**
 * Ambassador Approved - Notify User
 */
async function sendAmbassadorApproved(email, username, referralCode) {
    const content = `
<h2>Congratulations!</h2>
<p>Hi ${username || 'there'},</p>
<p>We're excited to let you know that your application for the StarStore Ambassador Program has been <span class="highlight">approved</span>!</p>
<div class="success-box">
    <p><strong>Your Ambassador Details:</strong></p>
    <p>Referral Code: <span class="highlight"><code>${referralCode}</code></span></p>
    <p>You can now access the ambassador dashboard and start earning commissions from referrals.</p>
</div>
<h3 style="margin-top: 24px; font-size: 16px;">Getting Started:</h3>
<ol style="padding-left: 20px;">
    <li>Log in to StarStore and visit your Ambassador Dashboard</li>
    <li>Set your wallet address for payouts</li>
    <li>Start sharing your referral code with your community</li>
    <li>Earn commissions based on your tier level</li>
</ol>
<div class="divider"></div>
<p><strong>Did you know?</strong> Higher tier ambassadors earn more per referral. Build your network and grow your earnings!</p>
<p style="margin-top: 24px;">Welcome to the StarStore Ambassador family!</p>
    `;
    
    return sendEmail(email, 'Ambassador Application Approved - StarStore', getEmailTemplate('You\'re Approved!', content));
}

/**
 * Wallet Address Set - Confirmation Email
 */
async function sendWalletAddressConfirmation(email, username, walletPreview) {
    const content = `
<h2>Wallet Address Confirmed</h2>
<p>Hi ${username || 'there'},</p>
<p>Your TON wallet address has been successfully registered for payouts.</p>
<div class="success-box">
    <p><strong>Wallet Address:</strong> ${walletPreview}</p>
    <p>All future earnings and withdrawals will be sent to this address.</p>
</div>
<div class="info-box">
    <p><strong>Important:</strong> Make sure this is the correct wallet address. You can update it anytime from your ambassador dashboard.</p>
</div>
<p>Your earnings will be calculated monthly based on your tier level and active referrals.</p>
    `;
    
    return sendEmail(email, 'Wallet Address Confirmed - StarStore', getEmailTemplate('Wallet Registered', content));
}

/**
 * Wallet Address Reminder - Before Payout
 */
async function sendWalletReminderBeforePayout(email, username) {
    const content = `
<h2>Action Required: Set Your Wallet Address</h2>
<p>Hi ${username || 'there'},</p>
<p>Your monthly payout is coming up in 3 days, but we don't have a wallet address on file yet.</p>
<div class="info-box">
    <p><strong>To receive your earnings, you must set your TON wallet address in the ambassador dashboard before the payout date.</strong></p>
</div>
<p>If you don't set a wallet address, your earnings will be held and added to next month's payout.</p>
<p><strong>Steps to set your wallet:</strong></p>
<ol style="padding-left: 20px;">
    <li>Log in to StarStore</li>
    <li>Go to Ambassador Dashboard</li>
    <li>Enter your TON wallet address</li>
    <li>Save and confirm</li>
</ol>
<p style="margin-top: 24px; color: #dc3545;">⏰ You have until <strong>end of month</strong> to set your wallet address.</p>
    `;
    
    return sendEmail(email, 'Action Required: Set Wallet Address for Payout', getEmailTemplate('Wallet Address Needed', content));
}

/**
 * Withdrawal Order Created - Notification
 */
async function sendWithdrawalCreated(email, username, amount, earnings) {
    const content = `
<h2>Monthly Withdrawal Request Created</h2>
<p>Hi ${username || 'there'},</p>
<p>Your monthly withdrawal request has been created and is pending admin approval.</p>
<div class="info-box">
    <p><strong>Withdrawal Details:</strong></p>
    <p>Amount: <span class="highlight">$${amount.toFixed(2)}</span></p>
    <p>Breakdown: ${earnings.map(e => `${e.tier} (+$${e.amount.toFixed(2)})`).join(', ')}</p>
</div>
<p>Our team will review and process this within 1-2 business days. You'll receive a confirmation email once approved.</p>
<p style="margin-top: 24px; font-size: 12px; color: #6c757d;">Thank you for being part of the StarStore Ambassador Program!</p>
    `;
    
    return sendEmail(email, 'Withdrawal Request Submitted - StarStore', getEmailTemplate('Withdrawal Created', content));
}

/**
 * Withdrawal Approved - Notification
 */
async function sendWithdrawalApproved(email, username, amount, txHash) {
    const content = `
<h2>Withdrawal Approved</h2>
<p>Hi ${username || 'there'},</p>
<p>Your withdrawal request has been approved and the payment is being processed.</p>
<div class="success-box">
    <p><strong>Payment Information:</strong></p>
    <p>Amount: <span class="highlight">$${amount.toFixed(2)}</span></p>
    <p>Status: Processing to your wallet</p>
    ${txHash ? `<p>Transaction: <code style="font-size: 11px;">${txHash}</code></p>` : ''}
</div>
<p>Transactions typically complete within 24-48 hours depending on blockchain network congestion.</p>
<p>You can track your payment status in the ambassador dashboard.</p>
    `;
    
    return sendEmail(email, 'Withdrawal Approved - StarStore', getEmailTemplate('Payment Approved', content));
}

/**
 * Withdrawal Declined - Notification
 */
async function sendWithdrawalDeclined(email, username, reason) {
    const content = `
<h2>Withdrawal Request Status</h2>
<p>Hi ${username || 'there'},</p>
<p>Your withdrawal request could not be processed at this time.</p>
<div class="info-box">
    <p><strong>Reason:</strong> ${reason || 'Please contact support for more details'}</p>
</div>
<p>Your earnings have been carried over and will be available in your next monthly withdrawal. No funds were lost.</p>
<p>If you have questions about this decision, please reach out to our support team.</p>
    `;
    
    return sendEmail(email, 'Withdrawal Request Update - StarStore', getEmailTemplate('Request Status', content));
}

/**
 * Newsletter Welcome Email
 */
async function sendNewsletterWelcome(email) {
    const content = `
<h2>Welcome to StarStore Updates</h2>
<p>Thank you for subscribing to our newsletter!</p>
<p>You'll now receive the latest news about new features, platform updates, special promotions, and exclusive ambassador tips.</p>
<div class="success-box">
    <p>We're committed to keeping our subscribers informed with valuable content, not spam. Expect updates at most once a week.</p>
</div>
<p style="margin-top: 24px;">Stay tuned for exciting announcements from the StarStore team!</p>
    `;
    
    return sendEmail(email, 'Welcome to StarStore Newsletter', getEmailTemplate('Welcome to Our Newsletter', content));
}

/**
 * Newsletter Broadcast - Send custom content to all subscribers
 */
async function sendNewsletterBroadcast(email, subject, htmlContent) {
    return sendEmail(email, subject, getEmailTemplate(subject, htmlContent));
}

/**
 * Check if email service is available
 */
function isEmailAvailable() {
    return emailAvailable && resend !== null;
}

/**
 * Get email service status (for debugging)
 */
function getEmailStatus() {
    return {
        available: emailAvailable,
        hasApiKey: !!process.env.RESEND_API_KEY,
        message: emailAvailable ? 'Email service ready' : 'Email service disabled'
    };
}

module.exports = {
    sendEmail,
    sendAmbassadorApplicationSubmitted,
    sendAmbassadorApplicationDenied,
    sendAmbassadorApproved,
    sendWalletAddressConfirmation,
    sendWalletReminderBeforePayout,
    sendWithdrawalCreated,
    sendWithdrawalApproved,
    sendWithdrawalDeclined,
    sendNewsletterWelcome,
    sendNewsletterBroadcast,
    isEmailAvailable,
    getEmailStatus
};
