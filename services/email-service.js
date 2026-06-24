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
            <div class="logo">StarStore<br>Buy & Sell Telegram Stars</div>
        </div>
        <div class="content">
            ${content}
        </div>
        <div class="footer">
            <p>StarStore<br>Buy & Sell Telegram Stars</p>
            <p style="margin-top: 8px; color: #999;">© 2026 StarStore. All rights reserved.</p>
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
<h2>Your Application is In</h2>
<p>Hey ${username || 'there'},</p>
<p>Got your ambassador application. We're checking it out and will let you know what's next.</p>
<div class="info-box">
    <p><strong>What happens now?</strong></p>
    <p>We'll look through your profile and social links. Once we decide, you'll get an email with the status.</p>
</div>
<p>In the meantime, explore the platform and get familiar with how everything works.</p>
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
<h2>Application Status</h2>
<p>Hey ${username || 'there'},</p>
<p>Thanks for applying to our ambassador program. This time, it's not the right fit, but don't worry—you can always try again.</p>
<div class="info-box">
    <p>Build up your social presence and engagement, then reapply whenever you're ready. We'd love to have you on the team.</p>
</div>
<p>Want to grow together? Get back in touch when you feel ready.</p>
<p style="margin-top: 24px; font-size: 12px; color: #6c757d;">If you have questions, please contact our support team.</p>
    `;
    
    return sendEmail(email, 'Ambassador Application Status - StarStore', getEmailTemplate('Application Update', content));
}

/**
 * Ambassador Approved - Notify User with Referral Link and full tier breakdown
 */
async function sendAmbassadorApproved(email, username, referralCode, referralLink) {
    const content = `
<h2>You're In! 🎉</h2>
<p>Hey ${username || 'there'},</p>
<p>Your application has been approved. You're officially part of the StarStore Ambassador Program.</p>
<div class="success-box">
    <p><strong>Your Referral Link:</strong></p>
    <p><span class="highlight"><code>${referralLink}</code></span></p>
    <p>Share this link with your audience. Every person who signs up and transacts through it counts as a referral and earns you rewards.</p>
</div>

<div class="divider"></div>
<h3 style="margin-top: 0; margin-bottom: 16px; font-size: 17px; color: #212529;">Ambassador Levels &amp; Benefits</h3>
<p style="color: #6c757d; font-size: 14px; margin-bottom: 20px;">Your rewards grow as you bring in more referrals. Here's exactly what each level unlocks:</p>

<!-- Level 1 -->
<table style="width:100%; border-collapse:collapse; margin-bottom:20px; border:1px solid #e9ecef; border-radius:8px; overflow:hidden;">
    <tr style="background:#f3f0ff;">
        <td style="padding:12px 16px;" colspan="2">
            <strong style="font-size:15px; color:#5b21b6;">Explorer — Level 1</strong>
            <span style="float:right; font-size:13px; color:#7c3aed; font-weight:600;">30 Referrals</span>
        </td>
    </tr>
    <tr>
        <td style="padding:10px 16px; vertical-align:top; width:50%; border-top:1px solid #e9ecef;">
            <p style="margin:0 0 6px; font-size:13px; font-weight:600; color:#374151;">Requirements</p>
            <ul style="margin:0; padding-left:16px; font-size:13px; color:#6b7280;">
                <li>30+ successful referrals/month</li>
                <li>Avg. 350+ Stars per referral</li>
            </ul>
        </td>
        <td style="padding:10px 16px; vertical-align:top; border-top:1px solid #e9ecef; border-left:1px solid #e9ecef;">
            <p style="margin:0 0 6px; font-size:13px; font-weight:600; color:#374151;">Benefits</p>
            <ul style="margin:0; padding-left:16px; font-size:13px; color:#6b7280;">
                <li>$30 minimum monthly earnings</li>
                <li>50 free Stars monthly</li>
                <li>Priority recognition</li>
            </ul>
        </td>
    </tr>
</table>

