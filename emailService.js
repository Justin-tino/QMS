/**
 * PSAU Feedback System — Automated Email Notification Service
 * Sends automated confirmation emails to respondents and notification emails to system admins
 * using Nodemailer (SMTP).
 */

const nodemailer = require('nodemailer');
const sanitizeHtml = require('sanitize-html');

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function isValidEmail(email) {
    if (typeof email !== 'string') return false;
    email = email.trim();
    if (!email || email.length > 200) return false;
    // Strict RFC-ish check — rejects gmai.com typos via typo map below
    const strictRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i;
    if (!strictRegex.test(email)) return false;
    if (email.includes('..')) return false;
    const parts = email.split('@');
    if (parts.length !== 2) return false;
    const [local, domain] = parts;
    if (!local || !domain) return false;
    if (local.startsWith('.') || local.endsWith('.')) return false;
    if (domain.startsWith('-') || domain.startsWith('.') || domain.endsWith('-') || domain.endsWith('.')) return false;
    if (!domain.includes('.')) return false;
    const domainParts = domain.split('.');
    for (const p of domainParts) {
        if (!p || p.startsWith('-') || p.endsWith('-')) return false;
    }
    const tld = domainParts[domainParts.length - 1];
    if (!/^[a-z]{2,63}$/i.test(tld)) return false;
    // Common typo domains — treat as invalid so account creation is blocked
    const lowerDomain = domain.toLowerCase();
    const typoMap = {
        'gmai.com': 'gmail.com',
        'gmial.com': 'gmail.com',
        'gmal.com': 'gmail.com',
        'gnail.com': 'gmail.com',
        'gmaiil.com': 'gmail.com',
        'gmail.con': 'gmail.com',
        'gmail.cm': 'gmail.com',
        'gmail.co': 'gmail.com',
        'gmail.comm': 'gmail.com',
        'hotmai.com': 'hotmail.com',
        'hotnail.com': 'hotmail.com',
        'hotmal.com': 'hotmail.com',
        'yahooo.com': 'yahoo.com',
        'yaho.com': 'yahoo.com',
        'outlok.com': 'outlook.com',
        'outloo.com': 'outlook.com',
        'icloude.com': 'icloud.com'
    };
    if (typoMap[lowerDomain]) return false;
    // Also block 1-edit distance to common providers (gmail.com, psau.edu.ph etc.)
    const commonDomains = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','psau.edu.ph'];
    function lev(a,b){ const m=a.length,n=b.length; const dp=Array.from({length:m+1},()=>Array(n+1).fill(0)); for(let i=0;i<=m;i++) dp[i][0]=i; for(let j=0;j<=n;j++) dp[0][j]=j; for(let i=1;i<=m;i++) for(let j=1;j<=n;j++) dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]===b[j-1]?0:1)); return dp[m][n]; }
    for(const c of commonDomains){ if(lowerDomain!==c && lev(lowerDomain,c)===1) return false; }
    return true;
}
function getEmailTypoSuggestion(email) {
    if (!email || typeof email !== 'string' || !email.includes('@')) return null;
    const domain = email.trim().toLowerCase().split('@')[1];
    if (!domain) return null;
    const typoMap = {
        'gmai.com': 'gmail.com',
        'gmial.com': 'gmail.com',
        'gmal.com': 'gmail.com',
        'gnail.com': 'gmail.com',
        'gmaiil.com': 'gmail.com',
        'gmail.con': 'gmail.com',
        'gmail.cm': 'gmail.com',
        'gmail.co': 'gmail.com',
        'gmail.comm': 'gmail.com',
        'hotmai.com': 'hotmail.com',
        'hotnail.com': 'hotmail.com',
        'hotmal.com': 'hotmail.com',
        'yahooo.com': 'yahoo.com',
        'yaho.com': 'yahoo.com',
        'outlok.com': 'outlook.com',
        'outloo.com': 'outlook.com',
        'icloude.com': 'icloud.com'
    };
    if (typoMap[domain]) return typoMap[domain];
    // Levenshtein distance 1 from common providers
    const common = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','psau.edu.ph'];
    function lev(a,b){ const m=a.length,n=b.length; const dp=Array.from({length:m+1},()=>Array(n+1).fill(0)); for(let i=0;i<=m;i++) dp[i][0]=i; for(let j=0;j<=n;j++) dp[0][j]=j; for(let i=1;i<=m;i++) for(let j=1;j<=n;j++) dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]===b[j-1]?0:1)); return dp[m][n]; }
    for(const c of common){ if(domain!==c && lev(domain,c)===1) return c; }
    return null;
}
function sanitizeField(val, max = 500) {
    if (!val) return val || 'N/A';
    let s = sanitizeHtml(String(val), { allowedTags: [], allowedAttributes: {} });
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    return escapeHtml(s.substring(0, max));
}

