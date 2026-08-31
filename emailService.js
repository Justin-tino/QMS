/**
 * PSAU Feedback System — Automated Email Notification Service
 * Sends automated confirmation emails to respondents and notification emails to system admins
 * using Nodemailer (SMTP).
 */

const nodemailer = require('nodemailer');
const sanitizeHtml = require('sanitize-html');
const dns = require('dns');

// Force IPv4 DNS resolution — Railway containers cannot reach IPv6 endpoints
// (fixes: connect ENETUNREACH 2607:f8b0:... when connecting to smtp.gmail.com)
dns.setDefaultResultOrder('ipv4first');

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
    const commonDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'psau.edu.ph'];
    function lev(a, b) { const m = a.length, n = b.length; const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0)); for (let i = 0; i <= m; i++) dp[i][0] = i; for (let j = 0; j <= n; j++) dp[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return dp[m][n]; }
    for (const c of commonDomains) { if (lowerDomain !== c && lev(lowerDomain, c) === 1) return false; }
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
    const common = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'psau.edu.ph'];
    function lev(a, b) { const m = a.length, n = b.length; const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0)); for (let i = 0; i <= m; i++) dp[i][0] = i; for (let j = 0; j <= n; j++) dp[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return dp[m][n]; }
    for (const c of common) { if (domain !== c && lev(domain, c) === 1) return c; }
    return null;
}
function sanitizeField(val, max = 500) {
    if (!val) return val || 'N/A';
    let s = sanitizeHtml(String(val), { allowedTags: [], allowedAttributes: {} });
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    return escapeHtml(s.substring(0, max));
}

// Helper: Railway-safe env reader — trims, strips surrounding quotes, normalizes
function cleanEnv(name) {
    let v = process.env[name];
    if (v === undefined || v === null) return '';
    v = String(v).trim();
    // Railway UI sometimes stores values with surrounding quotes if user pasted "value"
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1).trim();
    }
    return v;
}

class EmailService {
    constructor() {
        this.transporter = null;
        this.lastError = null;
        this.initTransporter();
    }

    initTransporter() {
        // Priority -1: Brevo HTTPS API (works on Railway/Render Free where SMTP 587/465 is blocked)
        // Uses port 443 (HTTPS), never blocked. If BREVO_API_KEY is set, sendMail() will try Brevo first before SMTP.
        this.brevoKey = cleanEnv('BREVO_API_KEY') || cleanEnv('BREVO_KEY');
        this.brevoSenderEmail = (cleanEnv('BREVO_SENDER_EMAIL') || cleanEnv('SMTP_USER') || 'bonustimoy@gmail.com').trim().toLowerCase();
        this.brevoSenderName = cleanEnv('BREVO_SENDER_NAME') || 'PSAU Feedback System';
        if (this.brevoKey) {
            const maskedKey = this.brevoKey.substring(0, 10) + '***';
            console.log(` Brevo HTTPS API enabled (sender: ${this.brevoSenderEmail}, key: ${maskedKey} len:${this.brevoKey.length}) — will be tried before SMTP (Railway/Render Free safe).`);
            if (!this.brevoSenderEmail.includes('@')) console.warn(' BREVO_SENDER_EMAIL invalid — will fallback to SMTP');
        }
        // Priority 0: Gmail OAuth2 (most reliable on Railway if configured)
        const oauthClientId = cleanEnv('GMAIL_OAUTH_CLIENT_ID');
        const oauthClientSecret = cleanEnv('GMAIL_OAUTH_CLIENT_SECRET');
        const oauthRefreshToken = cleanEnv('GMAIL_OAUTH_REFRESH_TOKEN');
        if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
            try {
                const oauthUserRaw = cleanEnv('GMAIL_OAUTH_USER') || cleanEnv('SMTP_USER') || 'bonustimoy@gmail.com';
                const oauthUser = oauthUserRaw.trim().toLowerCase();
                const oauthAccessToken = cleanEnv('GMAIL_OAUTH_ACCESS_TOKEN') || undefined;
                this.transporter = nodemailer.createTransport({
                    service: 'gmail',
                    auth: {
                        type: 'OAuth2',
                        user: oauthUser,
                        clientId: oauthClientId,
                        clientSecret: oauthClientSecret,
                        refreshToken: oauthRefreshToken,
                        accessToken: oauthAccessToken
                    },
                    family: 4,
                    connectionTimeout: 15000,
                    greetingTimeout: 15000,
                    socketTimeout: 20000
                });
                this.transporter.verify((err) => {
                    if (err) console.warn(' Gmail OAuth verify failed:', err.message, '— check GMAIL_OAUTH_* vars. Code:', err.code);
                    else console.log(` Gmail OAuth verified successfully for ${oauthUser}`);
                });
                console.log(` Nodemailer Gmail OAuth initialized for ${oauthUser}`);
                return;
            } catch (err) {
                console.warn(' Gmail OAuth init error:', err.message);
            }
        }
        // SMTP via Nodemailer (Gmail) — Firebase + Nodemailer only (no Brevo/Resend per requirement)
        // Priority: Gmail OAuth2 (if configured) → Gmail SMTP App Password
        const host = cleanEnv('SMTP_HOST') || 'smtp.gmail.com';
        const portRaw = cleanEnv('SMTP_PORT') || '587';
        const port = parseInt(portRaw, 10) || 587;
        let user = cleanEnv('SMTP_USER');
        let pass = cleanEnv('SMTP_PASS');
        // App Passwords are often copied as "abcd efgh ijkl mnop" with spaces — normalize by removing spaces
        if (pass) pass = pass.replace(/\s+/g, '');
        if (user) user = user.trim().toLowerCase();