<!-- Level 2 -->
<table style="width:100%; border-collapse:collapse; margin-bottom:20px; border:1px solid #e9ecef; border-radius:8px; overflow:hidden;">
    <tr style="background:#ecfdf5;">
        <td style="padding:12px 16px;" colspan="2">
            <strong style="font-size:15px; color:#065f46;">Connector — Level 2</strong>
            <span style="float:right; font-size:13px; color:#059669; font-weight:600;">50 Referrals</span>
        </td>
    </tr>
    <tr>
        <td style="padding:10px 16px; vertical-align:top; width:50%; border-top:1px solid #e9ecef;">
            <p style="margin:0 0 6px; font-size:13px; font-weight:600; color:#374151;">Requirements</p>
            <ul style="margin:0; padding-left:16px; font-size:13px; color:#6b7280;">
                <li>50+ successful referrals/month</li>
                <li>Avg. 400+ Stars per referral</li>
            </ul>
        </td>
        <td style="padding:10px 16px; vertical-align:top; border-top:1px solid #e9ecef; border-left:1px solid #e9ecef;">
            <p style="margin:0 0 6px; font-size:13px; font-weight:600; color:#374151;">Benefits</p>
            <ul style="margin:0; padding-left:16px; font-size:13px; color:#6b7280;">
                <li>$60+ monthly earnings</li>
                <li>100 free Stars monthly</li>
                <li>VIP Ambassador status</li>
                <li>Early access to campaigns</li>
                <li>Priority support</li>
            </ul>
        </td>
    </tr>
</table>

<!-- Level 3 -->
<table style="width:100%; border-collapse:collapse; margin-bottom:20px; border:1px solid #e9ecef; border-radius:8px; overflow:hidden;">
    <tr style="background:#eff6ff;">
        <td style="padding:12px 16px;" colspan="2">
            <strong style="font-size:15px; color:#1e40af;">Pioneer — Level 3</strong>
            <span style="float:right; font-size:13px; color:#2563eb; font-weight:600;">70 Referrals</span>
        </td>
    </tr>
    <tr>
        <td style="padding:10px 16px; vertical-align:top; width:50%; border-top:1px solid #e9ecef;">
            <p style="margin:0 0 6px; font-size:13px; font-weight:600; color:#374151;">Requirements</p>
            <ul style="margin:0; padding-left:16px; font-size:13px; color:#6b7280;">
                <li>70+ successful referrals/month</li>
                <li>Avg. 450+ Stars per referral</li>
            </ul>
        </td>
        <td style="padding:10px 16px; vertical-align:top; border-top:1px solid #e9ecef; border-left:1px solid #e9ecef;">
            <p style="margin:0 0 6px; font-size:13px; font-weight:600; color:#374151;">Benefits</p>
            <ul style="margin:0; padding-left:16px; font-size:13px; color:#6b7280;">
                <li>$80+ monthly earnings</li>
                <li>150 free Stars monthly</li>
                <li>Co-marketing opportunities</li>
                <li>Featured Ambassador spotlight</li>
                <li>Priority support</li>
            </ul>
        </td>
    </tr>
</table>

<!-- Level 4 -->
<table style="width:100%; border-collapse:collapse; margin-bottom:20px; border:1px solid #e9ecef; border-radius:8px; overflow:hidden;">
    <tr style="background:#fffbeb;">
        <td style="padding:12px 16px;" colspan="2">
            <strong style="font-size:15px; color:#92400e;">Elite — Level 4</strong>
            <span style="float:right; font-size:13px; color:#d97706; font-weight:600;">100 Referrals</span>
        </td>
    </tr>
    <tr>
        <td style="padding:10px 16px; vertical-align:top; width:50%; border-top:1px solid #e9ecef;">
            <p style="margin:0 0 6px; font-size:13px; font-weight:600; color:#374151;">Requirements</p>
            <ul style="margin:0; padding-left:16px; font-size:13px; color:#6b7280;">
                <li>100+ successful referrals/month</li>
                <li>Avg. 500+ Stars per referral</li>
            </ul>
        </td>
        <td style="padding:10px 16px; vertical-align:top; border-top:1px solid #e9ecef; border-left:1px solid #e9ecef;">
            <p style="margin:0 0 6px; font-size:13px; font-weight:600; color:#374151;">Benefits</p>
            <ul style="margin:0; padding-left:16px; font-size:13px; color:#6b7280;">
                <li>$110+ monthly earnings</li>
                <li>200 free Stars monthly</li>
                <li>Revenue-sharing opportunities</li>
                <li>Strategic partnerships</li>
                <li>Exclusive campaigns &amp; previews</li>
            </ul>
        </td>
    </tr>