class EmailService {
    constructor() {
        this.transporter = null;
        this.initTransporter();
    }

    initTransporter() {
        // Priority 0: Firebase Gmail OAuth2 (most reliable on Railway, no App Password)
        if (process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_CLIENT_SECRET && process.env.GMAIL_OAUTH_REFRESH_TOKEN) {
            try {
                const oauthUser = process.env.GMAIL_OAUTH_USER || process.env.SMTP_USER || 'bonustimoy@gmail.com';
                this.transporter = nodemailer.createTransport({
                    service: 'gmail',
                    auth: {
                        type: 'OAuth2',
                        user: oauthUser,
                        clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
                        clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
                        refreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
                        accessToken: process.env.GMAIL_OAUTH_ACCESS_TOKEN || undefined
                    },
                    family: 4,
                    connectionTimeout: 10000,
                    greetingTimeout: 10000,
                    socketTimeout: 15000
                });
                this.transporter.verify((err) => {
                    if (err) console.warn(' Gmail OAuth verify failed:', err.message, '— check GMAIL_OAUTH_* vars');
                    else console.log(` Gmail OAuth verified successfully for ${oauthUser}`);
                });
                console.log(` Nodemailer Gmail OAuth initialized for ${oauthUser}`);
                return;
            } catch (err) {
                console.warn(' Gmail OAuth init error:', err.message);
            }
        }
        // Priority 1: HTTPS API providers (Resend / Brevo) — never blocked by Railway, no SMTP ports
        if (process.env.RESEND_API_KEY) {
            console.log(' Email provider: Resend API (HTTPS) — will use https://api.resend.com/emails');
            return;
        }
        if (process.env.BREVO_API_KEY) {
            console.log(' Email provider: Brevo API (HTTPS) — will use https://api.brevo.com/v3/smtp/email');
            return;
        }
        const host = process.env.SMTP_HOST;
        const port = parseInt(process.env.SMTP_PORT) || 587;
        const user = process.env.SMTP_USER;
        const pass = process.env.SMTP_PASS;

        if (host && user && pass) {
            try {
                // Railway often blocks 587 greeting — use timeouts + IPv4 + TLS tweaks for Gmail
                this.transporter = nodemailer.createTransport({
                    host,
                    port,
                    secure: port === 465,
                    auth: { user, pass },
                    family: 4,
                    connectionTimeout: 10000,
                    greetingTimeout: 10000,
                    socketTimeout: 15000,
                    requireTLS: port === 587,
                    tls: { ciphers: 'SSLv3', rejectUnauthorized: false },
                    logger: false,
                    debug: false
                });
                // Verify in background — if it fails we log but keep transporter for retry
                this.transporter.verify((err) => {
                    if (err) console.warn(' SMTP verify failed (will retry on send):', err.message, '— check SMTP_HOST/PORT/USER/PASS and Gmail App Password, or set RESEND_API_KEY/BREVO_API_KEY for HTTPS mail');
                    else console.log(` Nodemailer SMTP verified successfully (${host}:${port}).`);
                });
                console.log(` Nodemailer SMTP initialized successfully (${host}:${port}).`);
            } catch (err) {
                console.warn(' Nodemailer SMTP init error:', err.message);
            }
        } else {
            console.log(' SMTP credentials not fully set and no RESEND_API_KEY/BREVO_API_KEY. Email notifications will operate in Console/Test mode.');
            console.log(' Tip: Set RESEND_API_KEY or BREVO_API_KEY for reliable HTTPS email on Railway (no SMTP ports).');
        }
    }