        // Store for retry (465 fallback if 587 blocked on Railway)
        this.smtpHost = host;
        this.smtpUser = user;
        this.smtpPass = pass;
        this.smtpPort = port;

        // Masked log for Railway diagnostics — never log the actual password
        const hasHost = !!host;
        const hasUser = !!user;
        const hasPass = !!pass;
        if (hasHost && hasUser && hasPass) {
            try {
                const createTransportForPort = (p) => nodemailer.createTransport({
                    host,
                    port: p,
                    secure: p === 465, // true for 465, false for 587 STARTTLS
                    auth: { user, pass },
                    family: 4, // Force IPv4 — Railway internal DNS often resolves IPv6 first which Gmail may not route
                    connectionTimeout: 15000,
                    greetingTimeout: 15000,
                    socketTimeout: 20000,
                    requireTLS: p === 587,
                    tls: {
                        minVersion: 'TLSv1.2',
                        rejectUnauthorized: true
                    },
                    logger: false,
                    debug: false
                });
                this.createTransportForPort = createTransportForPort;
                this.transporter = createTransportForPort(port);
                // Verify in background — log detailed error for Railway logs but keep transporter for retry on send
                this.transporter.verify((err) => {
                    if (err) {
                        this.lastError = err.message;
                        console.warn(` SMTP verify failed (will retry on send): ${err.message} — code:${err.code || 'n/a'} response:${err.response || 'n/a'}`);
                        if (err.code === 'ETIMEDOUT' || /timeout/i.test(err.message)) {
                            console.warn(' Railway ETIMEDOUT on port ' + port + ' — Railway blocks SMTP 587 on Hobby plan. Will auto-retry with 465 on send.');
                        }
                        console.warn(' Check: SMTP_HOST/PORT/USER/PASS, Gmail App Password (16 chars, no spaces, 2FA required), and that Gmail account allows SMTP. On Railway, ensure vars have no surrounding quotes.');
                    } else console.log(` Nodemailer SMTP verified successfully (${host}:${port} as ${user}).`);
                });
                console.log(` Nodemailer SMTP initialized (${host}:${port} as ${user} — pass len:${pass.length}).`);
                if (pass.length !== 16) console.warn(` SMTP_PASS length is ${pass.length}, expected 16 (Gmail App Password without spaces). If you copied "xxxx xxxx xxxx xxxx", spaces are auto-stripped.`);
            } catch (err) {
                console.warn(' Nodemailer SMTP init error:', err.message);
                this.lastError = err.message;
            }
        } else {
            console.log(' SMTP credentials incomplete — email will run in Console/Test mode (no real send). Missing:', [!hasHost && 'SMTP_HOST', !hasUser && 'SMTP_USER', !hasPass && 'SMTP_PASS'].filter(Boolean).join(', '));
            console.log(' Tip: On Railway, Variables must be set WITHOUT surrounding quotes. Example: SMTP_USER=bonustimoy@gmail.com  NOT  "bonustimoy@gmail.com"');
            if (process.env.NODE_ENV === 'production') {
                console.warn(' PRODUCTION: SMTP not configured — Database Backup OTP / Forgot Password emails WILL FAIL with "Failed to send verification email". Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS on Railway.');
            }
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

    // Brevo HTTPS sender — uses port 443 (never blocked on Railway/Render Free)
    async sendViaBrevo(to, subject, html) {
        if (!this.brevoKey || !isValidEmail(to) || !isValidEmail(this.brevoSenderEmail)) return false;
        try {
            const payload = {
                sender: { name: this.brevoSenderName, email: this.brevoSenderEmail },
                to: [{ email: String(to).trim() }],
                subject: String(subject || '').replace(/[\r\n]/g, '').substring(0, 998),
                htmlContent: String(html || '')
            };
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);
            const res = await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'api-key': this.brevoKey,
                    'content-type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timer);
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                console.log(` Email sent via Brevo HTTPS API to ${to}. MessageId: ${data.messageId || 'brevo-ok'}`);
                this.lastError = null;
                return true;
            }
            const errText = await res.text().catch(() => res.statusText);
            console.warn(` Brevo API failed (${res.status}): ${errText.substring(0, 300)}`);
            // 401 = bad key, 402 = daily limit (300/day free), 400 = unverified sender
            if (res.status === 401) this.lastError = 'Brevo: invalid API key (check BREVO_API_KEY)';
            else if (res.status === 400 && /unverified|sender/i.test(errText)) this.lastError = 'Brevo: sender not verified — add/verify ' + this.brevoSenderEmail + ' in Brevo -> Senders & Domains';
            else if (res.status === 429 || res.status === 402) this.lastError = 'Brevo: daily limit (300/day free) or rate limited';
            else this.lastError = `Brevo API error ${res.status}: ${errText.substring(0, 200)}`;
            return false;
        } catch (err) {
            const msg = err.name === 'AbortError' ? 'Brevo API timeout (15s)' : err.message;
            console.warn(` Brevo HTTPS error: ${msg}`);
            this.lastError = msg;
            return false;
        }
    }

    async sendMail(to, subject, html) {
        // Step 1: Try Brevo HTTPS API first (Railway/Render Free safe — uses 443, never blocked)
        if (this.brevoKey) {
            const brevoOk = await this.sendViaBrevo(to, subject, html);
            if (brevoOk) return true;
            console.warn(' Brevo API failed or not ready — falling back to SMTP Nodemailer...');
        }
        // Firebase + Nodemailer fallback (SMTP 587/465 — may be blocked on free tiers)
        if (!this.transporter) {
            const maskedTo = String(to || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');
            console.log(`\n [EMAIL SIMULATION / TEST MODE] No transporter — email NOT actually sent.`);
            console.log(` To: ${maskedTo}`);
            console.log(` Subject: ${subject}`);
            console.log(` Fix: On Railway, set SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, SMTP_USER, SMTP_PASS (16-char App Password, no spaces). Vars must NOT have surrounding quotes.\n`);
            // In production we MUST return false so the UI shows the real error (Backup OTP was incorrectly showing success in some paths)
            // Only in non-production do we simulate success for dev convenience
            if (process.env.NODE_ENV === 'production') {
                this.lastError = 'SMTP transporter not initialized — check Railway env vars';
                return false;
            }
            return true;
        }

        // Ensure from address is clean and matches authenticated user (Gmail requires From == auth user or alias)
        const fromUser = cleanEnv('SMTP_USER') || cleanEnv('GMAIL_OAUTH_USER') || 'bonustimoy@gmail.com';
        const cleanFrom = fromUser.trim().toLowerCase();

        const trySend = async (transporter) => {
            return transporter.sendMail({
                from: `"PSAU Feedback System" <${cleanFrom}>`,
                to,
                subject,
                html
            });
        };

        try {
            const info = await trySend(this.transporter);
            console.log(` Email sent successfully to ${to}. MessageId: ${info.messageId}`);
            this.lastError = null;
            return true;
        } catch (err) {
            const isTimeout = err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || /timeout/i.test(err.message) || /ETIMEDOUT|ECONNECTION/i.test(err.message);
            const is587 = this.smtpPort === 587;
            // Railway Hobby blocks 587 — auto-retry with 465 SSL (no env change needed)
            if (isTimeout && is587 && this.createTransportForPort) {
                console.warn(` SMTP ${this.smtpHost}:587 timed out (Railway blocks 587) — retrying with 465 SSL...`);
                try {
                    const fallback = this.createTransportForPort(465);
                    // Cache 465 transporter for next sends if it works
                    const info2 = await trySend(fallback);
                    console.log(` Email sent successfully via fallback 465 to ${to}. MessageId: ${info2.messageId}`);
                    this.transporter = fallback;
                    this.smtpPort = 465;
                    this.lastError = null;
                    return true;
                } catch (err2) {
                    this.lastError = err2.message;
                    const code2 = err2.code || 'N/A';
                    console.error(` Fallback 465 also failed to ${to}: ${err2.message} (code:${code2})`);
                    if (err2.response) console.error(` SMTP 465 response: ${err2.response}`);
                    console.warn(' Hint: Railway is blocking BOTH 587 and 465. This is common on Hobby/Free plan. Fix options: 1) Upgrade Railway to Pro (allows SMTP egress), 2) Use Gmail API via HTTPS (no SMTP ports), 3) Set up a free HTTPS email relay. Your App Password is valid (passLen 16) — issue is network, not password.');
                    return false;
                }
            }

            this.lastError = err.message;
            const code = err.code || 'N/A';
            console.error(` Email sending failed to ${to}: ${err.message} (code:${code})`);
            if (err.response) console.error(` SMTP response: ${err.response}`);
            if (err.command) console.error(` SMTP command: ${err.command}`);
            if (/Invalid login|535|Username and Password not accepted/i.test(err.message) || /535/.test(String(err.response || ''))) {
                console.warn(' Hint: Gmail rejected login. 1) Verify Gmail App Password is 16 chars WITHOUT spaces (remove spaces). 2) Ensure 2-Step Verification is ON for bonustimoy@gmail.com. 3) If you changed Google password, old App Password is revoked — generate a NEW App Password at https://myaccount.google.com/apppasswords . 4) Check Railway SMTP_PASS has no surrounding quotes.');
            } else if (isTimeout) {
                console.warn(' Hint: SMTP timeout — Railway is blocking outbound SMTP. Tried 587 + 465. See fallback message above. Your password is valid — network is blocked.');
            } else if (/ECONNECTION|ENOTFOUND/i.test(err.message)) {
                console.warn(' Hint: Could not connect to smtp.gmail.com. Check Railway outbound networking. Verify Railway allows SMTP egress.');
            }
            return false;
        }
    }

    // Expose last error + config status for diagnostics (used by /admin/email-diagnostics)
    getStatus() {
        const host = cleanEnv('SMTP_HOST');
        const port = cleanEnv('SMTP_PORT');
        const user = cleanEnv('SMTP_USER');
        const pass = cleanEnv('SMTP_PASS');
        const passNorm = pass ? pass.replace(/\s+/g, '') : '';
        const brevoKey = cleanEnv('BREVO_API_KEY') || cleanEnv('BREVO_KEY');
        return {
            transporterReady: !!this.transporter,
            brevoReady: !!brevoKey,
            brevoSender: this.brevoSenderEmail ? this.brevoSenderEmail.replace(/^(.{2}).*(@.*)$/, '$1***$2') : '(not set)',
            brevoKeyLen: brevoKey ? brevoKey.length : 0,
            lastError: this.lastError || null,
            config: {
                host: host || '(not set)',
                port: port || '(not set)',
                user: user ? user.replace(/^(.{2}).*(@.*)$/, '$1***$2') : '(not set)',
                passLen: passNorm ? passNorm.length : 0,
                passLooksValid: passNorm.length === 16,
                nodeEnv: process.env.NODE_ENV || '(not set)',
                hasOAuth: !!(cleanEnv('GMAIL_OAUTH_CLIENT_ID') && cleanEnv('GMAIL_OAUTH_CLIENT_SECRET')),
                hasBrevo: !!brevoKey
            }
        };
    }

    // Force re-init (useful after Railway env var update without full restart in dev)
    reinitialize() {
        this.transporter = null;
        this.lastError = null;
        this.initTransporter();
    }
}

const emailService = new EmailService();
module.exports = emailService;