</table>

<div class="divider"></div>
<h3 style="margin-top: 0; font-size: 16px; color: #212529;">Getting Started</h3>
<ol style="padding-left: 20px; color: #495057;">
    <li style="margin-bottom:8px;">Open StarStore and go to your Ambassador page</li>
    <li style="margin-bottom:8px;">Add your TON wallet address — this is where your monthly payouts go</li>
    <li style="margin-bottom:8px;">Start sharing your referral link</li>
    <li style="margin-bottom:8px;">Payouts are processed automatically at the start of each month</li>
</ol>
<div class="info-box" style="margin-top:20px;">
    <p style="margin:0; font-size:14px;">Want to learn more about the program, suggest changes to pricing, or explore partnership opportunities? Visit the Ambassador Hub: <a href="https://amb.starstore.app" style="color:#007bff; font-weight:500;">amb.starstore.app</a></p>
</div>
<p style="margin-top: 24px;">Welcome to the team! 🚀</p>
    `;
    
    return sendEmail(email, 'Ambassador Application Approved - StarStore', getEmailTemplate('You\'re Approved!', content));
}

/**
 * Wallet Address Set - Confirmation Email
 */
async function sendWalletAddressConfirmation(email, username, walletPreview) {
    const content = `
<h2>Wallet Locked In ✓</h2>
<p>Hey ${username || 'there'},</p>
<p>Your TON wallet is set. All your earnings will go here.</p>
<div class="success-box">
    <p><strong>Wallet:</strong> ${walletPreview}</p>
    <p>You're all set to receive payouts.</p>
</div>
<div class="info-box">
    <p><strong>Important:</strong> Double-check this is the right wallet. You can change it from your dashboard if needed.</p>
</div>
<p>Earnings are calculated monthly based on your tier and active referrals.</p>
    `;
    
    return sendEmail(email, 'Wallet Address Confirmed - StarStore', getEmailTemplate('Wallet Registered', content));
}

/**
 * Wallet Address Reminder - Before Payout
 */
async function sendWalletReminderBeforePayout(email, username) {
    const content = `
<h2>Quick Action: Add Your Wallet 🕐</h2>
<p>Hey ${username || 'there'},</p>
<p>Your payout is in 3 days, but no wallet address on file yet.</p>
<div class="info-box">
    <p><strong>You need to add your wallet before payout or your earnings get held over to next month.</strong></p>
</div>
<p><strong>Here's how:</strong></p>
<ol style="padding-left: 20px;">
    <li>Log into your StarStore dashboard</li>
    <li>Find your wallet settings</li>
    <li>Add your TON wallet</li>
    <li>Done</li>
</ol>
<p style="margin-top: 24px; color: #dc3545;">⏰ <strong>Due by end of month</strong> — don't miss it.</p>
    `;
    
    return sendEmail(email, 'Action Required: Set Wallet Address for Payout', getEmailTemplate('Wallet Address Needed', content));
}

/**
 * Withdrawal Order Created - Notification
 */
async function sendWithdrawalCreated(email, username, amount, earnings) {
    const content = `
<h2>Withdrawal Request Submitted 📤</h2>
<p>Hey ${username || 'there'},</p>
<p>Your withdrawal request is in and waiting for approval.</p>
<div class="info-box">
    <p><strong>Details:</strong></p>
    <p>Amount: <span class="highlight">$${amount.toFixed(2)}</span></p>
    <p>Breakdown: ${earnings.map(e => `${e.tier} (+$${e.amount.toFixed(2)})`).join(', ')}</p>
</div>
<p>We'll process this in 1-2 business days. You'll get another email when it's approved.</p>
<p style="margin-top: 24px; font-size: 12px; color: #6c757d;">Thanks for being an ambassador with us!</p>
    `;
    
    return sendEmail(email, 'Withdrawal Request Submitted - StarStore', getEmailTemplate('Withdrawal Created', content));
}

/**
 * Withdrawal Approved - Notification
 */
async function sendWithdrawalApproved(email, username, amount, txHash) {
    const content = `