    async sendViaResend(to, subject, html) {
        const apiKey = process.env.RESEND_API_KEY;
        const from = process.env.RESEND_FROM || process.env.SMTP_USER || 'onboarding@resend.dev';
        if (!apiKey) return false;
        try {
            const res = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: `PSAU Feedback System <${from}>`, to: [to], subject, html })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                console.log(` Email sent via Resend to ${to}. Id: ${data.id || 'ok'}`);
                return true;
            }
            console.warn(` Resend API failed (${res.status}):`, data.message || JSON.stringify(data).slice(0,300));
            return false;
        } catch (err) {
            console.warn(' Resend API error:', err.message);
            return false;
        }
    }

    async sendViaBrevo(to, subject, html) {
        const apiKey = process.env.BREVO_API_KEY;
        const senderEmail = process.env.BREVO_SENDER || process.env.SMTP_USER || 'bonustimoy@gmail.com';
        const senderName = 'PSAU Feedback System';
        if (!apiKey) return false;
        try {
            const res = await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: to }], subject, htmlContent: html })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                console.log(` Email sent via Brevo to ${to}. messageId: ${data.messageId || 'ok'}`);
                return true;
            }
            console.warn(` Brevo API failed (${res.status}):`, data.message || JSON.stringify(data).slice(0,400));
            return false;
        } catch (err) {
            console.warn(' Brevo API error:', err.message);
            return false;
        }
    }

    /**
    * Send automated confirmation email to client/respondent
    */
    async sendUserConfirmation(toEmail, feedbackData) {
        if (!isValidEmail(toEmail)) return false;

        const subject = 'PSAU Customer Feedback Confirmation - Thank You'.replace(/[\r\n]/g, '');
        const safePangalan = sanitizeField(feedbackData.pangalan, 100) || 'Valued Client';
        const safeTanggapan = sanitizeField(feedbackData.tanggapan, 200);
        const safePetsa = sanitizeField(feedbackData.petsa, 20);
        const safeUri = sanitizeField(feedbackData.uri_transaksyon, 200);
        const safeAvg = sanitizeField(feedbackData.avgSQD, 10);
        const html = `
 <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
 <div style="background-color: #1b5e20; color: #ffffff; padding: 20px; text-align: center;">
 <h2 style="margin: 0; font-size: 20px;">Pampanga State Agricultural University</h2>
 <p style="margin: 5px 0 0 0; font-size: 13px; color: #ffb300;">Quality Management System Unit</p>
 </div>
 <div style="padding: 25px; color: #333333; line-height: 1.6;">
 <h3 style="color: #1b5e20; margin-top: 0;">Magandang Araw, ${safePangalan}!</h3>
 <p>Maraming salamat sa pagbibigay ng iyong mahalagang feedback para sa aming tanggapan: <strong>${safeTanggapan || 'PSAU'}</strong>.</p>
 
 <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #1b5e20; margin: 20px 0; border-radius: 4px;">
 <h4 style="margin-top: 0; color: #1b5e20;">Buod ng Iyong Isinumite:</h4>
 <p style="margin: 5px 0;"><strong>Petsa:</strong> ${safePetsa || new Date().toISOString().split('T')[0]}</p>
 <p style="margin: 5px 0;"><strong>Serbisyo / Transaksyon:</strong> ${safeUri}</p>
 <p style="margin: 5px 0;"><strong>Average SQD Rating:</strong> <span style="color: #2e7d32; font-weight: bold;">${safeAvg} / 5.00</span></p>
 </div>

 <p>Ang iyong mga suhestiyon ay gagamitin ng aming Office of Institutional Quality Assurance (OQA) upang mas mapabuti at lalong mapahusay ang aming serbisyo publiko.</p>
 <hr style="border: none; border-top: 1px solid #eeeeee; margin: 20px 0;">
 <p style="font-size: 12px; color: #888888; text-align: center;">
 Ito ay isang awtomatikong email mula sa PSAU Customer Feedback System.<br>
 Control No.: QMS-CFF-2026
 </p>
 </div>
 </div>
 `;

        return this.sendMail(toEmail, subject, html);
    }

    /**
     * Send automated notification email to System Administrator(s)
     * Now supports overrideEmail param so server can broadcast to ALL admin accounts
     * @param {object} feedbackData
     * @param {string|null} overrideEmail - if provided, send to this specific admin instead of env
     */
    async sendAdminNotification(feedbackData, overrideEmail = null) {
        let adminEmail = null;
        if (overrideEmail && isValidEmail(overrideEmail)) {
            adminEmail = overrideEmail.trim();
        } else {
            const rawAdmin = process.env.ADMIN_EMAIL || 'admin@psau.edu.ph';
            adminEmail = isValidEmail(rawAdmin) ? rawAdmin : 'admin@psau.edu.ph';
        }
        const isLowRating = parseFloat(feedbackData.avgSQD) < 3.0;
        const safeTanggapanSub = sanitizeField(feedbackData.tanggapan, 100);
        const safeAvgSub = sanitizeField(feedbackData.avgSQD, 10);
        const subject = `${isLowRating ? 'ALERT:' : '[NEW FEEDBACK]'} ${safeTanggapanSub} - SQD ${safeAvgSub}/5.00`.replace(/[\r\n]/g, '');

        const html = `
 <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
 <div style="background-color: ${isLowRating ? '#c62828' : '#1b5e20'}; color: #ffffff; padding: 20px; text-align: center;">
 <h2 style="margin: 0; font-size: 18px;">${isLowRating ? ' Low Rating Feedback Alert' : 'New Customer Feedback Submitted'}</h2>
 <p style="margin: 5px 0 0 0; font-size: 13px;">${feedbackData.tanggapan}</p>
 </div>
 <div style="padding: 25px; color: #333333; line-height: 1.6;">
 <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
 <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold; width: 35%;">Respondent:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${sanitizeField(feedbackData.pangalan, 100)}</td></tr>
 <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Client Type:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${sanitizeField(feedbackData.uri_kliyente, 100)}</td></tr>
 <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Office Visited:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${sanitizeField(feedbackData.tanggapan, 200)}</td></tr>
 <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Average SQD Score:</td><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold; color: ${isLowRating ? '#d32f2f' : '#2e7d32'};">${sanitizeField(feedbackData.avgSQD, 10)} / 5.00</td></tr>
 <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Sentiment (AI/NB):</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${sanitizeField(feedbackData.sentiment, 20)}</td></tr>
 <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Suggestions:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${sanitizeField(feedbackData.suggestions, 1000) || 'None provided.'}</td></tr>
 <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Timestamp:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${new Date().toLocaleString('en-PH')}</td></tr>
 </table>
 <div style="text-align: center; margin-top: 25px;">
 <a href="http://localhost:3000/admin/dashboard" style="background-color: #1b5e20; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Open Dashboard</a>
 </div>
 </div>
 </div>
 `;

        return this.sendMail(adminEmail, subject, html);
    }

    /**
     * Broadcast to ALL admin accounts (Firestore users where role==admin + ADMIN_EMAILS env)
     * Used by server when new feedback arrives so every admin receives notification
     */
    async sendAdminNotificationsToAll(feedbackData, adminEmails) {
        if (!Array.isArray(adminEmails) || adminEmails.length === 0) {
            // fallback to single env-based send
            return this.sendAdminNotification(feedbackData);
        }
        const unique = [...new Set(adminEmails.map(e => String(e).trim().toLowerCase()).filter(isValidEmail))];
        if (unique.length === 0) return this.sendAdminNotification(feedbackData);
        const results = await Promise.allSettled(unique.map(email => this.sendAdminNotification(feedbackData, email)));
        const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
        console.log(` Admin broadcast: ${ok}/${unique.length} admin email(s) sent`);
        return ok > 0;
    }

    /**
     * Send email verification link to newly created / unverified staff accounts
    * (CAPSTONE.docx Security Framework: "requiring users to verify their email before accessing certain features")
    */
    async sendVerificationEmail(toEmail, verificationLink, displayName) {
        if (!isValidEmail(toEmail) || !verificationLink) return false;
        const subject = 'PSAU Feedback System — Verify Your Email Address';
        const safeName = sanitizeField(displayName, 100);
        const html = `
 <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
 <div style="background-color: #1b5e20; color: #ffffff; padding: 20px; text-align: center;">
 <h2 style="margin: 0; font-size: 20px;">Pampanga State Agricultural University</h2>
 <p style="margin: 5px 0 0 0; font-size: 13px; color: #ffb300;">Quality Management System</p>
 </div>
 <div style="padding: 25px; color: #333333; line-height: 1.6;">
 <h3 style="color: #1b5e20; margin-top: 0;">Email Verification Required</h3>
 <p>Magandang araw, <strong>${safeName || 'User'}</strong>!</p>
 <p>An employee account was created for you on the PSAU Feedback System. For security, please verify your email address before signing in:</p>
 <div style="text-align: center; margin: 25px 0;">
 <a href="${verificationLink}" style="background-color: #1b5e20; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 5px; font-weight: bold;">Verify My Email</a>
 </div>
 <p style="font-size: 12px; color: #888888;">If the button does not work, copy this link into your browser:<br>${verificationLink}</p>
 <hr style="border: none; border-top: 1px solid #eeeeee; margin: 20px 0;">
 <p style="font-size: 12px; color: #888888; text-align: center;">If you did not expect this account, please ignore this email or contact your administrator.</p>
 </div>
 </div>
 `;
        return this.sendMail(toEmail, subject, html);
    }

    /**
    * Send one-time PIN (OTP) to the admin email before sensitive actions
    * (e.g., database backup download). Code expires in 5 minutes.
    */
    async sendOtpEmail(toEmail, code) {
        if (!isValidEmail(toEmail)) return false;
        const subject = 'PSAU Feedback System — Your Security Code';
        const html = `
 <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
 <div style="background-color: #1b5e20; color: #ffffff; padding: 20px; text-align: center;">
 <h2 style="margin: 0; font-size: 20px;">Pampanga State Agricultural University</h2>
 <p style="margin: 5px 0 0 0; font-size: 13px; color: #ffb300;">Feedback Analytics — Security Verification</p>
 </div>
 <div style="padding: 25px; color: #333333; line-height: 1.6; text-align: center;">
 <h3 style="color: #1b5e20; margin-top: 0;">Your One-Time PIN</h3>
 <p>Use the security code below to continue. It expires in <strong>5 minutes</strong>.</p>
 <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 34px; letter-spacing: 10px; font-weight: 800; color: #1b5e20; background: #f0fdf4; border: 1px dashed #a5d6a7; border-radius: 10px; padding: 15px 10px; margin: 15px 0;">${code}</div>
 <p style="font-size: 12px; color: #888888;">Never share this code. If you did not request it, ignore this email.</p>
 </div>
 </div>
 `;
        return this.sendMail(toEmail, subject, html);
    }

    /**
    * Send a password reset link to the admin after identity re-verification
    * (current password checked server-side before this email is triggered).
    */
    async sendPasswordResetEmail(toEmail, resetLink) {
        if (!isValidEmail(toEmail) || !resetLink) return false;
        const subject = 'PSAU Feedback System — Reset Your Password';
        const html = `
 <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
 <div style="background-color: #1b5e20; color: #ffffff; padding: 20px; text-align: center;">
 <h2 style="margin: 0; font-size: 20px;">Pampanga State Agricultural University</h2>
 <p style="margin: 5px 0 0 0; font-size: 13px; color: #ffb300;">Feedback Analytics — Password Reset</p>
 </div>
 <div style="padding: 25px; color: #333333; line-height: 1.6;">
 <h3 style="color: #1b5e20; margin-top: 0;">Password Reset Request</h3>
 <p>We received a request to reset your password after a successful identity check. Click the button below to choose a new password:</p>
 <div style="text-align: center; margin: 25px 0;">
 <a href="${resetLink}" style="background-color: #1b5e20; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 5px; font-weight: bold;">Reset My Password</a>
 </div>
 <p style="font-size: 12px; color: #888888;">If the button does not work, copy this link into your browser:<br>${resetLink}</p>
 <hr style="border: none; border-top: 1px solid #eeeeee; margin: 20px 0;">
 <p style="font-size: 12px; color: #888888; text-align: center;">If you did not request a password reset, secure your account immediately and contact your administrator.</p>
 </div>
 </div>
 `;
        return this.sendMail(toEmail, subject, html);
    }

    async sendMail(to, subject, html) {
        // Priority: HTTPS APIs first (Railway-safe) — then SMTP — then simulation
        if (process.env.RESEND_API_KEY) {
            const ok = await this.sendViaResend(to, subject, html);
            if (ok) return true;
            console.warn(' Resend failed, falling back to SMTP/simulation...');
        }
        if (process.env.BREVO_API_KEY) {
            const ok = await this.sendViaBrevo(to, subject, html);
            if (ok) return true;
            console.warn(' Brevo failed, falling back to SMTP/simulation...');
        }
        if (!this.transporter) {
            // mask recipient address in logs — no PII in console output
            const maskedTo = String(to || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');
            console.log(`\n [EMAIL SIMULATION / TEST MODE]`);
            console.log(` To: ${maskedTo}`);
            console.log(` Subject: ${subject}`);
            console.log(` (Configure RESEND_API_KEY or BREVO_API_KEY or SMTP_HOST/USER/PASS to send real emails)\n`);
            // In simulation we return true so UI shows success even without SMTP (useful for demo)
            return true;
        }

        try {
            const info = await this.transporter.sendMail({
                from: `"PSAU Feedback System" <${process.env.SMTP_USER}>`,
                to,
                subject,
                html
            });
            console.log(` Email sent successfully to ${to}. MessageId: ${info.messageId}`);
            return true;
        } catch (err) {
            console.error(` Email sending failed to ${to}:`, err.message);
            // If SMTP timeout and we have HTTPS fallback not yet tried, suggest it
            if (err.message && err.message.includes('timeout')) {
                console.warn(' Hint: Railway often blocks SMTP 587/465. Set RESEND_API_KEY or BREVO_API_KEY for HTTPS email (works on Railway).');
            }
            return false;
        }
    }
}

const emailService = new EmailService();
module.exports = emailService;