<h2>It's Happening! 💰</h2>
<p>Hey ${username || 'there'},</p>
<p>Your withdrawal is approved and the money's on its way.</p>
<div class="success-box">
    <p><strong>Details:</strong></p>
    <p>Amount: <span class="highlight">$${amount.toFixed(2)}</span></p>
    <p>Status: Processing to your wallet</p>
    ${txHash ? `<p>Transaction: <code style="font-size: 11px;">${txHash}</code></p>` : ''}
</div>
<p>It'll hit your wallet in 24-48 hours (depends on the blockchain).</p>
<p>You can check the status in your dashboard anytime.</p>
    `;
    
    return sendEmail(email, 'Withdrawal Approved - StarStore', getEmailTemplate('Payment Approved', content));
}

/**
 * Withdrawal Declined - Notification
 */
async function sendWithdrawalDeclined(email, username, reason) {
    const content = `
<h2>Withdrawal Status</h2>
<p>Hey ${username || 'there'},</p>
<p>We couldn't process your withdrawal this time.</p>
<div class="info-box">
    <p><strong>Why:</strong> ${reason || 'Message our support team for details'}</p>
</div>
<p>Your earnings are safe and will be available again next month. Nothing is lost.</p>
<p>Questions? Hit up our support team and they'll help you out.</p>
    `;
    
    return sendEmail(email, 'Withdrawal Request Update - StarStore', getEmailTemplate('Request Status', content));
}

/**
 * Newsletter Welcome Email
 */
async function sendNewsletterWelcome(email) {
    const content = `
<h2>Welcome to the Loop 📬</h2>
<p>Thanks for signing up for our newsletter!</p>
<p>You'll get the latest on new features, platform updates, deals, and ambassador tips straight to your inbox.</p>
<div class="success-box">
    <p>We keep it real—valuable stuff only, no spam. Expect something weekly at most.</p>
</div>
<p style="margin-top: 24px;">Excited to keep you in the loop. See you in your inbox!</p>
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
 * Ambassador Wallet Reminder Email - Before Automatic Monthly Withdrawal
 * Sent 2-3 days before end of month to ambassadors with balance to withdraw
 */
async function sendAmbassadorWalletReminder(email, username, availableBalance) {
    const content = `
<h2>Wallet Reminder 💰</h2>
<p>Hey ${username || 'there'},</p>
<p>You have earnings of <span class="highlight">$${availableBalance.toFixed(2)}</span> ready for automatic payout!</p>
<div class="info-box">
    <p><strong>🔐 Automatic withdrawal starts in 2-3 days</strong></p>
    <p>Please make sure your TON wallet address is set in your profile to receive your monthly payout automatically.</p>
</div>
<h3 style="margin-top: 16px; font-size: 14px;">What you need to do:</h3>
<ol style="padding-left: 20px; font-size: 14px;">
    <li>Log into your StarStore dashboard</li>
    <li>Go to your profile settings</li>
    <li>Add or verify your TON wallet address</li>
    <li>Done! Your earnings will be sent automatically</li>
</ol>
<div class="success-box">
    <p><strong>⚡ Pro Tip:</strong> Automatic withdrawal processes instantly once your wallet is verified.</p>
</div>
<p style="margin-top: 24px; font-size: 12px; color: #6c757d;">This is an automated reminder. Your balance will be automatically withdrawn at the end of the month.</p>
    `;
    
    return sendEmail(email, 'Automatic Payout Reminder - Please Set Your Wallet - StarStore', getEmailTemplate('Wallet Reminder', content));
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
    sendAmbassadorWalletReminder,
    sendWithdrawalCreated,
    sendWithdrawalApproved,
    sendWithdrawalDeclined,
    sendNewsletterWelcome,
    sendNewsletterBroadcast,
    isEmailAvailable,
    getEmailStatus
};

/**
 * Admin Custom Email - Send email with template styling
 * Used for admin email sending feature
 */
async function sendCustomEmail(to, subject, htmlBody) {
    const styledHtml = getEmailTemplate(subject, htmlBody);
    return sendEmail(to, subject, styledHtml);
}

// Export the new function
const originalExports = module.exports;
module.exports = {
    ...originalExports,
    sendCustomEmail
};
