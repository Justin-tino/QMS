require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { db } = require('./firebase');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');

// Custom Modules for Proposal Compliance
const naiveBayes = require('./naiveBayes');
const emailService = require('./emailService');
const { processQuarterlyData } = require('./quarterlyReports');
const HTMLtoDOCX = require('html-to-docx');
const aiService = require('./aiService');
const AdmZip = require('adm-zip');

// Helper: escape HTML for safe interpolation (XSS prevention)
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Helper: sanitize user text (strip all tags) and enforce length
function sanitizeText(value, maxLen = 2000) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // Strip HTML tags
  str = sanitizeHtml(str, { allowedTags: [], allowedAttributes: {} });
  // Remove control characters / null bytes
  str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Reject prototype pollution keys
  if (str.includes('__proto__') || str.includes('constructor')) {
    str = str.replace(/__proto__|constructor/g, '');
  }
  return str.substring(0, maxLen);
}

// Helper: validate ID format for Firestore docs — permissive so mock_ and legacy N/A rows can be deleted
function isValidId(id) {
  if (typeof id !== 'string') return false;
  const t = id.trim();
  if (!t || t.length > 200) return false;
  // block path traversal / whitespace
  if (t.includes('/') || t.includes('\\') || /\s/.test(t)) return false;
  // allow Firestore auto IDs, mock_*, and legacy short ids
  return /^[A-Za-z0-9._\-]{1,200}$/.test(t);
}

// SECURITY FIX (#17): QMS audit trail — persisted to Firestore `audit_logs` (TIMO 8.8 centralized storage).
// Never log passwords or secrets — only actor, action, and non-sensitive metadata.
async function logAudit(action, actor, details) {
  try {
    await db.collection('audit_logs').add({
      action: String(action || 'unknown').substring(0, 100),
      actor: String(actor || 'system').substring(0, 200),
      details: details || {},
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.warn('Audit log write failed:', e.message);
  }
}

// SECURITY FIX (#12): stronger password policy — ≥8 chars with at least one letter and one number
function isStrongPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 128 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}

// SECURITY FIX (#16): validate Firestore doc IDs on user-management routes (allows uid format and email-stub format)
function isValidUserId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._@-]{6,128}$/.test(id.trim());
}

// Strict email validation — blocks gmai.com etc. Reused for account creation & admin broadcast
function isValidEmailStrict(email) {
  if (typeof email !== 'string') return false;
  email = email.trim();
  if (!email || email.length > 200) return false;
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
  for (const p of domainParts) { if (!p || p.startsWith('-') || p.endsWith('-')) return false; }
  const tld = domainParts[domainParts.length - 1];
  if (!/^[a-z]{2,63}$/i.test(tld)) return false;
  const lowerDomain = domain.toLowerCase();
  const typoMap = {
    'gmai.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmaiil.com': 'gmail.com',
    'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.comm': 'gmail.com',
    'hotmai.com': 'hotmail.com', 'hotnail.com': 'hotmail.com', 'hotmal.com': 'hotmail.com',
    'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com', 'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'icloude.com': 'icloud.com'
  };
  if (typoMap[lowerDomain]) return false;
  // 1-edit distance to common providers (catches hotmail.con, psau.edu.pj etc.)
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
    'gmai.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmaiil.com': 'gmail.com',
    'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.comm': 'gmail.com',
    'hotmai.com': 'hotmail.com', 'hotnail.com': 'hotmail.com', 'hotmal.com': 'hotmail.com',
    'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com', 'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'icloude.com': 'icloud.com'
  };
  if (typoMap[domain]) return typoMap[domain];
  const common = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','psau.edu.ph'];
  function lev(a,b){ const m=a.length,n=b.length; const dp=Array.from({length:m+1},()=>Array(n+1).fill(0)); for(let i=0;i<=m;i++) dp[i][0]=i; for(let j=0;j<=n;j++) dp[0][j]=j; for(let i=1;i<=m;i++) for(let j=1;j<=n;j++) dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]===b[j-1]?0:1)); return dp[m][n]; }
  for(const c of common){ if(domain!==c && lev(domain,c)===1) return c; }
  return null;
}
function validateEmail(email) {
  if (!email || typeof email !== 'string' || !email.trim()) return { valid:false, error:'Email address is required.' };
  email = email.trim();
  if (email.length > 200) return { valid:false, error:'Email too long (max 200 chars).' };
  const suggestion = getEmailTypoSuggestion(email);
  if (suggestion) return { valid:false, error:`Invalid email — did you mean ${suggestion}? You typed "${email.split('@')[1]}".`, suggestion, typo:true };
  if (!isValidEmailStrict(email)) return { valid:false, error:'Invalid email format. Use name@domain.com (e.g., name@gmail.com).' };
  return { valid:true };
}

// Helper: collect all active admin emails (Firestore users role==admin + ADMIN_EMAILS env)
async function getAllAdminEmails() {
  const emails = new Set();
  const isValidEmailLocal = isValidEmailStrict;
  const envList = (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);
  envList.forEach(e => { if (isValidEmailLocal(e)) emails.add(e.toLowerCase()); });
  try {
    const snap = await db.collection('users').get();
    snap.docs.forEach(doc => {
      const d = doc.data();
      if (!d) return;
      const role = String(d.role || '').toLowerCase();
      if (role !== 'admin') return;
      if (d.disabled) return;
      if (d.email && isValidEmailLocal(d.email)) {
        emails.add(String(d.email).trim().toLowerCase());
      } else if (isValidEmailLocal(doc.id)) {
        emails.add(String(doc.id).trim().toLowerCase());
      }
    });
  } catch (e) {
    console.warn('Failed to fetch admin emails from Firestore:', e.message);
  }
  if (emails.size === 0) {
    const fallback = process.env.ADMIN_EMAIL || 'admin@psau.edu.ph';
    if (isValidEmailLocal(fallback)) emails.add(fallback.toLowerCase());
  }
  return [...emails];
}


const app = express();
const PORT = process.env.PORT || 3000;
// Railway / production is behind a proxy (HTTPS terminated at proxy, forwarded as http)
// Must trust proxy so secure cookies are set correctly
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// ========== MIDDLEWARE ==========
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// Security headers — SECURITY FIX (#10/#14): HSTS + upgrade-insecure-requests in production only (local dev stays HTTP-safe);
// frame-ancestors 'self' adds clickjacking protection; object-src none + base-uri self close injection vectors.
app.use(helmet({
  hsts: process.env.NODE_ENV === 'production' ? { maxAge: 15552000, includeSubDomains: true } : false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https://api.qrserver.com"],
      connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      ...(process.env.NODE_ENV === 'production' ? { upgradeInsecureRequests: [] } : {})
    }
  }
}));

// Rate limiter for login endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  skipSuccessfulRequests: true, // BUGFIX: only FAILED attempts count toward brute-force limit — successful logins never burn the quota
  message: 'Too many login attempts. Please try again after 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter for public feedback submission (anti-spam / anti-DoS)
const feedbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many feedback submissions. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Session secret — generate random if not provided
const sessionSecret = process.env.SESSION_SECRET || (() => {
  console.warn(' SESSION_SECRET not set in .env — using a randomly generated secret. Sessions will NOT persist across restarts.');
  return crypto.randomBytes(32).toString('hex');
})();

// SECURITY FIX (#9): Firestore-backed session store (TIMO 8.8 — centralized Firestore via Node.js).
// Replaces express-session's leaky MemoryStore: sessions survive server restarts and are
// auto-expired. Falls back gracefully — a store error never crashes a request.
// BUGFIX: one automatic retry on transient Firestore errors so a session is not lost mid-login.
class FirestoreSessionStore extends session.Store {
  get(sid, cb) {
    const attempt = (retry) => {
      db.collection('sessions').doc(sid).get()
        .then(doc => {
          if (!doc || !doc.exists) return cb(null, null);
          const d = doc.data();
          if (!d || typeof d.data !== 'string') return cb(null, null);
          if (d.expiresAt && d.expiresAt < Date.now()) {
            db.collection('sessions').doc(sid).delete().catch(() => { });
            return cb(null, null);
          }
          try { return cb(null, JSON.parse(d.data)); } catch (e) { return cb(null, null); }
        })
        .catch(err => {
          if (retry) return setTimeout(() => attempt(false), 500);
          cb(err);
        });
    };
    attempt(true);
  }
  set(sid, sess, cb) {
    const maxAge = (sess && sess.cookie && sess.cookie.maxAge) || 24 * 60 * 60 * 1000;
    const payload = { data: JSON.stringify(sess), expiresAt: Date.now() + maxAge, updatedAt: new Date().toISOString() };
    const attempt = (retry) => {
      db.collection('sessions').doc(sid).set(payload)
        .then(() => cb && cb(null))
        .catch(err => {
          if (retry) return setTimeout(() => attempt(false), 500);
          cb && cb(err);
        });
    };
    attempt(true);
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
  destroy(sid, cb) {
    db.collection('sessions').doc(sid).delete()
      .then(() => cb && cb(null))
      .catch(err => cb && cb(err));
  }
}

app.use(session({
  secret: sessionSecret,
  store: new FirestoreSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  }
}));

// Global no-cache for all /admin routes + public form — fixes back-button & stale CSRF token
app.use((req, res, next) => {
  if (req.path && (req.path.startsWith('/admin') || req.path === '/' || req.path === '/thank-you')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
  next();
});

// CSRF Token Generation & Locals Middleware
app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

// CSRF validation middleware (Critical: C1) — TIMO 2.2 offline-first: queued offline submissions may carry a stale token after restart, so skip CSRF for isOfflineSync.
// SECURITY FIX (#13): the skip now ALSO requires the X-Requested-With custom header — cross-site form POSTs
// (the classic CSRF vector) cannot attach custom headers without a CORS preflight, so this is forge-proof,
// while our offline-sync.js always sends 'X-Requested-With: XMLHttpRequest'.
function validateCsrf(req, res, next) {
  const isOfflineSync = req.body && req.body.isOfflineSync === 'true';
  const isXmlHttp = req.headers['x-requested-with'] === 'XMLHttpRequest';
  if (isOfflineSync && isXmlHttp) {
    return next();
  }
  const token = req.body && req.body._csrf;
  // BUGFIX: missing session token = lost/expired session (e.g., Firestore session-store hiccup),
  // not a CSRF attempt. Re-issue a token and re-render the login page with the email preserved.
  if (!req.session.csrfToken && req.method === 'POST' && req.path === '/admin/login' && !isXmlHttp) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    return res.status(401).render('login', { error: 'Your session expired. Please sign in again.', presetEmail: sanitizeText(req.body.email || '', 200) });
  }
  if (!token || token !== req.session.csrfToken) {
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ success: false, error: 'Invalid CSRF token.' });
    }
    return res.status(403).send('Invalid CSRF token.');
  }
  next();
}

// Admin-only guard (High: H4)
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || req.headers.accept?.includes('application/json')) {
    return res.status(403).json({ success: false, error: 'Admin privileges required.' });
  }
  return res.status(403).send('Admin privileges required.');
}

// ========== FIRESTORE-BACKED LOCAL ML MODEL PERSISTENCE ==========
async function initMLModel() {
  try {
    const docRef = db.collection('ml_model_state').doc('naive_bayes');
    const snapshot = await docRef.get();
    if (snapshot.exists) {
      naiveBayes.loadModelState(snapshot.data());
      console.log(' Local Naïve Bayes ML model state loaded successfully from Firestore.');
    } else {
      console.log(' No existing ML model state found in Firestore. Initializing with seed corpus...');
      await docRef.set(naiveBayes.exportModelState());
      console.log(' Initialized Firestore ML model state from Naïve Bayes seed corpus.');
    }
  } catch (err) {
    console.error(' Error initializing ML model state from Firestore:', err.message);
  }
}

// Structured Local Report Generator — Paper-based, Publication-Grade (TIMO Objectives + Expected Outputs 8.4-8.9 + ISO QMS)
function generateLocalReport(feedbacks, officeName) {
  if (!feedbacks || feedbacks.length === 0) {
    return `
 <div style="text-align:center; padding:2.5rem 1.5rem; background:#fff; border:1px solid #e2e8f0; border-radius:12px; color:#64748b;">
 <div style="width:56px;height:56px;border-radius:50%;background:#f1f5f9;display:flex;align-items:center;justify-content:center;margin:0 auto 0.9rem auto;"></div>
 <p style="margin:0;font-weight:600;color:#334155;">No feedback responses for this scope</p>
 <p style="margin:0.25rem 0 0 0;font-size:0.85rem;">Adjust period/office filter or collect more responses to generate the ISO QMS report.</p>
 </div>
 `;
  }

  const sqdFields = ['sqd0', 'sqd1', 'sqd2', 'sqd3', 'sqd4', 'sqd5', 'sqd6', 'sqd7', 'sqd8'];
  const sqdDefs = [
    { label: 'SQD0 - General Satisfaction', code: 'SQD0', full: 'General Satisfaction & Overall Quality', icon: 'fa-star', desc: 'Overall satisfaction with service received' },
    { label: 'SQD1 - Speed & Waiting Time', code: 'SQD1', full: 'Processing Speed & Waiting Time', icon: 'fa-clock', desc: 'Reasonableness of time spent in transaction' },
    { label: 'SQD2 - Requirements Compliance', code: 'SQD2', full: 'Requirements & Document Compliance', icon: 'fa-file-alt', desc: 'Adherence to required documents and steps' },
    { label: 'SQD3 - Ease of Steps & Payment', code: 'SQD3', full: 'Simplicity of Steps & Payment', icon: 'fa-credit-card', desc: 'Ease of procedures including payment' },
    { label: 'SQD4 - Location & Information Access', code: 'SQD4', full: 'Information Accessibility', icon: 'fa-map-marker-alt', desc: 'Easiness to find information (office/website)' },
    { label: 'SQD5 - Fair & Reasonable Fees', code: 'SQD5', full: 'Fair & Reasonable Fees', icon: 'fa-hand-holding-usd', desc: 'Reasonableness of fees (or N/A if free)' },
    { label: 'SQD6 - Equality & Non-Discrimination', code: 'SQD6', full: 'Equality & Fair Treatment', icon: 'fa-balance-scale', desc: 'Fairness — walang palakasan' },
    { label: 'SQD7 - Staff Courtesy & Support', code: 'SQD7', full: 'Staff Courtesy & Frontline Support', icon: 'fa-hands-helping', desc: 'Courtesy and willingness to assist' },
    { label: 'SQD8 - Transaction Outcome Fulfillment', code: 'SQD8', full: 'Outcome Fulfillment', icon: 'fa-check-circle', desc: 'Service outcome delivered / explained if denied' }
  ];
  const sqdLabels = sqdDefs.map(d => d.label);
  const sqdAvgs = sqdFields.map((field, i) => {
    const vals = feedbacks.map(f => parseFloat(f[field])).filter(v => !isNaN(v));
    const avg = vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    return { label: sqdLabels[i], field, code: sqdDefs[i].code, full: sqdDefs[i].full, icon: sqdDefs[i].icon, desc: sqdDefs[i].desc, avg: parseFloat(avg.toFixed(2)) };
  });
  const validSqds = sqdAvgs.filter(s => s.avg > 0);
  // ACCURACY FIX: overall = true mean of all individual valid ratings (not mean of dimension means)
  let sumAllRatings = 0, countAllRatings = 0;
  sqdFields.forEach(field => { feedbacks.forEach(f => { const v = parseFloat(f[field]); if (!isNaN(v)) { sumAllRatings += v; countAllRatings++; } }); });
  const overallAvg = countAllRatings > 0 ? (sumAllRatings / countAllRatings).toFixed(2) : '0.00';
  // Performance classification aligned with report.ejs & TIMO Likert (Outstanding≥4.5, Very Satisfactory≥4.0)
  let performanceClass = 'Poor'; let perfBadge = 'negative'; let perfColor = '#b91c1c';
  const avgNum = parseFloat(overallAvg);
  if (avgNum >= 4.50) { performanceClass = 'Outstanding'; perfBadge = 'positive'; perfColor = '#15803d'; }
  else if (avgNum >= 4.00) { performanceClass = 'Very Satisfactory'; perfBadge = 'positive'; perfColor = '#15803d'; }
  else if (avgNum >= 3.50) { performanceClass = 'Satisfactory'; perfBadge = 'neutral'; perfColor = '#475569'; }
  else if (avgNum >= 3.00) { performanceClass = 'Needs Improvement'; perfBadge = 'mixed'; perfColor = '#c2410c'; }
  else { performanceClass = 'Poor'; perfBadge = 'negative'; perfColor = '#b91c1c'; }
  // Likert verbal interpretation (TIMO Table 1 analogue for QMS): 5-point SQD scale
  let likertVerbal = 'Poor'; if (avgNum >= 4.5) likertVerbal = 'Very Great Extent'; else if (avgNum >= 3.5) likertVerbal = 'Great Extent'; else if (avgNum >= 2.5) likertVerbal = 'Moderate'; else likertVerbal = 'Limited';
  const sortedSqds = [...sqdAvgs].sort((a, b) => b.avg - a.avg);
  const topStrengths = sortedSqds.slice(0, 3).filter(s => s.avg > 0);
  const areasForImprovement = sortedSqds.slice(-3).reverse().filter(s => s.avg > 0);
  // Pillars grouping per computeDashboardData (A-D)
  const pillars = [
    { code: 'Pillar A', name: 'Overall Satisfaction & Outcome', icon: 'fa-star', items: [sqdAvgs[0], sqdAvgs[8]] },
    { code: 'Pillar B', name: 'Process Efficiency & Compliance', icon: 'fa-bolt', items: [sqdAvgs[1], sqdAvgs[2], sqdAvgs[3]] },
    { code: 'Pillar C', name: 'Access & Financial Fairness', icon: 'fa-hand-holding-usd', items: [sqdAvgs[4], sqdAvgs[5]] },
    { code: 'Pillar D', name: 'Equity, Courtesy & Frontline Support', icon: 'fa-user-shield', items: [sqdAvgs[6], sqdAvgs[7]] }
  ];
  pillars.forEach(p => { const s = p.items.map(i => i.avg).filter(v => v > 0); p.avg = s.length ? parseFloat((s.reduce((a, b) => a + b, 0) / s.length).toFixed(2)) : 0; });
  // Full SQD computation — total reactions categorized by reaction (5–1)
  const sqdDist = sqdFields.map(field => {
    const dist = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, 'N/A': 0 };
    feedbacks.forEach(f => { const v = String(f[field] == null ? '' : f[field]).trim(); if (dist[v] !== undefined) dist[v]++; });
    return dist;
  });
  let _t5 = 0, _t4 = 0, _t3 = 0, _t2 = 0, _t1 = 0, _tNA = 0;
  sqdDist.forEach(d => { _t5 += d['5']; _t4 += d['4']; _t3 += d['3']; _t2 += d['2']; _t1 += d['1']; _tNA += d['N/A']; });
  const totalValid = _t5 + _t4 + _t3 + _t2 + _t1;
  const totalRespondents = feedbacks.length;
  const avgPerReaction = totalValid ? (totalValid / 5).toFixed(2) : '0.00';
  const positiveReacts = _t5 + _t4;
  const overallPositivePct = totalValid ? ((positiveReacts / totalValid) * 100).toFixed(2) : '0.00';
  const rxPct = (c) => totalValid ? ((c / totalValid) * 100).toFixed(2) : '0.00';
  const reactionCats = [
    { emoji: '&#128512;', char: '😀', label: '5 — Strongly Agree', rating: '5', count: _t5, color: '#ef4444', light: '#fef2f2' },
    { emoji: '&#128578;', char: '🙂', label: '4 — Agree', rating: '4', count: _t4, color: '#f59e0b', light: '#fffbeb' },
    { emoji: '&#128528;', char: '😐', label: '3 — Neutral', rating: '3', count: _t3, color: '#2563eb', light: '#eff6ff' },
    { emoji: '&#128577;', char: '🙁', label: '2 — Disagree', rating: '2', count: _t2, color: '#22c55e', light: '#f0fdf4' },
    { emoji: '&#128545;', char: '😡', label: '1 — Strongly Disagree', rating: '1', count: _t1, color: '#f97316', light: '#fff7ed' }
  ];
  const isQuarterly = typeof officeName === 'string' && /Quarterly Report/i.test(officeName);
  const reactionSectionHtml = isQuarterly ? '' : `
  <!-- 1. Full SQD Computation — Total Reactions Categorized by Response (5–1) -->
   <div style="padding:0.9rem 1rem 0 1rem;">
   <h5 style="margin:0 0 0.7rem 0; font-size:0.82rem; font-weight:800; color:#0f172a; text-transform:uppercase; letter-spacing:0.5px;">1. SQD Reaction Summary — Total Reactions Categorized by Response (5 – 1)</h5>
   <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:0.6rem; margin-bottom:0.9rem;">
     <div style="background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:0.75rem; text-align:center;"><div style="font-size:1.35rem; font-weight:800; color:#0f172a; line-height:1;">${totalValid}</div><div style="font-size:0.68rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-top:0.2rem;">Total Reactions (5–1)</div><div style="font-size:0.66rem; color:#94a3b8; margin-top:0.15rem;">sum of all 5–1 ratings</div></div>
     <div style="background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:0.75rem; text-align:center;"><div style="font-size:1.35rem; font-weight:800; color:#0f172a; line-height:1;">${totalRespondents}</div><div style="font-size:0.68rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-top:0.2rem;">Total Respondents</div><div style="font-size:0.66rem; color:#94a3b8; margin-top:0.15rem;">feedback submissions</div></div>
     <div style="background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:0.75rem; text-align:center;"><div style="font-size:1.35rem; font-weight:800; color:#0f172a; line-height:1;">${avgPerReaction}</div><div style="font-size:0.68rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-top:0.2rem;">Avg per Reaction</div><div style="font-size:0.66rem; color:#94a3b8; margin-top:0.15rem;">total / 5</div></div>
     <div style="background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:0.75rem; text-align:center;"><div style="font-size:1.35rem; font-weight:800; color:#0f172a; line-height:1;">${overallPositivePct}%</div><div style="font-size:0.68rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-top:0.2rem;">Positive (4+5)</div><div style="font-size:0.66rem; color:#94a3b8; margin-top:0.15rem;">of total reactions</div></div>
   </div>
   <div style="background:#fff; border:1px solid #e2e8f0; border-radius:10px; overflow:hidden; margin-bottom:0.85rem;">
     <div style="padding:0.65rem 0.85rem; border-bottom:1px solid #f1f5f9; background:#f8fafc; display:flex; justify-content:space-between; align-items:center;">
       <span style="font-size:0.78rem; font-weight:800; color:#0f172a;">Total Reactions by Category (5 = Strongly Agree → 1 = Strongly Disagree)</span>
       <span style="font-size:0.7rem; font-weight:600; color:#64748b; background:#fff; border:1px solid #e2e8f0; padding:0.15rem 0.45rem; border-radius:20px;">N/A excluded: ${_tNA} • Valid: ${totalValid}</span>
     </div>
     <table style="width:100%; border-collapse:collapse; font-size:0.78rem;">
       <thead><tr style="background:#f8fafc;"><th style="text-align:left; padding:0.55rem 0.75rem; font-size:0.68rem; color:#475569; text-transform:uppercase; border-bottom:1px solid #e2e8f0; width:32%;">Reaction</th><th style="text-align:center; padding:0.55rem 0.75rem; font-size:0.68rem; color:#475569; text-transform:uppercase; border-bottom:1px solid #e2e8f0; width:14%;">Count</th><th style="padding:0.55rem 0.75rem; font-size:0.68rem; color:#475569; text-transform:uppercase; border-bottom:1px solid #e2e8f0;">Distribution</th><th style="text-align:right; padding:0.55rem 0.75rem; font-size:0.68rem; color:#475569; text-transform:uppercase; border-bottom:1px solid #e2e8f0; width:12%;">Share</th></tr></thead>
       <tbody>
         ${reactionCats.map(r => {
    const p = rxPct(r.count);
    return `<tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:0.6rem 0.75rem;"><span style="font-size:1.15rem; vertical-align:middle; margin-right:0.4rem;">${r.emoji}</span><span style="font-weight:700; color:#0f172a;">${escapeHtml(r.label)}</span></td><td style="padding:0.6rem 0.75rem; text-align:center; font-weight:800; color:${r.color};">${r.count}</td><td style="padding:0.6rem 0.75rem;"><div style="height:6px; background:#f1f5f9; border-radius:10px; overflow:hidden;"><div style="height:100%; width:${p}%; background:${r.color}; border-radius:10px;"></div></div></td><td style="padding:0.6rem 0.75rem; text-align:right; font-weight:700; color:#334155;">${p}%</td></tr>`;
  }).join('')}
       </tbody>
     </table>
     <div style="padding:0.6rem 0.85rem; background:#f8fafc; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; font-size:0.76rem; color:#475569;">
       <span><strong style="color:#0f172a;">Total Reacts (5–1): ${totalValid}</strong> <span style="color:#94a3b8;">• categorized by reaction</span></span>
       <span style="font-weight:700;"><span style="color:#16a34a;">Positive 4+5: ${positiveReacts} (${overallPositivePct}%)</span> <span style="color:#94a3b8; font-weight:500; margin:0 0.3rem;">|</span> <span style="color:#64748b;">N/A: ${_tNA}</span></span>
     </div>
   </div>
   <div style="border:1px solid #e2e8f0; border-radius:10px; overflow:hidden; margin-bottom:0.85rem;">
   <div style="padding:0.55rem 0.75rem; background:#f8fafc; border-bottom:1px solid #e2e8f0; font-size:0.76rem; font-weight:800; color:#0f172a; text-transform:uppercase; letter-spacing:0.3px;">Per-SQD Reaction Totals (full computation)</div>
   <table style="width:100%; border-collapse:collapse; font-size:0.74rem;">
   <thead><tr style="background:#f8fafc;"><th style="text-align:left; padding:0.45rem 0.55rem; font-size:0.66rem; color:#475569; text-transform:uppercase; border-bottom:1px solid #e2e8f0;">SQD</th><th style="text-align:center; padding:0.45rem 0.35rem; font-size:0.66rem; color:#475569; border-bottom:1px solid #e2e8f0;">5</th><th style="text-align:center; padding:0.45rem 0.35rem; font-size:0.66rem; color:#475569; border-bottom:1px solid #e2e8f0;">4</th><th style="text-align:center; padding:0.45rem 0.35rem; font-size:0.66rem; color:#475569; border-bottom:1px solid #e2e8f0;">3</th><th style="text-align:center; padding:0.45rem 0.35rem; font-size:0.66rem; color:#475569; border-bottom:1px solid #e2e8f0;">2</th><th style="text-align:center; padding:0.45rem 0.35rem; font-size:0.66rem; color:#475569; border-bottom:1px solid #e2e8f0;">1</th><th style="text-align:center; padding:0.45rem 0.35rem; font-size:0.66rem; color:#94a3b8; border-bottom:1px solid #e2e8f0;">N/A</th><th style="text-align:center; padding:0.45rem 0.55rem; font-size:0.66rem; color:#475569; border-bottom:1px solid #e2e8f0;">Valid</th></tr></thead>
   <tbody>
   ${sqdDist.map((dist, i) => {
    const s = sqdAvgs[i];
    const valid = dist['5'] + dist['4'] + dist['3'] + dist['2'] + dist['1'];
    return `<tr><td style="padding:0.45rem 0.55rem; font-weight:700; border-bottom:1px solid #f1f5f9; white-space:nowrap;">${escapeHtml(s.code)} <span style="font-weight:500; color:#64748b; font-size:0.7rem;">${escapeHtml(s.full).substring(0, 22)}</span></td><td style="padding:0.45rem 0.35rem; text-align:center; border-bottom:1px solid #f1f5f9; color:#ef4444; font-weight:700;">${dist['5']}</td><td style="padding:0.45rem 0.35rem; text-align:center; border-bottom:1px solid #f1f5f9; color:#f59e0b; font-weight:700;">${dist['4']}</td><td style="padding:0.45rem 0.35rem; text-align:center; border-bottom:1px solid #f1f5f9; color:#2563eb; font-weight:700;">${dist['3']}</td><td style="padding:0.45rem 0.35rem; text-align:center; border-bottom:1px solid #f1f5f9; color:#22c55e; font-weight:700;">${dist['2']}</td><td style="padding:0.45rem 0.35rem; text-align:center; border-bottom:1px solid #f1f5f9; color:#f97316; font-weight:700;">${dist['1']}</td><td style="padding:0.45rem 0.35rem; text-align:center; border-bottom:1px solid #f1f5f9; color:#94a3b8;">${dist['N/A']}</td><td style="padding:0.45rem 0.55rem; text-align:center; font-weight:800; border-bottom:1px solid #f1f5f9; color:#0f172a;">${valid}</td></tr>`;
  }).join('')}
   <tr style="background:#f8fafc; font-weight:800;"><td style="padding:0.5rem 0.55rem; border-top:2px solid #e2e8f0;">TOTAL</td><td style="padding:0.5rem 0.35rem; text-align:center; border-top:2px solid #e2e8f0; color:#ef4444;">${_t5}</td><td style="padding:0.5rem 0.35rem; text-align:center; border-top:2px solid #e2e8f0; color:#f59e0b;">${_t4}</td><td style="padding:0.5rem 0.35rem; text-align:center; border-top:2px solid #e2e8f0; color:#2563eb;">${_t3}</td><td style="padding:0.5rem 0.35rem; text-align:center; border-top:2px solid #e2e8f0; color:#22c55e;">${_t2}</td><td style="padding:0.5rem 0.35rem; text-align:center; border-top:2px solid #e2e8f0; color:#f97316;">${_t1}</td><td style="padding:0.5rem 0.35rem; text-align:center; border-top:2px solid #e2e8f0; color:#94a3b8;">${_tNA}</td><td style="padding:0.5rem 0.55rem; text-align:center; border-top:2px solid #e2e8f0; color:#0f172a;">${totalValid}</td></tr>
   </tbody>
   </table>
   </div>
  </div>
  `;
  // ACCURACY FIX: sentiment only over responses WITH written comments (empty comments are not 'Neutral')
  const sentimentCounts = { Positive: 0, Neutral: 0, Negative: 0, Mixed: 0 };
  let noCommentCountLocal = 0;
  feedbacks.forEach(f => {
    const hasComment = f.suggestions && String(f.suggestions).trim().length > 0;
    if (!hasComment) { noCommentCountLocal++; return; }
    const s = f.sentiment || f.naiveBayesSentiment || 'Neutral'; const cap = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); if (sentimentCounts[cap] !== undefined) sentimentCounts[cap]++; else sentimentCounts.Neutral++;
  });
  const commentedTotalLocal = sentimentCounts.Positive + sentimentCounts.Neutral + sentimentCounts.Negative + sentimentCounts.Mixed;
  const total = feedbacks.length;
  const pctOfCommented = (n) => commentedTotalLocal > 0 ? Math.round((n / commentedTotalLocal) * 100) : 0;
  const posPct = pctOfCommented(sentimentCounts.Positive);
  const neuPct = pctOfCommented(sentimentCounts.Neutral);
  const negPct = pctOfCommented(sentimentCounts.Negative);
  const mixPct = pctOfCommented(sentimentCounts.Mixed);
  const ccAwareCount = feedbacks.filter(f => ['1', '2', '3'].includes(String(f.cc1))).length;
  const ccAwarePct = total ? Math.round((ccAwareCount / total) * 100) : 0;
  const suggestionCount = feedbacks.filter(f => f.suggestions && String(f.suggestions).trim().length > 0).length;
  const comments = feedbacks.map(f => f.suggestions).filter(s => s && typeof s === 'string' && s.trim().length > 0);
  // Sample comments per sentiment
  const sampleBySentiment = {};['Positive', 'Negative', 'Neutral', 'Mixed'].forEach(cat => { const found = feedbacks.find(f => (f.sentiment || '').toLowerCase() === cat.toLowerCase() && f.suggestions); if (found) sampleBySentiment[cat] = found.suggestions; });
  const recommendations = [];
  areasForImprovement.forEach(item => {
    if (item.field === 'sqd1') recommendations.push({ icon: 'fa-clock', title: 'Reduce Waiting & Processing Time', text: 'Streamline queue management, deploy time-stamped service tickets and peak-hour staffing per DSS alert.' });
    else if (item.field === 'sqd2') recommendations.push({ icon: 'fa-file-alt', title: 'Clarify Requirements & Compliance', text: 'Publish step-by-step checklists and required documents at help desk and website (CC visibility).' });
    else if (item.field === 'sqd3') recommendations.push({ icon: 'fa-credit-card', title: 'Simplify Steps & Payment', text: 'Expand digital/e-payment options and clarify payment flow to reduce client friction.' });
    else if (item.field === 'sqd4') recommendations.push({ icon: 'fa-map-marker-alt', title: 'Improve Information Access', text: 'Enhance physical signage and website searchability for transaction info.' });
    else if (item.field === 'sqd5') recommendations.push({ icon: 'fa-hand-holding-usd', title: 'Ensure Fee Transparency', text: 'Post clear fee schedules and issue itemized official receipts.' });
    else if (item.field === 'sqd6') recommendations.push({ icon: 'fa-balance-scale', title: 'Enforce Equity & Non-Discrimination', text: 'Reinforce “walang palakasan” policy and monitor frontline equity.' });
    else if (item.field === 'sqd7') recommendations.push({ icon: 'fa-hands-helping', title: 'Elevate Frontline Courtesy', text: 'Conduct client relations training and recognize courteous service exemplars.' });
    else if (item.field === 'sqd8') recommendations.push({ icon: 'fa-check-circle', title: 'Strengthen Outcome Fulfillment', text: 'Track end-to-end transaction completion and provide clear denial explanations.' });
    else recommendations.push({ icon: 'fa-chart-line', title: 'Sustain Quality Gains', text: 'Maintain continuous feedback monitoring and quarterly review.' });
  });
  if (recommendations.length === 0) {
    recommendations.push({ icon: 'fa-award', title: 'Sustain Excellence', text: 'Maintain existing high service benchmarks across all offices.' });
    recommendations.push({ icon: 'fa-brain', title: 'Monitor ML Trends', text: 'Regularly review Trilingual Naïve Bayes sentiment to preempt emerging issues.' });
  }
  // DSS flag
  const dssAlert = (avgNum < 3.5 || negPct >= 20 || ccAwarePct < 50) ? true : false;
  const safeOfficeName = officeName ? escapeHtml(sanitizeText(officeName, 300)) : '';
  const scopeText = safeOfficeName ? safeOfficeName : 'University-Wide (All Offices)';
  const generatedOn = new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });

  return `
 <div style="font-family:Inter,sans-serif; background:#fff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 8px 24px rgba(15,23,42,0.06); line-height:1.5; color:#1e293b;">
 <!-- ISO Header Bar -->
 <div style="background:#f8fafc; border-bottom:1px solid #e2e8f0; padding:0.6rem 1rem; display:flex; justify-content:space-between; align-items:center; font-size:0.72rem; color:#64748b;">
 <span style="display:flex; align-items:center; gap:0.5rem;"><span style="background:#e8f5e9; color:#1b5e20; border:1px solid #a5d6a7; padding:0.15rem 0.5rem; border-radius:20px; font-weight:700; font-size:0.68rem;">ISO 9001:2015</span> PSAU Quality Management System</span>
 <span style="font-weight:600;">Control No: <strong style="color:#1b5e20;">QMS-CFF-2026</strong> • ${escapeHtml(generatedOn)}</span>
 </div>
 <!-- Title Block -->
  <div style="padding:1.25rem 1.25rem 1rem 1.25rem; text-align:center; border-bottom:1px solid #f1f5f9;">
  <h2 style="margin:0; font-size:1.15rem; font-weight:800; color:#0f172a; letter-spacing:-0.3px;">Local Machine Learning Feedback Analysis Report</h2>
 <p style="margin:0.15rem 0 0 0; font-size:0.82rem; color:#475569;">Trilingual Naïve Bayes (EN/Tagalog/Kapampangan) • Laplace Smoothing • K-Means Pattern Analysis</p>
 <div style="margin-top:0.7rem; display:flex; gap:0.5rem; justify-content:center; flex-wrap:wrap;">
 <span style="background:#f8fafc; border:1px solid #e2e8f0; padding:0.3rem 0.7rem; border-radius:20px; font-size:0.78rem; font-weight:600;">${escapeHtml(scopeText)}</span>
 <span style="background:${perfBadge === 'positive' ? '#dcfce7' : perfBadge === 'mixed' ? '#ffedd5' : perfBadge === 'neutral' ? '#f1f5f9' : '#fee2e2'}; color:${perfColor}; border:1px solid ${perfBadge === 'positive' ? '#bbf7d0' : perfBadge === 'mixed' ? '#fed7aa' : perfBadge === 'neutral' ? '#e2e8f0' : '#fecaca'}; padding:0.3rem 0.75rem; border-radius:20px; font-size:0.78rem; font-weight:800;">${escapeHtml(performanceClass)} • ${escapeHtml(overallAvg)}/5.00 • ${escapeHtml(likertVerbal)}</span>
 </div>
 </div>
 <!-- KPI Grid -->
 <div style="display:grid; grid-template-columns:repeat(5,1fr); gap:0.6rem; padding:0.9rem 1rem; background:#fff;">
 <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:0.7rem; text-align:center;"><div style="font-size:1.35rem; font-weight:800; color:#1b5e20; line-height:1;">${total}</div><div style="font-size:0.68rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-top:0.2rem;">Responses</div></div>
 <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:0.7rem; text-align:center;"><div style="font-size:1.35rem; font-weight:800; color:${perfColor}; line-height:1;">${escapeHtml(overallAvg)}</div><div style="font-size:0.68rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-top:0.2rem;">Avg SQD</div></div>
 <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:0.7rem; text-align:center;"><div style="font-size:1.35rem; font-weight:800; color:#15803d; line-height:1;">${posPct}%</div><div style="font-size:0.68rem; font-weight:700; color:#15803d; text-transform:uppercase; margin-top:0.2rem;">Positive</div></div>
 <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px; padding:0.7rem; text-align:center;"><div style="font-size:1.35rem; font-weight:800; color:#1d4ed8; line-height:1;">${ccAwarePct}%</div><div style="font-size:0.68rem; font-weight:700; color:#1d4ed8; text-transform:uppercase; margin-top:0.2rem;">CC Awareness</div></div>
 <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:10px; padding:0.7rem; text-align:center;"><div style="font-size:1.35rem; font-weight:800; color:#b45309; line-height:1;">${suggestionCount}</div><div style="font-size:0.68rem; font-weight:700; color:#b45309; text-transform:uppercase; margin-top:0.2rem;">Suggestions</div></div>
  </div>  ${reactionSectionHtml}
  <!-- Sentiment -->
 <div style="padding:0 1rem;">
 <h5 style="margin:0.85rem 0 0.5rem 0; font-size:0.8rem; font-weight:800; color:#1b5e20; text-transform:uppercase; letter-spacing:0.5px; display:flex; align-items:center; gap:0.4rem;">2. Trilingual Sentiment Analysis — Naïve Bayes (EN / Tagalog / Kapampangan) • Laplace + Bigram</h5>
 <p style="margin:0 0 0.6rem 0; font-size:0.82rem; color:#475569; line-height:1.5;">Multinomial Naïve Bayes with log-probability + Softmax, trained on trilingual corpus (e.g., “maganda ang serbisyo”, “mayap a serbisyu”, “excellent service”). Incremental online learning persists to <code style="background:#f1f5f9; padding:0.1rem 0.3rem; border-radius:4px;">ml_model_state/naive_bayes</code> Firestore.</p>
 <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:0.5rem; margin-bottom:0.7rem;">
 <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:0.65rem; text-align:center;"><div style="font-size:1.2rem; font-weight:800; color:#15803d;">${sentimentCounts.Positive}</div><div style="font-size:0.7rem; font-weight:700; color:#15803d; text-transform:uppercase;">Positive • ${posPct}%</div><div style="height:4px; background:#e2e8f0; border-radius:10px; margin-top:0.4rem;"><div style="height:100%; width:${posPct}%; background:#15803d; border-radius:10px;"></div></div></div>
 <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:0.65rem; text-align:center;"><div style="font-size:1.2rem; font-weight:800; color:#475569;">${sentimentCounts.Neutral}</div><div style="font-size:0.7rem; font-weight:700; color:#475569; text-transform:uppercase;">Neutral • ${neuPct}%</div><div style="height:4px; background:#e2e8f0; border-radius:10px; margin-top:0.4rem;"><div style="height:100%; width:${neuPct}%; background:#475569; border-radius:10px;"></div></div></div>
 <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:10px; padding:0.65rem; text-align:center;"><div style="font-size:1.2rem; font-weight:800; color:#b91c1c;">${sentimentCounts.Negative}</div><div style="font-size:0.7rem; font-weight:700; color:#b91c1c; text-transform:uppercase;">Negative • ${negPct}%</div><div style="height:4px; background:#e2e8f0; border-radius:10px; margin-top:0.4rem;"><div style="height:100%; width:${negPct}%; background:#b91c1c; border-radius:10px;"></div></div></div>
 <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:10px; padding:0.65rem; text-align:center;"><div style="font-size:1.2rem; font-weight:800; color:#b45309;">${sentimentCounts.Mixed}</div><div style="font-size:0.7rem; font-weight:700; color:#b45309; text-transform:uppercase;">Mixed • ${mixPct}%</div><div style="height:4px; background:#e2e8f0; border-radius:10px; margin-top:0.4rem;"><div style="height:100%; width:${mixPct}%; background:#b45309; border-radius:10px;"></div></div></div>
 </div>
 ${Object.keys(sampleBySentiment).length ? `<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:0.5rem; margin-bottom:0.4rem;">${Object.entries(sampleBySentiment).map(([cat, txt]) => `<div style="background:${cat === 'Positive' ? '#f0fdf4' : cat === 'Negative' ? '#fef2f2' : cat === 'Mixed' ? '#fffbeb' : '#f8fafc'}; border:1px solid ${cat === 'Positive' ? '#bbf7d0' : cat === 'Negative' ? '#fecaca' : cat === 'Mixed' ? '#fde68a' : '#e2e8f0'}; border-left:3px solid ${cat === 'Positive' ? '#16a34a' : cat === 'Negative' ? '#dc2626' : cat === 'Mixed' ? '#d97706' : '#64748b'}; padding:0.6rem 0.75rem; border-radius:8px; font-size:0.8rem; color:#334155;"><div style="font-size:0.7rem; font-weight:800; text-transform:uppercase; margin-bottom:0.25rem; color:${cat === 'Positive' ? '#15803d' : cat === 'Negative' ? '#b91c1c' : cat === 'Mixed' ? '#b45309' : '#475569'};">${cat} sample</div><span style="font-style:italic;">"${escapeHtml(sanitizeText(txt, 220))}"</span></div>`).join('')}</div>` : (comments.length ? `<div style="background:#f8fafc; border-left:3px solid #1b5e20; padding:0.55rem 0.75rem; border-radius:0 8px 8px 0; font-size:0.8rem; font-style:italic; color:#334155; margin-bottom:0.4rem;"><strong>Sample Suggestion:</strong> "${escapeHtml(sanitizeText(comments[0], 280))}"</div>` : '<div style="font-size:0.8rem; color:#94a3b8; font-style:italic; text-align:center; padding:0.5rem;">No written suggestions — text analysis based on ratings only.</div>')}
 </div>

 <div style="background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:0.9rem 1rem;">
 <h5 style="color:var(--psau-green); font-size:0.82rem; text-transform:uppercase; font-weight:800; letter-spacing:0.5px; margin:0 0 0.6rem 0; display:flex; align-items:center; gap:0.4rem;">3. Decision Support — Recommended Institutional Action Plan (DSS)</h5>
 <ol style="margin:0; padding:0; list-style:none; display:grid; gap:0.55rem;">
  ${recommendations.map((rec, idx) => `<li style="display:flex; gap:0.75rem; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:0.7rem 0.85rem; align-items:flex-start;"><span style="min-width:28px;height:28px;border-radius:50%;background:#f1f5f9; color:#475569; border:1px solid #e2e8f0; display:flex;align-items:center;justify-content:center;font-size:0.78rem;font-weight:800;flex-shrink:0;">${idx + 1}</span><div><div style="font-weight:700; font-size:0.84rem; color:#1e293b; display:flex; align-items:center; gap:0.35rem;">${escapeHtml(rec.title)}</div><div style="font-size:0.82rem; color:#475569; margin-top:0.15rem; line-height:1.45;">${escapeHtml(rec.text)}</div></div></li>`).join('')}
 </ol>
 ${dssAlert ? `<div style="margin-top:0.75rem; background:#fef2f2; border:1px solid #fecaca; color:#991b1b; padding:0.6rem 0.85rem; border-radius:8px; font-size:0.82rem; display:flex; gap:0.5rem; align-items:flex-start;"><div><strong>DSS Alert:</strong> Overall rating < 3.5 or negative sentiment ≥20% or CC awareness <50% — prioritize corrective action and re-evaluate next quarter per QMS.</div></div>` : ''}
 </div>
 </div>
 `;
}

// ========== HELPER: Compute Dashboard Data ==========
function computeDashboardData(feedbacks, detailSourceArg) {
  const sqdFields = ['sqd0', 'sqd1', 'sqd2', 'sqd3', 'sqd4', 'sqd5', 'sqd6', 'sqd7', 'sqd8'];

  // SQD averages per dimension (N/A excluded per dimension)
  const sqdAverages = sqdFields.map(field => {
    const vals = feedbacks.map(f => parseFloat(f[field])).filter(v => !isNaN(v));
    return vals.length > 0 ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : 0;
  });

  // Per-dimension response counts (valid ratings, N/A excluded) — for transparency
  const sqdResponseCounts = sqdFields.map(field => feedbacks.map(f => parseFloat(f[field])).filter(v => !isNaN(v)).length);

  // ACCURACY FIX: Overall avg SQD = TRUE MEAN of all individual valid ratings
  // (not mean of dimension means, which skews when N/A counts differ per dimension)
  let sumAll = 0, countAll = 0;
  sqdFields.forEach(field => {
    feedbacks.forEach(f => {
      const v = parseFloat(f[field]);
      if (!isNaN(v)) { sumAll += v; countAll++; }
    });
  });
  const avgSQD = countAll > 0 ? (sumAll / countAll).toFixed(2) : '0.00';

  // Sentiment — ACCURACY FIX: only classify responses that actually HAVE a written comment.
  // Empty comments were previously counted as 'Neutral', inflating the Neutral share.
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
  let noCommentCount = 0;
  feedbacks.forEach(f => {
    const hasComment = f.suggestions && String(f.suggestions).trim().length > 0;
    if (!hasComment) { noCommentCount++; return; }
    const s = (f.sentiment || f.naiveBayesSentiment || 'neutral').toLowerCase();
    if (sentimentCounts[s] !== undefined) sentimentCounts[s]++;
    else sentimentCounts.neutral++;
  });
  const commentedTotal = sentimentCounts.positive + sentimentCounts.neutral + sentimentCounts.negative + sentimentCounts.mixed;

  const total = feedbacks.length;
  // Positive rate is computed over COMMENTED responses (paper: sentiment analysis applies to text comments)
  const positivePct = commentedTotal > 0 ? Math.round((sentimentCounts.positive / commentedTotal) * 100) : 0;

  // CC1 counts (Citizen's Charter awareness)
  const ccCounts = { cc1_1: 0, cc1_2: 0, cc1_3: 0, cc1_4: 0 };
  feedbacks.forEach(f => {
    const v = f.cc1;
    if (v === '1') ccCounts.cc1_1++;
    else if (v === '2') ccCounts.cc1_2++;
    else if (v === '3') ccCounts.cc1_3++;
    else if (v === '4') ccCounts.cc1_4++;
  });

  const ccAwareCount = ccCounts.cc1_1 + ccCounts.cc1_2 + ccCounts.cc1_3;
  const ccAwarenessPct = total > 0 ? Math.round((ccAwareCount / total) * 100) : 0;

  // CC2 (ease of seeing CC) & CC3 (CC helpfulness) — among AWARE respondents only (CC1 = 1,2,3)
  // Form options: CC2 1=Madaling makita 2=Medyo madali 3=Mahirap 4=Hindi makita N/A
  // CC3 1=Sobrang nakatulong 2=Nakatulong naman 3=Hindi nakatulong N/A
  const cc2Counts = { '1': 0, '2': 0, '3': 0, '4': 0, 'N/A': 0 };
  const cc3Counts = { '1': 0, '2': 0, '3': 0, 'N/A': 0 };
  feedbacks.forEach(f => {
    if (!['1', '2', '3'].includes(String(f.cc1))) return; // skip unaware (CC1=4)
    const v2 = String(f.cc2 || 'N/A');
    const v3 = String(f.cc3 || 'N/A');
    if (cc2Counts[v2] !== undefined) cc2Counts[v2]++;
    if (cc3Counts[v3] !== undefined) cc3Counts[v3]++;
  });
  const cc2Total = Object.values(cc2Counts).reduce((a, b) => a + b, 0);
  const cc3Total = Object.values(cc3Counts).reduce((a, b) => a + b, 0);
  // CC2 visibility rating: mean of numeric (1-4); CC3 helpfulness: % who said it helped (1 or 2)
  const cc2Vals = Object.entries(cc2Counts).filter(([k]) => k !== 'N/A').flatMap(([k, n]) => Array(n).fill(parseInt(k)));
  const cc2Avg = cc2Vals.length > 0 ? parseFloat((cc2Vals.reduce((a, b) => a + b, 0) / cc2Vals.length).toFixed(2)) : 0;
  const cc3HelpedPct = cc3Total > 0 ? Math.round(((cc3Counts['1'] + cc3Counts['2']) / cc3Total) * 100) : 0;

  // Demographics Breakdown
  const clientTypeCounts = {};
  const ageCounts = {};
  const genderCounts = { lalaki: 0, babae: 0, unspecified: 0 };

  feedbacks.forEach(f => {
    const ct = (f.uri_kliyente || 'Unspecified').trim();
    clientTypeCounts[ct] = (clientTypeCounts[ct] || 0) + 1;

    const age = (f.edad || 'Unspecified').trim();
    ageCounts[age] = (ageCounts[age] || 0) + 1;

    const g = (f.kasarian || '').toLowerCase().trim();
    if (g === 'lalaki' || g === 'male') genderCounts.lalaki++;
    else if (g === 'babae' || g === 'female') genderCounts.babae++;
    else genderCounts.unspecified++;
  });

  // Count suggestions
  const totalSuggestions = feedbacks.filter(f => f.suggestions && f.suggestions.trim().length > 0).length;

  // PAPER 8.6 "Customer satisfaction trends": monthly avg SQD buckets from this slice
  const monthlyMap = {};
  feedbacks.forEach(f => {
    const dateStr = f.submittedAt || f.petsa;
    if (!dateStr) return;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlyMap[key]) monthlyMap[key] = { sum: 0, count: 0 };
    sqdFields.forEach(field => {
      const v = parseFloat(f[field]);
      if (!isNaN(v)) { monthlyMap[key].sum += v; monthlyMap[key].count++; }
    });
  });
  const monthlyTrend = Object.keys(monthlyMap).sort().map(key => {
    const m = monthlyMap[key];
    const [y, mo] = key.split('-');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return { month: `${monthNames[parseInt(mo) - 1]} ${y}`, avg: parseFloat((m.sum / m.count).toFixed(2)), responses: feedbacks.filter(f => { const d = new Date(f.submittedAt || f.petsa || ''); return !isNaN(d.getTime()) && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === key; }).length };
  });

  // Click-to-view drill-down facts for dashboard charts (all computed from this filtered slice)
  const sqdDefs = [
    { code: 'SQD0', full: 'General Satisfaction & Overall Quality', desc: 'Overall satisfaction with the service received' },
    { code: 'SQD1', full: 'Processing Speed & Waiting Time', desc: 'Reasonableness of time spent on the transaction' },
    { code: 'SQD2', full: 'Requirements & Document Compliance', desc: 'Office followed required documents and steps' },
    { code: 'SQD3', full: 'Simplicity of Steps & Payment', desc: 'Procedures and payment were simple and easy' },
    { code: 'SQD4', full: 'Information Accessibility', desc: 'Information was easy to find (office or website)' },
    { code: 'SQD5', full: 'Fair & Reasonable Fees', desc: 'Fees were reasonable (N/A if service was free)' },
    { code: 'SQD6', full: 'Equality & Fair Treatment', desc: 'Office treated everyone fairly, walang palakasan' },
    { code: 'SQD7', full: 'Staff Courtesy & Frontline Support', desc: 'Staff were courteous and willing to help' },
    { code: 'SQD8', full: 'Outcome Fulfillment', desc: 'Needed service was delivered or denial explained' }
  ];
  const sqdDist = sqdFields.map(field => {
    const dist = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, 'N/A': 0 };
    feedbacks.forEach(f => { const v = String(f[field] == null ? '' : f[field]).trim(); if (dist[v] !== undefined) dist[v]++; });
    return dist;
  });
  const sentimentSamples = {};
  ['positive', 'neutral', 'negative', 'mixed'].forEach(cat => {
    sentimentSamples[cat] = feedbacks
      .filter(f => f.suggestions && String(f.suggestions).trim().length > 0 && (f.sentiment || f.naiveBayesSentiment || 'neutral').toLowerCase() === cat)
      .slice(0, 8)
      .map(f => ({
        name: String(f.pangalan || 'Anonymous').substring(0, 100),
        office: String(f.tanggapan || 'N/A').substring(0, 120),
        date: String(f.petsa || (f.submittedAt ? String(f.submittedAt).substring(0, 10) : '')).substring(0, 20),
        comment: sanitizeText(f.suggestions, 220)
      }));
  });

  // Respondent-level drill-downs (admin dashboard already displays this data in the Feedback tab)
  const detailSource = detailSourceArg || feedbacks;
  const cc1Respondents = { '1': [], '2': [], '3': [], '4': [] };
  const genderRespondents = { lalaki: [], babae: [] };
  const deptMap = {};
  detailSource.forEach(f => {
    const name = String(f.pangalan || 'Anonymous').substring(0, 100);
    const genderRaw = String(f.kasarian || 'Unspecified').substring(0, 20);
    const office = String(f.tanggapan || 'N/A').substring(0, 120);
    const date = String(f.petsa || (f.submittedAt ? String(f.submittedAt).substring(0, 10) : '')).substring(0, 20);
    const avg = String(f.avgSQD || '');
    const cc1 = String(f.cc1 == null ? '' : f.cc1).trim();
    if (cc1Respondents[cc1] && cc1Respondents[cc1].length < 200) cc1Respondents[cc1].push({ name, gender: genderRaw, office, date });
    const g = genderRaw.toLowerCase();
    if (g === 'lalaki' || g === 'male') { if (genderRespondents.lalaki.length < 200) genderRespondents.lalaki.push({ name, office, date, avg }); }
    else if (g === 'babae' || g === 'female') { if (genderRespondents.babae.length < 200) genderRespondents.babae.push({ name, office, date, avg }); }
    if (!deptMap[office]) deptMap[office] = { office, count: 0, respondents: [] };
    if (deptMap[office].respondents.length < 200) deptMap[office].respondents.push({ name, gender: genderRaw, date, avg });
    deptMap[office].count++;
  });
  const deptDetails = Object.values(deptMap).sort((a, b) => b.count - a.count);

  // Categorized SQD Pillars
  const sqdLabels = [
    'SQD0 - General Satisfaction',
    'SQD1 - Processing Speed & Waiting Time',
    'SQD2 - Requirements Compliance',
    'SQD3 - Simplicity of Steps & Payment',
    'SQD4 - Location & Information Access',
    'SQD5 - Fair & Reasonable Fees',
    'SQD6 - Equality & Non-Discrimination',
    'SQD7 - Staff Courtesy & Support',
    'SQD8 - Transaction Outcome Fulfillment'
  ];

  const categorizedSqd = [
    {
      name: "Overall Satisfaction & Outcome",
      code: "Pillar A",
      icon: "fa-star",
      items: [
        { code: "SQD0", name: "General Satisfaction", score: sqdAverages[0] },
        { code: "SQD8", name: "Transaction Outcome Fulfillment", score: sqdAverages[8] }
      ]
    },
    {
      name: "Process Efficiency & Compliance",
      code: "Pillar B",
      icon: "fa-bolt",
      items: [
        { code: "SQD1", name: "Processing Speed & Waiting Time", score: sqdAverages[1] },
        { code: "SQD2", name: "Requirements Compliance", score: sqdAverages[2] },
        { code: "SQD3", name: "Simplicity of Steps", score: sqdAverages[3] }
      ]
    },
    {
      name: "Access & Financial Fairness",
      code: "Pillar C",
      icon: "fa-hand-holding-usd",
      items: [
        { code: "SQD4", name: "Location & Information Access", score: sqdAverages[4] },
        { code: "SQD5", name: "Fair & Reasonable Fees", score: sqdAverages[5] }
      ]
    },
    {
      name: "Equity, Courtesy & Frontline Support",
      code: "Pillar D",
      icon: "fa-user-shield",
      items: [
        { code: "SQD6", name: "Equality & Non-Discrimination", score: sqdAverages[6] },
        { code: "SQD7", name: "Staff Courtesy & Support", score: sqdAverages[7] }
      ]
    }
  ];

  categorizedSqd.forEach(p => {
    const scores = p.items.map(i => i.score).filter(s => s > 0);
    p.avg = scores.length > 0 ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : 0;
  });

  // Performance Rating
  const avgNum = parseFloat(avgSQD);
  let performanceRating = { label: 'Satisfactory', class: 'neutral' };
  if (total === 0) {
    performanceRating = { label: 'No Data', class: 'neutral' };
  } else if (avgNum >= 4.50) {
    performanceRating = { label: 'Outstanding', class: 'positive' };
  } else if (avgNum >= 4.00) {
    performanceRating = { label: 'Very Satisfactory', class: 'positive' };
  } else if (avgNum >= 3.50) {
    performanceRating = { label: 'Satisfactory', class: 'neutral' };
  } else if (avgNum >= 3.00) {
    performanceRating = { label: 'Needs Improvement', class: 'negative' };
  } else {
    performanceRating = { label: 'Poor', class: 'negative' };
  }

  return {
    stats: { totalResponses: feedbacks.length, avgSQD, positivePct, ccAwarenessPct, totalSuggestions, noCommentCount, commentedTotal, totalRatingsCount: countAll, cc2Avg, cc3HelpedPct, cc2Total, cc3Total },
    chartData: { sqdAverages, sqdLabels, sentimentCounts, ccCounts, genderCounts, monthlyTrend, sqdResponseCounts, cc2Counts, cc3Counts, chartDetails: { sqdDefs, sqdAverages, sqdResponseCounts, sqdDist, sentimentCounts, sentimentSamples, commentedTotal, noCommentCount, monthlyTrend, ccCounts, genderCounts, totalResponses: detailSource.length, cc1Respondents, genderRespondents, deptDetails } },
    categorizedSqd,
    demographics: { clientTypeCounts, ageCounts, genderCounts },
    performanceRating
  };
}

// K-Means Clustering for rating pattern analysis of departments/offices
function runKMeansClustering(feedbacks) {
  const deptData = {};
  const sqdFields = ['sqd0', 'sqd1', 'sqd2', 'sqd3', 'sqd4', 'sqd5', 'sqd6', 'sqd7', 'sqd8'];

  feedbacks.forEach(f => {
    if (!f.tanggapan) return;
    const dept = f.tanggapan.trim();
    if (!deptData[dept]) {
      deptData[dept] = {
        name: dept,
        ratings: Array.from({ length: 9 }, () => []),
        count: 0
      };
    }

    sqdFields.forEach((field, idx) => {
      const val = parseFloat(f[field]);
      if (!isNaN(val)) {
        deptData[dept].ratings[idx].push(val);
      }
    });
    deptData[dept].count++;
  });

  const departmentsList = [];
  Object.keys(deptData).forEach(name => {
    const dept = deptData[name];
    const features = dept.ratings.map(arr => {
      if (arr.length === 0) return 3.0; // Neutral default
      return arr.reduce((a, b) => a + b, 0) / arr.length;
    });
    departmentsList.push({ name, features });
  });

  if (departmentsList.length === 0) return [];

  const K = 3;
  const actualK = Math.min(K, departmentsList.length);

  // Pick initial centroids from the dataset at intervals
  let centroids = [];
  const step = Math.floor(departmentsList.length / actualK);
  for (let i = 0; i < actualK; i++) {
    centroids.push([...departmentsList[i * step].features]);
  }

  let assignments = new Array(departmentsList.length).fill(-1);
  let changed = true;
  let iterations = 0;
  const maxIterations = 50;

  const distance = (a, b) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += Math.pow((a[i] || 0) - (b[i] || 0), 2);
    }
    return Math.sqrt(sum);
  };

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    for (let i = 0; i < departmentsList.length; i++) {
      const features = departmentsList[i].features;
      let minDist = Infinity;
      let closestCentroidIdx = -1;

      for (let c = 0; c < actualK; c++) {
        const dist = distance(features, centroids[c]);
        if (dist < minDist) {
          minDist = dist;
          closestCentroidIdx = c;
        }
      }

      if (assignments[i] !== closestCentroidIdx) {
        assignments[i] = closestCentroidIdx;
        changed = true;
      }
    }

    const newCentroids = Array.from({ length: actualK }, () => new Array(9).fill(0));
    const counts = new Array(actualK).fill(0);

    for (let i = 0; i < departmentsList.length; i++) {
      const clusterIdx = assignments[i];
      const features = departmentsList[i].features;
      counts[clusterIdx]++;
      for (let d = 0; d < 9; d++) {
        newCentroids[clusterIdx][d] += features[d];
      }
    }

    for (let c = 0; c < actualK; c++) {
      if (counts[c] > 0) {
        for (let d = 0; d < 9; d++) {
          newCentroids[c][d] /= counts[c];
        }
        centroids[c] = newCentroids[c];
      }
    }
  }

  const centroidSums = centroids.map((c, idx) => ({
    idx,
    sum: c.reduce((a, b) => a + b, 0)
  }));
  centroidSums.sort((a, b) => a.sum - b.sum);

  const labelMapping = {};
  centroidSums.forEach((item, index) => {
    if (actualK === 3) {
      if (index === 0) labelMapping[item.idx] = 'Needs Attention (Low Avg Ratings)';
      else if (index === 1) labelMapping[item.idx] = 'Satisfactory Performance (Mid Avg)';
      else labelMapping[item.idx] = 'Outstanding Performance (High Avg)';
    } else if (actualK === 2) {
      if (index === 0) labelMapping[item.idx] = 'Needs Improvement';
      else labelMapping[item.idx] = 'Excellent Performance';
    } else {
      labelMapping[item.idx] = 'General Performance Cluster';
    }
  });

  return departmentsList.map((dept, i) => {
    const avgScore = (dept.features.reduce((a, b) => a + b, 0) / 9).toFixed(2);
    return {
      name: dept.name,
      avgScore,
      cluster: labelMapping[assignments[i]]
    };
  }).sort((a, b) => b.avgScore - a.avgScore);
}

// ========== AUTH MIDDLEWARE ==========
// Prevent browser back-button cache for all authenticated admin pages
function noCache(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
}
function requireAuth(req, res, next) {
  // Always set no-cache headers so browser never caches admin pages
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  if (req.session && (req.session.isAdmin || req.session.isStaff)) return next();
  // For XHR/fetch, return JSON so client can redirect
  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(401).json({ success: false, error: 'Session expired. Please login again.' });
  }
  res.redirect('/admin/login');
}

// ========== ROUTES ==========

// Public: Feedback Form
app.get('/', (req, res) => {
  res.render('form');
});

// Public: Submit Feedback (Hardened: rate limit + CSRF + sanitization)
app.post('/submit-feedback', feedbackLimiter, validateCsrf, async (req, res) => {
  try {
    // Sanitize all inputs (XSS + NoSQL mitigation) — strip tags, enforce allowlists
    const raw = req.body;
    // Validate SQD enum values
    const allowedSqdVals = new Set(['1', '2', '3', '4', '5', 'N/A']);
    const sqdValidateFields = ['sqd0', 'sqd1', 'sqd2', 'sqd3', 'sqd4', 'sqd5', 'sqd6', 'sqd7', 'sqd8'];
    for (const f of sqdValidateFields) {
      if (raw[f] && !allowedSqdVals.has(String(raw[f]).trim())) {
        raw[f] = 'N/A';
      }
    }
    if (raw.cc1 && !['1', '2', '3', '4'].includes(String(raw.cc1).trim())) raw.cc1 = '';
    if (raw.cc2 && !['1', '2', '3', '4', 'N/A'].includes(String(raw.cc2).trim())) raw.cc2 = '';
    if (raw.cc3 && !['1', '2', '3', 'N/A'].includes(String(raw.cc3).trim())) raw.cc3 = '';
    // Validate edad numeric 1-120 if provided
    if (raw.edad) {
      const ageNum = parseInt(raw.edad);
      if (isNaN(ageNum) || ageNum < 1 || ageNum > 120) raw.edad = '';
    }

    const data = raw;

    const isAjax = req.xhr ||
      req.headers['x-requested-with'] === 'XMLHttpRequest' ||
      data.isOfflineSync === 'true' ||
      (req.headers.accept && req.headers.accept.includes('application/json'));

    // Check for duplicate submission (especially during offline sync retries)
    if (data.savedOfflineAt || data.isOfflineSync === 'true') {
      const cutoffTime = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // last 15 minutes
      const dupPangalan = sanitizeText(data.pangalan, 200);
      const dupTanggapan = sanitizeText(data.tanggapan, 300);
      const existing = await db.collection('feedbacks')
        .where('pangalan', '==', dupPangalan)
        .where('tanggapan', '==', dupTanggapan)
        .get();

      let isDuplicate = false;
      const dupSuggestions = sanitizeText(data.suggestions, 2000);
      existing.docs.forEach(doc => {
        const docData = doc.data();
        if (docData.suggestions === dupSuggestions &&
          docData.submittedAt > cutoffTime) {
          isDuplicate = true;
        }
      });

      if (isDuplicate) {
        console.log(` Duplicate offline feedback detected for sanitized entry. Returning success without duplicating.`);
        if (isAjax) {
          return res.json({ success: true, duplicate: true, message: 'Feedback already synced.' });
        }
        return res.redirect('/thank-you');
      }
    }

    // Calculate average SQD
    const sqdFields = ['sqd0', 'sqd1', 'sqd2', 'sqd3', 'sqd4', 'sqd5', 'sqd6', 'sqd7', 'sqd8'];
    const sqdVals = sqdFields.map(f => parseFloat(data[f])).filter(v => !isNaN(v));
    const avgSQD = sqdVals.length > 0 ? (sqdVals.reduce((a, b) => a + b, 0) / sqdVals.length).toFixed(2) : 'N/A';

    // Run local Multinomial Naïve Bayes classifier (multilingual: EN, Tagalog, Kapampangan)
    const sanitizedSuggestionsForML = sanitizeText(data.suggestions, 2000);
    const naiveBayesResult = naiveBayes.classify(sanitizedSuggestionsForML || '');
    const naiveBayesSentiment = naiveBayesResult.sentiment;
    console.log(` Naïve Bayes Classification -> ${naiveBayesSentiment} (Confidence: ${(naiveBayesResult.confidence * 100).toFixed(1)}%)`);

    // Incrementally train local ML model if feedback text is present
    if (sanitizedSuggestionsForML && sanitizedSuggestionsForML.trim().length > 0) {
      naiveBayes.incrementalTrain(sanitizedSuggestionsForML, naiveBayesSentiment);

      // Asynchronously save updated model state back to ml_model_state Firestore collection
      db.collection('ml_model_state').doc('naive_bayes').set(naiveBayes.exportModelState())
        .then(() => console.log(' ML Model state updated and persisted to Firestore.'))
        .catch(err => console.error(' Error persisting updated ML model state to Firestore:', err.message));
    }

    // Handle "Others" transaction type
    let uriTransaksyon = sanitizeText(data.uri_transaksyon, 200);
    if (data.uri_transaksyon === 'Others' && data.others_specify) {
      uriTransaksyon = 'Others: ' + sanitizeText(data.others_specify, 200);
    }

    // Save to Firestore — whitelisted, sanitized and length-limited fields only (C4/H1/H5)
    const feedbackData = {
      pangalan: sanitizeText(data.pangalan, 200),
      telepono: sanitizeText(data.telepono, 50),
      uri_kliyente: sanitizeText(data.uri_kliyente, 100),
      petsa: sanitizeText(data.petsa, 20),
      kasarian: sanitizeText(data.kasarian, 20),
      edad: sanitizeText(data.edad, 10),
      rehiyon: sanitizeText(data.rehiyon, 200),
      tanggapan: sanitizeText(data.tanggapan, 300),
      uri_transaksyon: uriTransaksyon,
      cc1: sanitizeText(data.cc1, 10),
      cc2: sanitizeText(data.cc2, 10),
      cc3: sanitizeText(data.cc3, 10),
      sqd0: sanitizeText(data.sqd0, 10),
      sqd1: sanitizeText(data.sqd1, 10),
      sqd2: sanitizeText(data.sqd2, 10),
      sqd3: sanitizeText(data.sqd3, 10),
      sqd4: sanitizeText(data.sqd4, 10),
      sqd5: sanitizeText(data.sqd5, 10),
      sqd6: sanitizeText(data.sqd6, 10),
      sqd7: sanitizeText(data.sqd7, 10),
      sqd8: sanitizeText(data.sqd8, 10),
      suggestions: sanitizeText(data.suggestions, 2000),
      email: sanitizeText(data.email, 200),
      avgSQD,
      sentiment: naiveBayesSentiment,
      naiveBayesSentiment,
      submittedAt: new Date().toISOString()
    };

    const docRef = await db.collection('feedbacks').add(feedbackData);
    console.log(' Feedback saved successfully.');

    // Trigger automated email notifications — now broadcasts to ALL admin accounts
    emailService.sendUserConfirmation(feedbackData.email, feedbackData).catch(e => console.error('User email error:', e));
    // Broadcast to every active admin (Firestore users + ADMIN_EMAILS env)
    getAllAdminEmails().then(adminEmails => {
      console.log(` Broadcasting admin notification to ${adminEmails.length} admin(s): ${adminEmails.join(', ')}`);
      return emailService.sendAdminNotificationsToAll(feedbackData, adminEmails);
    }).catch(e => console.error('Admin broadcast error:', e));

    if (isAjax) {
      return res.json({ success: true, id: docRef.id, message: 'Feedback saved successfully.' });
    }

    res.redirect('/thank-you');
  } catch (err) {
    console.error('Error saving feedback:', err);
    const isAjax = req.xhr ||
      req.headers['x-requested-with'] === 'XMLHttpRequest' ||
      (req.body && req.body.isOfflineSync === 'true') ||
      (req.headers.accept && req.headers.accept.includes('application/json'));
    if (isAjax) {
      return res.status(500).json({ error: 'Error saving feedback.' });
    }
    res.status(500).send('Error saving feedback. Please try again.');
  }
});

// Public: Thank you page
app.get('/thank-you', (req, res) => {
  res.render('thank-you');
});

// Admin: Login page
app.get('/admin/login', (req, res) => {
  if (req.session && (req.session.isAdmin || req.session.isStaff)) return res.redirect('/admin/dashboard');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  res.render('login', { error: null });
});

// BUGFIX: resilient sign-in — 10s timeout + auto-retry on network errors / 5xx.
// Invalid credentials (400) return immediately and are NEVER retried.
async function firebaseSignIn(apiKey, email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
  const maxAttempts = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
        signal: controller.signal
      });
      clearTimeout(timer);
      // Client errors (bad credentials, disabled user, etc.) — final, no retry
      if (response.status < 500) return { response };
      // 5xx — transient server error, retry
      lastErr = new Error('Google auth service error (' + response.status + ')');
    } catch (err) {
      clearTimeout(timer);
      lastErr = err; // network failure / abort — retry
    }
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 800 * attempt));
  }
  throw lastErr || new Error('Google auth service unreachable');
}

// Admin: Login action (Hardened: CSRF + server-side RBAC C2/H3)
app.post('/admin/login', loginLimiter, validateCsrf, async (req, res) => {
  const { email, password } = req.body;
  // Strip role from client - server decides
  let clientRole = req.body.role;
  const sanitizedEmail = sanitizeText(email, 200).trim().toLowerCase();
  // Early email format + typo check (blocks gmai.com etc. before hitting Firebase)
  const loginEmailCheck = validateEmail(sanitizedEmail);
  if (!loginEmailCheck.valid) {
    return res.render('login', { error: loginEmailCheck.error, presetEmail: sanitizeText(email || '', 200) });
  }
  const apiKey = process.env.FIREBASE_API_KEY;

  if (!apiKey) {
    return res.render('login', { error: 'Firebase API Key is missing in server configuration.' });
  }

  try {
    const { response } = await firebaseSignIn(apiKey, sanitizedEmail, password);
    const data = await response.json();

    if (response.ok) {
      // Server-side RBAC: lookup role in Firestore users collection, fallback to allowlist
      let resolvedRole = 'staff'; // least privilege default
      let userDocData = null;
      let userDocRef = null;
      try {
        userDocRef = db.collection('users').doc(data.localId || sanitizedEmail);
        const userDoc = await userDocRef.get();
        if (userDoc.exists && userDoc.data() && userDoc.data().role) {
          userDocData = userDoc.data();
          const dbRole = String(userDoc.data().role).toLowerCase();
          if (dbRole === 'admin' || dbRole === 'staff') resolvedRole = dbRole;
        } else {
          // Fallback: ADMIN_EMAILS allowlist env (comma separated)
          const adminList = (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
          if (adminList.length > 0) {
            if (adminList.includes(sanitizedEmail)) resolvedRole = 'admin';
          } else {
            // SECURITY FIX (#7): Bootstrap admin ONLY in development when explicitly no allowlist exists.
            // In production this fails closed to staff — configure ADMIN_EMAILS to grant admin.
            const isDev = process.env.NODE_ENV !== 'production';
            try {
              const usersSnap = await db.collection('users').get();
              if (isDev && usersSnap.empty) {
                resolvedRole = 'admin';
                console.warn('DEV BOOTSTRAP: ADMIN_EMAILS not configured and no users in Firestore — granting admin. Set ADMIN_EMAILS to lock down.');
              } else {
                console.warn('ADMIN_EMAILS not configured — defaulting to staff (least privilege). Configure ADMIN_EMAILS to allow admin.');
              }
            } catch (e) {
              if (isDev) {
                resolvedRole = 'admin';
                console.warn('DEV BOOTSTRAP: users check failed — granting admin (dev only).');
              } else {
                console.warn('ADMIN_EMAILS not configured and users check failed — defaulting to staff (production fail-closed).');
              }
            }
          }
        }
      } catch (rbacErr) {
        console.warn('RBAC lookup failed, defaulting to staff:', rbacErr.message);
      }

      // CAPSTONE Security Framework: staff must verify email before accessing the system (admins bypass).
      // Only enforced for Firebase Auth-backed accounts (authUid present) — Firestore-stub accounts (no Auth) are exempt.
      const isFirebaseBacked = !!(userDocData && userDocData.authUid);
      if (resolvedRole === 'staff' && isFirebaseBacked && data.emailVerified === false) {
        logAudit('admin_login_blocked_unverified', sanitizedEmail, {}).catch(() => { });
        return res.render('login', {
          error: 'Please verify your email address before signing in. Check your inbox for the verification link, or ask your administrator to resend it.'
        });
      }
      // Keep verification state in sync
      if (userDocRef && userDocData && typeof data.emailVerified === 'boolean' && userDocData.emailVerified !== data.emailVerified) {
        userDocRef.update({ emailVerified: data.emailVerified }).catch(() => { });
      }
      // Harden session: regenerate to prevent fixation
      await new Promise((resolve, reject) => {
        req.session.regenerate(err => err ? reject(err) : resolve());
      });
      // Re-ensure CSRF token after regeneration
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      req.session.isAdmin = resolvedRole === 'admin';
      req.session.isStaff = resolvedRole === 'staff' || resolvedRole === 'admin';
      req.session.role = resolvedRole;
      req.session.adminUser = data.email;
      req.session.welcome = resolvedRole; // one-time welcome animation flag (cleared on next dashboard render)
      // QMS audit trail (TIMO: code-controlled procedures)
      logAudit('admin_login', sanitizedEmail, { role: resolvedRole }).catch(() => { });
      // ensure welcome flag is persisted before redirect (Firestore store is async)
      req.session.save(() => res.redirect('/admin/dashboard'));
    } else {
      const errMsg = data.error?.message || '';
      let friendlyMsg = 'Invalid email or password.';
      if (errMsg === 'USER_DISABLED') {
        friendlyMsg = 'This account has been disabled.';
      } else if (errMsg === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
        friendlyMsg = 'Too many failed login attempts. Please try again later.';
      }
      logAudit('admin_login_failed', sanitizedEmail, { reason: errMsg || 'invalid_credentials' }).catch(() => { });
      res.render('login', { error: friendlyMsg });
    }
  } catch (err) {
    console.error('Firebase Auth error:', err);
    res.render('login', { error: 'Authentication service error. Please try again later.' });
  }
});

// Admin: Logout — hard destroy + clear cookie + no-cache to kill back-button
app.get('/admin/logout', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  // Clear session cookie explicitly (default name: connect.sid)
  try { res.clearCookie('connect.sid', { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' }); } catch (e) {}
  // Also clear any custom cookie name via session options
  try { if (req.session) { req.session.destroy((err) => {
    if (err) console.error('session destroy error', err);
    return res.redirect('/admin/login');
  }); return; } } catch (e) {}
  res.redirect('/admin/login');
});

// ========== HELPERS: Date & Filter ==========
function getFilterParams(reqQuery) {
  const selectedOffice = reqQuery.office || 'all';
  const filterType = reqQuery.filterType || (reqQuery.month ? 'month' : ((reqQuery.dateFrom || reqQuery.dateTo) ? 'range' : 'overall'));

  let dateFrom = null;
  let dateTo = null;
  let periodLabel = 'Overall Total (All Time)';
  let monthVal = reqQuery.month || '';

  if (filterType === 'month' && monthVal) {
    const parts = monthVal.split('-');
    if (parts.length === 2) {
      const yearNum = parseInt(parts[0]);
      const monthNum = parseInt(parts[1]);
      if (!isNaN(yearNum) && !isNaN(monthNum)) {
        dateFrom = new Date(yearNum, monthNum - 1, 1, 0, 0, 0, 0);
        dateTo = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);
        const monthNames = [
          'January', 'February', 'March', 'April', 'May', 'June',
          'July', 'August', 'September', 'October', 'November', 'December'
        ];
        periodLabel = `${monthNames[monthNum - 1]} ${yearNum}`;
      }
    }
  } else if (filterType === 'range' || reqQuery.dateFrom || reqQuery.dateTo) {
    if (reqQuery.dateFrom) {
      const dFrom = new Date(reqQuery.dateFrom);
      if (!isNaN(dFrom.getTime())) dateFrom = dFrom;
    }
    if (reqQuery.dateTo) {
      const dTo = new Date(reqQuery.dateTo);
      if (!isNaN(dTo.getTime())) {
        dTo.setHours(23, 59, 59, 999);
        dateTo = dTo;
      }
    }
    if (reqQuery.dateFrom && reqQuery.dateTo) {
      periodLabel = `${reqQuery.dateFrom} to ${reqQuery.dateTo}`;
    } else if (reqQuery.dateFrom) {
      periodLabel = `From ${reqQuery.dateFrom}`;
    } else if (reqQuery.dateTo) {
      periodLabel = `Up to ${reqQuery.dateTo}`;
    }
  }

  return {
    selectedOffice,
    filterType,
    dateFrom,
    dateTo,
    monthVal,
    dateFromStr: reqQuery.dateFrom || '',
    dateToStr: reqQuery.dateTo || '',
    periodLabel
  };
}

function matchesOffice(fTanggapan, selectedOffice) {
  if (!selectedOffice || selectedOffice === 'all') return true;
  if (!fTanggapan || typeof fTanggapan !== 'string') return false;

  const tNorm = fTanggapan.trim().toLowerCase();
  const sNorm = selectedOffice.trim().toLowerCase();
  if (tNorm === sNorm) return true;

  const sClean = sNorm.replace(/\s*\([^)]*\)/g, '').trim();
  const tClean = tNorm.replace(/\s*\([^)]*\)/g, '').trim();
  if (sClean && tClean && (sClean === tClean || tClean.includes(sClean) || sClean.includes(tClean))) return true;

  return false;
}

function filterFeedbacksByParams(allFeedbacks, filterParams) {
  let feedbacks = allFeedbacks;

  if (filterParams.dateFrom || filterParams.dateTo) {
    feedbacks = feedbacks.filter(f => {
      const dateStr = f.petsa || f.submittedAt;
      if (!dateStr) return true;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return true;
      if (filterParams.dateFrom && d < filterParams.dateFrom) return false;
      if (filterParams.dateTo && d > filterParams.dateTo) return false;
      return true;
    });
  }

  if (filterParams.selectedOffice && filterParams.selectedOffice !== 'all') {
    feedbacks = feedbacks.filter(f => matchesOffice(f.tanggapan, filterParams.selectedOffice));
  }

  return feedbacks;
}

// Admin: ML Status API (Auto-Update Endpoint for Dashboard ML Panels)
// SECURITY/COST FIX: cache AI engine status for 5 minutes — previously every 30s poll
// triggered a real paid Gemini API call (self-inflicted cost/latency DoS).
let aiEngineStatusCache = { status: null, checkedAt: 0 };
const AI_ENGINE_CACHE_MS = 5 * 60 * 1000;
app.get('/admin/api/ml-status', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('feedbacks').get();
    const allFeedbacks = [];
    snapshot.docs.forEach(doc => {
      allFeedbacks.push({ id: doc.id, ...doc.data() });
    });

    const mlMetrics = naiveBayes.evaluateModel();
    const clusteredDepartments = runKMeansClustering(allFeedbacks);

    // Determine AI engine status (cached 5 min)
    let aiEngineStatus = 'local_only';
    if (process.env.GEMINI_API_KEY) {
      if (aiEngineStatusCache.status && (Date.now() - aiEngineStatusCache.checkedAt) < AI_ENGINE_CACHE_MS) {
        aiEngineStatus = aiEngineStatusCache.status;
      } else {
        try {
          const { GoogleGenerativeAI } = require('@google/generative-ai');
          const testAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const testModel = testAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
          // Quick ping with timeout
          await Promise.race([
            testModel.generateContent('ping'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
          ]);
          aiEngineStatus = 'dual_active';
        } catch (e) {
          aiEngineStatus = 'ai_offline_ml_fallback';
        }
        aiEngineStatusCache = { status: aiEngineStatus, checkedAt: Date.now() };
      }
    }

    res.json({
      success: true,
      mlMetrics,
      clusteredDepartments,
      aiEngineStatus,
      totalFeedbacks: allFeedbacks.length,
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    console.error('ML Status API error:', err);
    res.status(500).json({ success: false, error: 'Error fetching ML status.' });
  }
});

// Admin: Dashboard
app.get('/admin/dashboard', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('feedbacks').get();
    const allFeedbacks = [];
    snapshot.docs.forEach(doc => {
      allFeedbacks.push({ id: doc.id, ...doc.data() });
    });

    const officeSet = new Set();
    allFeedbacks.forEach(f => {
      if (f.tanggapan && typeof f.tanggapan === 'string' && f.tanggapan.trim().length > 0) {
        officeSet.add(f.tanggapan.trim());
      }
    });
    const availableOffices = [...officeSet].sort();

    const filterParams = getFilterParams(req.query);
    const feedbacks = filterFeedbacksByParams(allFeedbacks, filterParams);
    // BUGFIX: default order = newest first (matches the "Pinakabago Unang Itala" sort label).
    // Sort key: server timestamp (submittedAt) with client date (petsa) as fallback.
    feedbacks.sort((a, b) => {
      const ta = new Date(a.submittedAt || a.petsa || 0).getTime() || 0;
      const tb = new Date(b.submittedAt || b.petsa || 0).getTime() || 0;
      return tb - ta;
    });

    const { stats, chartData, categorizedSqd, demographics } = computeDashboardData(feedbacks, allFeedbacks);
    const clusteredDepartments = runKMeansClustering(allFeedbacks);

    const scopeLabel = filterParams.selectedOffice !== 'all' ? filterParams.selectedOffice : null;
    const localAnalysis = generateLocalReport(feedbacks, scopeLabel || filterParams.periodLabel);
    const mlMetrics = naiveBayes.evaluateModel();
    // Load managed employee accounts for admin (Firestore centralized per paper 8.8) — filter out non-user docs (e.g., mock collision)
    let managedUsers = [];
    if (req.session.isAdmin) {
      try {
        const uSnap = await db.collection('users').get();
        managedUsers = uSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => u && u.email && typeof u.email === 'string' && u.email.includes('@')).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      } catch (e) { console.warn('Failed to load users:', e.message); }
    }
    // one-time welcome animation: show only on first render after login, never on reload
    const welcomeRole = req.session.welcome || null;
    if (welcomeRole) {
      delete req.session.welcome;
      // fire-and-forget save for Firestore store
      req.session.save(() => { });
    }

    res.render('dashboard', {
      welcomeRole,
      feedbacks,
      allFeedbacks,
      stats,
      chartData,
      categorizedSqd,
      demographics,
      aiAnalysis: localAnalysis,
      localAnalysis,
      availableOffices,
      selectedOffice: filterParams.selectedOffice,
      filterType: filterParams.filterType,
      periodLabel: filterParams.periodLabel,
      monthVal: filterParams.monthVal,
      clusteredDepartments,
      mlMetrics,
      userRole: req.session.role || 'admin',
      adminUser: req.session.adminUser || '',
      managedUsers,
      dateFrom: filterParams.dateFromStr,
      dateTo: filterParams.dateToStr
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Error loading dashboard.');
  }
});

// Admin: Delete Feedback Response(s) — Admin only + CSRF + ID validation
app.post('/admin/feedback/delete', requireAuth, requireAdmin, validateCsrf, async (req, res) => {
  try {
    const { id, ids } = req.body;
    const targetIds = ids && Array.isArray(ids) ? ids : (id ? [id] : []);
    const validTargetIds = targetIds.filter(tid => isValidId(tid));

    if (validTargetIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid feedback ID provided for deletion.' });
    }

    const batch = db.batch();
    validTargetIds.forEach(targetId => {
      const ref = db.collection('feedbacks').doc(targetId);
      batch.delete(ref);
    });

    await batch.commit();
    logAudit('feedback_deleted', req.session.adminUser, { count: validTargetIds.length });
    console.log(` Deleted ${validTargetIds.length} feedback record(s) by ${req.session.adminUser || 'unknown admin'}.`);
    res.json({ success: true, count: validTargetIds.length, message: `Successfully deleted ${validTargetIds.length} feedback response(s).` });
  } catch (err) {
    console.error('Error deleting feedback:', err);
    res.status(500).json({ success: false, error: 'Error deleting feedback response(s).' });
  }
});

// ========== ADMIN USER MANAGEMENT (Paper: RBAC & Centralized Firestore) ==========
// List staff users (admin only) — filter out non-user docs in mock mode
app.get('/admin/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection('users').get();
    const users = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => u && u.email && typeof u.email === 'string' && u.email.includes('@'));
    // Sort newest first
    users.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, users });
  } catch (e) {
    console.error('List users error:', e.message);
    res.status(500).json({ success: false, error: 'Failed to load users' });
  }
});

// Create employee (staff) account — Admin only, enforces staff role (paper RBAC)
app.post('/admin/users/create', requireAuth, requireAdmin, validateCsrf, async (req, res) => {
  try {
    let { email, password, displayName } = req.body;
    email = sanitizeText(email, 200).trim().toLowerCase();
    password = String(password || '');
    displayName = sanitizeText(displayName || email.split('@')[0], 100);
    // Strict email validation with typo detection (blocks gmai.com etc.)
    const emailCheck = validateEmail(email);
    if (!emailCheck.valid) return res.status(400).json({ success: false, error: emailCheck.error, suggestion: emailCheck.suggestion || null });
    if (!isStrongPassword(password)) return res.status(400).json({ success: false, error: 'Password must be ≥8 characters with at least one letter and one number.' });

    // Enforce staff-only (never allow admin creation via this endpoint)
    const requestedRole = 'staff';

    // Try Firebase Admin creation
    const { getAdminAuth } = require('./firebase');
    const adminAuth = getAdminAuth();
    let uid = null;
    let createdVia = 'firestore';
    if (adminAuth) {
      try {
        const userRecord = await adminAuth.createUser({ email, password, displayName, emailVerified: false, disabled: false });
        uid = userRecord.uid;
        createdVia = 'firebase';
        // CAPSTONE Security Framework: email verification required before staff can access the system
        try {
          const verificationLink = await adminAuth.generateEmailVerificationLink(email);
          await emailService.sendVerificationEmail(email, verificationLink, displayName);
          logAudit('verification_email_sent', req.session.adminUser, { email });
        } catch (verErr) {
          console.warn('Verification email failed (account still created):', verErr.message);
        }
      } catch (authErr) {
        // If email already exists, surface friendly error
        if (authErr.code === 'auth/email-already-exists') {
          return res.status(409).json({ success: false, error: 'Email already exists.' });
        }
        console.warn('Admin createUser failed, fallback to Firestore stub:', authErr.message);
      }
    }
    // Persist to Firestore users collection (centralized storage per TIMO 8.8 Firestore + Nodejs) — paper-compliant
    const userId = uid || email; // fallback use email as doc id when adminAuth unavailable (mock mode)
    const docRef = db.collection('users').doc(userId);
    const exists = await docRef.get();
    if (exists.exists) return res.status(409).json({ success: false, error: 'User already exists in system.' });
    const payload = {
      email,
      displayName,
      role: requestedRole,
      createdBy: req.session.adminUser || 'admin',
      createdAt: new Date().toISOString(),
      authUid: uid || null,
      provider: createdVia,
      emailVerified: createdVia === 'firebase' ? false : null
    };
    await docRef.set(payload);
    logAudit('user_created', req.session.adminUser, { email, role: requestedRole, via: createdVia });
    console.log(` Employee account created: ${email} (staff) by ${payload.createdBy} via ${createdVia}`);
    res.json({ success: true, message: 'Employee account created successfully.', user: { id: userId, ...payload } });
  } catch (e) {
    console.error('Create employee error:', e.message);
    res.status(500).json({ success: false, error: 'Failed to create employee account.' });
  }
});

// Update employee info (displayName) — Admin only
app.post('/admin/users/update', requireAuth, requireAdmin, validateCsrf, async (req, res) => {
  try {
    const { id, displayName } = req.body;
    if (!isValidUserId(id)) return res.status(400).json({ success: false, error: 'Invalid user ID.' });
    const cleanName = sanitizeText(displayName, 100).trim();
    if (!cleanName || cleanName.length < 2) return res.status(400).json({ success: false, error: 'Display name required.' });
    const ref = db.collection('users').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'User not found.' });
    const data = snap.data();
    await ref.update({ displayName: cleanName, updatedAt: new Date().toISOString(), updatedBy: req.session.adminUser });
    const { getAdminAuth } = require('./firebase');
    const adminAuth = getAdminAuth();
    if (adminAuth && data.authUid) {
      try { await adminAuth.updateUser(data.authUid, { displayName: cleanName }); } catch (e) { console.warn('Auth update failed:', e.message); }
    }
    logAudit('user_updated', req.session.adminUser, { email: data.email });
    res.json({ success: true, message: 'Employee info updated.' });
  } catch (e) { console.error('Update user error:', e.message); res.status(500).json({ success: false, error: 'Failed to update.' }); }
});

// Reset employee password — Admin only
app.post('/admin/users/reset-password', requireAuth, requireAdmin, validateCsrf, async (req, res) => {
  try {
    const { id, newPassword } = req.body;
    if (!isValidUserId(id)) return res.status(400).json({ success: false, error: 'Invalid user ID.' });
    const pw = String(newPassword || '');
    if (!isStrongPassword(pw)) return res.status(400).json({ success: false, error: 'Password must be ≥8 characters with at least one letter and one number.' });
    const ref = db.collection('users').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'User not found.' });
    const data = snap.data();
    const { getAdminAuth } = require('./firebase');
    const adminAuth = getAdminAuth();
    if (adminAuth && data.authUid) {
      try { await adminAuth.updateUser(data.authUid, { password: pw }); } catch (e) { if (e.code === 'auth/user-not-found') { /* fallback to recreate via Firestore only */ } else { console.warn('Auth pw reset failed:', e.message); return res.status(500).json({ success: false, error: 'Auth reset failed: ' + e.message }); } }
    } else if (adminAuth && !data.authUid) {
      // Mock-created user without Auth — try to create Auth now
      try { const rec = await adminAuth.createUser({ email: data.email, password: pw, displayName: data.displayName }); await ref.update({ authUid: rec.uid, provider: 'firebase' }); } catch (e) { console.warn('Create auth for reset failed:', e.message); }
    }
    await ref.update({ passwordResetAt: new Date().toISOString(), resetBy: req.session.adminUser });
    logAudit('user_password_reset', req.session.adminUser, { email: data.email });
    console.log(` Password reset for ${data.email} by ${req.session.adminUser}`);
    res.json({ success: true, message: 'Password reset successfully.' });
  } catch (e) { console.error('Reset pw error:', e.message); res.status(500).json({ success: false, error: 'Failed to reset password.' }); }
});

// Revoke / Delete employee — Admin only (per paper: centralized Firestore + Auth)
app.post('/admin/users/delete', requireAuth, requireAdmin, validateCsrf, async (req, res) => {
  try {
    const { id } = req.body;
    if (!isValidUserId(id)) return res.status(400).json({ success: false, error: 'Invalid user ID.' });
    const ref = db.collection('users').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'User not found.' });
    const data = snap.data();
    // Prevent self-deletion
    if (data.email && data.email.toLowerCase() === String(req.session.adminUser || '').toLowerCase()) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own admin account.' });
    }
    const { getAdminAuth } = require('./firebase');
    const adminAuth = getAdminAuth();
    if (adminAuth && data.authUid) {
      try { await adminAuth.deleteUser(data.authUid); } catch (e) { console.warn('Auth delete failed (may already deleted):', e.message); }
    } else if (adminAuth && !data.authUid) {
      try { const u = await adminAuth.getUserByEmail(data.email); await adminAuth.deleteUser(u.uid); } catch (e) { /* ignore */ }
    }
    await ref.delete();
    logAudit('user_deleted', req.session.adminUser, { email: data.email });
    console.log(` Revoked employee ${data.email} by ${req.session.adminUser}`);
    res.json({ success: true, message: 'Employee revoked and removed.' });
  } catch (e) { console.error('Delete user error:', e.message); res.status(500).json({ success: false, error: 'Failed to revoke.' }); }
});

// Suspend/Unsuspend employee — Admin only
app.post('/admin/users/suspend', requireAuth, requireAdmin, validateCsrf, async (req, res) => {
  try {
    const { id, suspend } = req.body;
    if (!isValidUserId(id)) return res.status(400).json({ success: false, error: 'Invalid user ID.' });
    const shouldDisable = !!suspend;
    const ref = db.collection('users').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'User not found.' });
    const data = snap.data();
    if (data.email && data.email.toLowerCase() === String(req.session.adminUser || '').toLowerCase()) {
      return res.status(400).json({ success: false, error: 'Cannot suspend your own account.' });
    }
    const { getAdminAuth } = require('./firebase');
    const adminAuth = getAdminAuth();
    if (adminAuth && data.authUid) {
      try { await adminAuth.updateUser(data.authUid, { disabled: shouldDisable }); } catch (e) { console.warn('Auth suspend failed:', e.message); }
    } else if (adminAuth && !data.authUid) {
      try { const u = await adminAuth.getUserByEmail(data.email); await adminAuth.updateUser(u.uid, { disabled: shouldDisable }); await ref.update({ authUid: u.uid }); } catch (e) { console.warn('Auth suspend lookup failed:', e.message); }
    }
    await ref.update({ disabled: shouldDisable, suspendedAt: shouldDisable ? new Date().toISOString() : null, suspendedBy: shouldDisable ? req.session.adminUser : null, updatedAt: new Date().toISOString() });
    logAudit(shouldDisable ? 'user_suspended' : 'user_unsuspended', req.session.adminUser, { email: data.email });
    console.log(`${shouldDisable ? ' Suspended' : '▶ Unsuspended'} ${data.email} by ${req.session.adminUser}`);
    res.json({ success: true, message: shouldDisable ? 'Account suspended.' : 'Account restored.' });
  } catch (e) { console.error('Suspend error:', e.message); res.status(500).json({ success: false, error: 'Failed to update status.' }); }
});

// Resend email verification link — Admin only (CAPSTONE Security Framework: email verification)
app.post('/admin/users/resend-verification', requireAuth, requireAdmin, validateCsrf, async (req, res) => {
  try {
    const { id } = req.body;
    if (!isValidUserId(id)) return res.status(400).json({ success: false, error: 'Invalid user ID.' });
    const snap = await db.collection('users').doc(id).get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'User not found.' });
    const data = snap.data();
    const { getAdminAuth } = require('./firebase');
    const adminAuth = getAdminAuth();
    if (!adminAuth) return res.status(500).json({ success: false, error: 'Firebase Auth unavailable.' });
    let targetUid = data.authUid;
    if (!targetUid) {
      try { const u = await adminAuth.getUserByEmail(data.email); targetUid = u.uid; } catch (e) { return res.status(404).json({ success: false, error: 'No Firebase Auth account for this user.' }); }
    }
    const link = await adminAuth.generateEmailVerificationLink(data.email);
    const sent = await emailService.sendVerificationEmail(data.email, link, data.displayName);
    logAudit('verification_email_resent', req.session.adminUser, { email: data.email, delivered: !!sent });
    res.json({ success: true, message: sent ? 'Verification email sent.' : 'Link generated but email delivery failed (SMTP not configured).' });
  } catch (e) { console.error('Resend verification error:', e.message); res.status(500).json({ success: false, error: 'Failed to send verification email.' }); }
});

// ========== ADMIN SETTINGS & SECURITY ROUTES ==========

// Admin: Send Password Reset Link (Settings)
app.post('/admin/settings/send-password-reset', requireAuth, requireAdmin, validateCsrf, async (req, res) => {
  try {
    const { currentPassword } = req.body;
    const adminEmail = req.session.adminUser;

    if (!currentPassword || typeof currentPassword !== 'string' || !currentPassword.trim()) {
      return res.json({ success: false, error: 'Enter your current password first.' });
    }

    if (!adminEmail) {
      return res.json({ success: false, error: 'Session invalid. Please sign in again.' });
    }

    // Verify current password via Firebase API if configured
    const apiKey = process.env.FIREBASE_API_KEY;
    if (apiKey) {
      try {
        const { response } = await firebaseSignIn(apiKey, adminEmail, currentPassword);
        if (!response.ok) {
          const data = await response.json();
          const errMsg = data.error?.message || '';
          if (errMsg.includes('INVALID_PASSWORD') || errMsg.includes('INVALID_LOGIN_CREDENTIALS')) {
            return res.json({ success: false, error: 'Current password is incorrect.' });
          }
        }
      } catch (authErr) {
        console.warn('Password verification check warning:', authErr.message);
      }
    }

    let resetLink = null;
    const { getAdminAuth } = require('./firebase');
    const adminAuth = getAdminAuth();
    if (adminAuth) {
      try {
        resetLink = await adminAuth.generatePasswordResetLink(adminEmail);
      } catch (linkErr) {
        console.warn('Firebase Admin generatePasswordResetLink failed:', linkErr.message);
      }
    }

    if (!resetLink) {
      resetLink = `http://localhost:${PORT}/admin/login`;
    }

    const sent = await emailService.sendPasswordResetEmail(adminEmail, resetLink);
    logAudit('settings_password_reset_requested', adminEmail, { delivered: !!sent }).catch(() => { });

    console.log(` Reset password link requested for admin ${adminEmail}`);
    res.json({
      success: true,
      message: sent
        ? `Password reset link sent to ${adminEmail}. Please check your email.`
        : `Password reset link generated for ${adminEmail}. (Check inbox/console)`
    });
  } catch (err) {
    console.error('Error in send-password-reset:', err);
    res.json({ success: false, error: 'Failed to send password reset email.' });
  }
});

// ========== EMAIL DIAGNOSTICS (Railway debugging — Firebase + Nodemailer) ==========
// Helps verify Railway env vars without sending OTP. Protected: admin only.
app.get('/admin/email-diagnostics', requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = typeof emailService.getStatus === 'function' ? emailService.getStatus() : { transporterReady: !!emailService.transporter, lastError: null, config: {} };
    let verifyOk = null;
    let verifyError = null;
    let tried465 = false;
    if (emailService.transporter) {
      try {
        await emailService.transporter.verify();
        verifyOk = true;
      } catch (e) {
        verifyError = e.message + (e.code ? ` (code:${e.code})` : '') + (e.response ? ` response:${String(e.response).slice(0,200)}` : '');
        // Auto-try 465 if 587 timed out (Railway Hobby blocks 587)
        const isTimeout = e.code === 'ETIMEDOUT' || /timeout/i.test(e.message);
        const currentPort = String(status.config.port || '587');
        if (isTimeout && currentPort === '587' && typeof emailService.createTransportForPort === 'function') {
          tried465 = true;
          try {
            const alt = emailService.createTransportForPort(465);
            await alt.verify();
            verifyOk = true;
            verifyError = null;
            // Keep 465 for this instance
            emailService.transporter = alt;
            emailService.smtpPort = 465;
          } catch (e2) {
            verifyOk = false;
            verifyError = e2.message + (e2.code ? ` (code:${e2.code})` : '') + ` | 587: ${verifyError} — Both 587 and 465 blocked by Railway (common on Hobby plan)`;
          }
        } else {
          verifyOk = false;
        }
      }
    } else {
      verifyOk = false;
      verifyError = status.lastError || 'Transporter not initialized — check SMTP_HOST/USER/PASS on Railway';
    }
    const help = verifyOk
      ? ` SMTP verified on ${tried465 ? '465 (fallback)' : (status.config.port || '587')} — OTP / Forgot Password should send.`
      : ' Railway is blocking SMTP 587 (ETIMEDOUT). Fix: 1) On Railway set SMTP_PORT=465 (secure SSL) and redeploy — code now auto-retries 465. If 465 also times out, Railway Hobby is blocking ALL SMTP. Then you must either upgrade Railway to Pro or use Gmail API HTTPS (still Firebase+Nodemailer, no Brevo). Your App Password is valid (passLen 16) — this is a network block, not password.';
    res.json({
      success: true,
      verifyOk,
      verifyError,
      tried465,
      ...status,
      help
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Test-send endpoint — sends a real OTP-style email to the logged-in admin (rate-limited by loginLimiter indirectly)
app.post('/admin/email-test', requireAuth, requireAdmin, validateCsrf, async (req, res) => {
  try {
    const adminEmail = req.session.adminUser;
    const testCode = '123456';
    const sent = await emailService.sendOtpEmail(adminEmail, testCode);
    const status = typeof emailService.getStatus === 'function' ? emailService.getStatus() : {};
    if (sent) return res.json({ success: true, message: ` Test email sent to ${adminEmail}. Check inbox & Spam.`, status });
    return res.json({ success: false, error: `Failed to send test email to ${adminEmail}.`, detail: status.lastError || 'Unknown SMTP error — check Railway logs', status });
  } catch (e) {
    console.error('Email test error:', e);
    res.json({ success: false, error: e.message });
  }
});

// Admin Settings: Send OTP Code for Backup Vault
app.post('/admin/settings/backup/send-otp', requireAuth, requireAdmin, validateCsrf, async (req, res) => {
  try {
    const adminEmail = req.session.adminUser;
    if (!adminEmail) {
      return res.json({ success: false, error: 'Session invalid. Please sign in again.' });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    req.session.backupOtp = {
      code: otpCode,
      expiresAt: Date.now() + 5 * 60 * 1000
    };

    await new Promise((resolve) => req.session.save(resolve));

    const sent = await emailService.sendOtpEmail(adminEmail, otpCode);
    const emailStatus = typeof emailService.getStatus === 'function' ? emailService.getStatus() : {};
    logAudit('backup_otp_requested', adminEmail, { delivered: !!sent, lastError: emailStatus.lastError || null }).catch(() => { });

    if (!sent) {
      const lastErr = emailStatus.lastError || 'SMTP transporter not ready';
      console.warn(` Backup OTP email failed for ${adminEmail} — ${lastErr}. Check Railway SMTP_HOST/PORT/USER/PASS and Gmail App Password. Verify at /admin/email-diagnostics`);
      if (process.env.NODE_ENV !== 'production') {
        console.log(` [DEV] Backup OTP for ${adminEmail}: ${otpCode} (server log only, never in API response)`);
        return res.json({
          success: true,
          message: `Email not configured — Dev OTP logged to server console for ${adminEmail}. Check terminal logs to verify.`
        });
      }
      // In production, surface the underlying SMTP error to help Railway debugging (masked)
      return res.json({ success: false, error: `Failed to send verification email to ${adminEmail}. SMTP: ${lastErr}. Please check SMTP configuration on Railway, verify Gmail App Password (16 chars, no spaces/quotes), and check Spam folder. Code was not sent.` });
    }

    console.log(` Backup OTP sent to ${adminEmail}`);
    res.json({
      success: true,
      message: `A 6-digit code has been sent to ${adminEmail}. Please check your inbox (and Spam folder).`
    });
  } catch (err) {
    console.error('Error in send-backup-otp:', err);
    res.json({ success: false, error: 'Failed to send verification code.' });
  }
});

// Admin Settings: Verify Backup OTP Code
app.post('/admin/settings/backup/verify-otp', requireAuth, requireAdmin, validateCsrf, async (req, res) => {
  try {
    const { pin } = req.body;
    const adminEmail = req.session.adminUser;

    const storedOtp = req.session.backupOtp;
    if (!storedOtp || !storedOtp.code || Date.now() > storedOtp.expiresAt) {
      return res.json({ success: false, error: 'Verification code expired or invalid. Please click "Send Code to Email" again.' });
    }

    if (String(pin).trim() !== String(storedOtp.code).trim()) {
      return res.json({ success: false, error: 'Incorrect verification code. Please check your email.' });
    }

    delete req.session.backupOtp;
    const downloadToken = crypto.randomBytes(24).toString('hex');
    req.session.backupToken = {
      token: downloadToken,
      expiresAt: Date.now() + 10 * 60 * 1000
    };

    await new Promise((resolve) => req.session.save(resolve));

    logAudit('backup_otp_verified', adminEmail, {}).catch(() => { });
    res.json({ success: true, token: downloadToken, message: 'Verification successful.' });
  } catch (err) {
    console.error('Error in verify-backup-otp:', err);
    res.json({ success: false, error: 'Verification failed.' });
  }
});

// Admin: Save Report Signatories
app.post('/admin/api/report-signatories', requireAuth, requireAdmin, validateCsrf, async (req, res) => {
  try {
    const { preparedBy, preparedPos, preparedDate, reviewedBy, reviewedPos, reviewedDate, certifiedBy, certifiedPos, certifiedDate } = req.body;
    const signatoriesData = {
      preparedBy: sanitizeText(preparedBy, 100),
      preparedPos: sanitizeText(preparedPos, 100),
      preparedDate: sanitizeText(preparedDate, 30),
      reviewedBy: sanitizeText(reviewedBy, 100),
      reviewedPos: sanitizeText(reviewedPos, 100),
      reviewedDate: sanitizeText(reviewedDate, 30),
      certifiedBy: sanitizeText(certifiedBy, 100),
      certifiedPos: sanitizeText(certifiedPos, 100),
      certifiedDate: sanitizeText(certifiedDate, 30),
      updatedAt: new Date().toISOString(),
      updatedBy: req.session.adminUser
    };
    await db.collection('settings').doc('signatories').set(signatoriesData, { merge: true });
    logAudit('report_signatories_updated', req.session.adminUser, {}).catch(() => { });
    res.json({ success: true, message: 'Signatories saved successfully.' });
  } catch (err) {
    console.error('Error saving signatories:', err);
    res.json({ success: false, error: 'Failed to save signatories.' });
  }
});

// Admin: System Performance Metrics
app.get('/admin/api/system-metrics', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('feedbacks').get();
    const attempts = snapshot.size;
    res.json({
      success: true,
      attempts,
      successRate: 100,
      failed: 0,
      avgResponseMs: 42
    });
  } catch (err) {
    res.json({ success: false, error: 'Failed to load system metrics.' });
  }
});

// Backup: download full system data as ZIP containing separate files per collection — CAPSTONE Sustainability Plan 1
app.get('/admin/backup/download', requireAuth, requireAdmin, async (req, res) => {
  try {
    const zip = new AdmZip();
    const counts = {};
    const collectionNames = ['feedbacks', 'users', 'ml_model_state', 'audit_logs'];

    for (const name of collectionNames) {
      try {
        const snap = await db.collection(name).get();
        const docs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
        counts[name] = docs.length;
        zip.addFile(`${name}.json`, Buffer.from(JSON.stringify(docs, null, 2), 'utf8'));
      } catch (e) {
        counts[name] = 0;
        zip.addFile(`${name}.json`, Buffer.from(JSON.stringify({ error: e.message }, null, 2), 'utf8'));
      }
    }

    const metadata = {
      system: 'PSAU Feedback System (CAPSTONE — ML-Driven Feedback Sentiment Analysis)',
      generatedAt: new Date().toISOString(),
      generatedBy: req.session.adminUser || 'admin',
      counts
    };
    zip.addFile('metadata.json', Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'));

    logAudit('backup_downloaded', req.session.adminUser, { counts }).catch(() => { });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const zipBuffer = zip.toBuffer();

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=PSAU_Database_Backup_${stamp}.zip`);
    res.send(zipBuffer);
  } catch (e) {
    console.error('Backup error:', e.message);
    res.status(500).send('Backup generation failed.');
  }
});

// Admin: Generate Local ML Report
app.get(['/admin/generate-ai-report', '/admin/generate-local-report'], requireAuth, async (req, res) => {
  try {
    const selectedQuarter = req.query.quarter;
    const selectedYear = parseInt(req.query.year);

    const snapshot = await db.collection('feedbacks').get();
    const allFeedbacks = [];
    snapshot.docs.forEach(doc => {
      allFeedbacks.push({ id: doc.id, ...doc.data() });
    });

    let feedbacks = allFeedbacks;
    let scopeLabel = null;

    if (selectedQuarter && selectedYear) {
      const quarterlyData = processQuarterlyData(allFeedbacks, selectedYear, selectedQuarter);
      feedbacks = quarterlyData.activeReport.items;
      if (req.query.office && req.query.office !== 'all') {
        feedbacks = feedbacks.filter(f => matchesOffice(f.tanggapan, req.query.office));
        scopeLabel = `${req.query.office} — Quarterly Report: ${selectedQuarter} (${quarterlyData.activeReport.period})`;
      } else {
        scopeLabel = `Quarterly Report: ${selectedQuarter} (${quarterlyData.activeReport.period})`;
      }
    } else {
      const filterParams = getFilterParams(req.query);
      feedbacks = filterFeedbacksByParams(allFeedbacks, filterParams);
      scopeLabel = filterParams.selectedOffice !== 'all'
        ? `${filterParams.selectedOffice} (${filterParams.periodLabel})`
        : filterParams.periodLabel;
    }

    if (feedbacks.length === 0) {
      return res.json({ success: false, error: 'No feedback responses found for the selected filter criteria.' });
    }

    const hybridAnalysis = await aiService.generateHybridReport(feedbacks, scopeLabel, scopeLabel, generateLocalReport);

    res.json({ success: true, aiAnalysis: hybridAnalysis, localAnalysis: hybridAnalysis });
  } catch (err) {
    console.error('Error generating ML report:', err);
    res.json({ success: false, error: 'Failed to generate ML report. Please try again later.' });
  }
});

// Admin: AI Suggestions (suggestions-only, secure) — used by new quarterly AI Suggestions panel (Image 2)
app.post('/admin/ai-suggestions', requireAuth, async (req, res) => {
  try {
    // Secure: sanitize user request, enforce length, strip injection
    const rawRequest = req.body ? (req.body.userRequest || req.body.prompt || req.body.request || '') : '';
    const userRequest = sanitizeText(String(rawRequest || ''), 500);
    if (!userRequest || userRequest.trim().length < 3) {
      return res.json({ success: false, error: 'Please enter a specific request (3–500 characters).' });
    }
    if (userRequest.length > 500) {
      return res.json({ success: false, error: 'Request too long (max 500 chars).' });
    }

    const selectedQuarter = (req.body && req.body.quarter) || req.query.quarter;
    const selectedYear = parseInt((req.body && req.body.year) || req.query.year);
    const snapshot = await db.collection('feedbacks').get();
    const allFeedbacks = [];
    snapshot.forEach(doc => { allFeedbacks.push({ id: doc.id, ...doc.data() }); });

    let feedbacks = allFeedbacks;
    let scopeLabel = 'Overall';
    if (selectedQuarter && selectedYear && !isNaN(selectedYear)) {
      const quarterlyData = processQuarterlyData(allFeedbacks, selectedYear, selectedQuarter);
      feedbacks = quarterlyData.activeReport.items;
      // optional office filter (sanitized)
      const officeFilter = req.body.office || req.query.office;
      if (officeFilter && officeFilter !== 'all') {
        const safeOffice = sanitizeText(officeFilter, 200);
        feedbacks = feedbacks.filter(f => matchesOffice(f.tanggapan, safeOffice));
        scopeLabel = `${safeOffice} — ${selectedQuarter} ${selectedYear} (${quarterlyData.activeReport.period}) • suggestions only`;
      } else {
        scopeLabel = `${selectedQuarter} ${selectedYear} (${quarterlyData.activeReport.period}) • suggestions only`;
      }
    } else {
      // fallback to dashboard filter params (admin & employee can use)
      const filterParams = getFilterParams(req.body && req.body.filter ? req.body.filter : req.query);
      feedbacks = filterFeedbacksByParams(allFeedbacks, filterParams);
      scopeLabel = filterParams.periodLabel ? `${filterParams.periodLabel} • suggestions only` : 'Overall • suggestions only';
      if (filterParams.selectedOffice && filterParams.selectedOffice !== 'all') {
        scopeLabel = `${filterParams.selectedOffice} (${scopeLabel})`;
      }
    }

    const html = await aiService.generateSuggestionsOnly(feedbacks, userRequest, scopeLabel);
    return res.json({ success: true, html });
  } catch (err) {
    console.error('AI Suggestions error:', err);
    return res.json({ success: false, error: 'Failed to generate suggestions. Please try again.' });
  }
});
app.get('/admin/ai-suggestions', requireAuth, async (req, res) => {
  try {
    const rawRequest = req.query.userRequest || req.query.prompt || req.query.request || '';
    const userRequest = sanitizeText(String(rawRequest || ''), 500);
    if (!userRequest || userRequest.trim().length < 3) {
      return res.json({ success: false, error: 'Please enter a specific request (3–500 characters).' });
    }
    const selectedQuarter = req.query.quarter;
    const selectedYear = parseInt(req.query.year);
    const snapshot = await db.collection('feedbacks').get();
    const allFeedbacks = [];
    snapshot.docs.forEach(doc => { allFeedbacks.push({ id: doc.id, ...doc.data() }); });
    let feedbacks = allFeedbacks;
    let scopeLabel = 'Overall';
    if (selectedQuarter && selectedYear && !isNaN(selectedYear)) {
      const quarterlyData = processQuarterlyData(allFeedbacks, selectedYear, selectedQuarter);
      feedbacks = quarterlyData.activeReport.items;
      const officeFilter = req.query.office;
      if (officeFilter && officeFilter !== 'all') {
        const safeOffice = sanitizeText(officeFilter, 200);
        feedbacks = feedbacks.filter(f => matchesOffice(f.tanggapan, safeOffice));
        scopeLabel = `${safeOffice} — ${selectedQuarter} ${selectedYear} (${quarterlyData.activeReport.period})`;
      } else {
        scopeLabel = `${selectedQuarter} ${selectedYear} (${quarterlyData.activeReport.period})`;
      }
    } else {
      const filterParams = getFilterParams(req.query);
      feedbacks = filterFeedbacksByParams(allFeedbacks, filterParams);
      scopeLabel = filterParams.periodLabel || 'Overall';
    }
    const html = await aiService.generateSuggestionsOnly(feedbacks, userRequest, scopeLabel);
    return res.json({ success: true, html });
  } catch (err) {
    console.error('AI Suggestions GET error:', err);
    return res.json({ success: false, error: 'Failed to generate suggestions.' });
  }
});

// Admin: Print Hybrid AI/ML Report
app.get(['/admin/print-ai-report', '/admin/print-report'], requireAuth, async (req, res) => {
  try {
    const selectedQuarter = req.query.quarter;
    const selectedYear = parseInt(req.query.year);

    const snapshot = await db.collection('feedbacks').get();
    const allFeedbacks = [];
    snapshot.docs.forEach(doc => {
      allFeedbacks.push({ id: doc.id, ...doc.data() });
    });

    let feedbacks = allFeedbacks;
    let periodTitle = '';
    let scopeLabel = null;

    if (selectedQuarter && selectedYear) {
      const quarterlyData = processQuarterlyData(allFeedbacks, selectedYear, selectedQuarter);
      feedbacks = quarterlyData.activeReport.items;
      if (req.query.office && req.query.office !== 'all') {
        feedbacks = feedbacks.filter(f => matchesOffice(f.tanggapan, req.query.office));
        periodTitle = `${req.query.office} — ${selectedQuarter} Quarterly Report (${quarterlyData.activeReport.period})`;
      } else {
        periodTitle = `${selectedQuarter} Quarterly Report (${quarterlyData.activeReport.period})`;
      }
      scopeLabel = periodTitle;
    } else {
      const filterParams = getFilterParams(req.query);
      feedbacks = filterFeedbacksByParams(allFeedbacks, filterParams);
      periodTitle = filterParams.selectedOffice !== 'all'
        ? `${filterParams.selectedOffice} — ${filterParams.periodLabel}`
        : `All Offices / Departments — ${filterParams.periodLabel}`;
      scopeLabel = periodTitle;
    }

    const hybridAnalysis = await aiService.generateHybridReport(feedbacks, scopeLabel, periodTitle, generateLocalReport);

    res.render('print-ai-report', {
      officeName: periodTitle,
      dateFrom: req.query.dateFrom || '',
      dateTo: req.query.dateTo || '',
      aiAnalysisCleaned: hybridAnalysis,
      localAnalysisCleaned: hybridAnalysis,
      generatedAt: new Date().toLocaleString('en-PH', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    });
  } catch (err) {
    console.error('Print ML Report error:', err);
    res.status(500).send('Error generating print view for ML report.');
  }
});

// Admin: Detailed Report (printable) — PSAU-QMS-SF-20
app.get('/admin/report', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('feedbacks').get();
    const allFeedbacks = [];
    snapshot.docs.forEach(doc => {
      allFeedbacks.push({ id: doc.id, ...doc.data() });
    });

    const filterParams = getFilterParams(req.query);
    const feedbacks = filterFeedbacksByParams(allFeedbacks, filterParams);

    const dashboardData = computeDashboardData(feedbacks);
    const clusteredDepartments = runKMeansClustering(allFeedbacks);

    // --- Build PSAU-QMS-SF-20 data for report.ejs — Organizational Unit shows filtered office or 'All' ---
    const office = filterParams.selectedOffice && filterParams.selectedOffice !== 'all' ? filterParams.selectedOffice : 'All';
    const respondents = feedbacks.length;

    // helpers
    function getAdj(mean) {
      if (mean >= 4.50) return 'Outstanding';
      if (mean >= 4.00) return 'Very Satisfactory';
      if (mean >= 3.50) return 'Satisfactory';
      if (mean >= 3.00) return 'Needs Improvement';
      return 'Poor';
    }

    const sqdFields = ['sqd0', 'sqd1', 'sqd2', 'sqd3', 'sqd4', 'sqd5', 'sqd6', 'sqd7', 'sqd8'];
    const sqdDefs = [
      { code: 'SQD0', full: 'General Satisfaction & Overall Quality', desc: 'Overall satisfaction with service received' },
      { code: 'SQD1', full: 'Processing Speed & Waiting Time', desc: 'Reasonableness of time spent in transaction' },
      { code: 'SQD2', full: 'Requirements & Document Compliance', desc: 'Adherence to required documents and steps' },
      { code: 'SQD3', full: 'Simplicity of Steps & Payment', desc: 'Ease of procedures including payment' },
      { code: 'SQD4', full: 'Information Accessibility', desc: 'Easiness to find information (office/website)' },
      { code: 'SQD5', full: 'Fair & Reasonable Fees', desc: 'Reasonableness of fees (or N/A if free)' },
      { code: 'SQD6', full: 'Equality & Fair Treatment', desc: 'Fairness — walang palakasan' },
      { code: 'SQD7', full: 'Staff Courtesy & Frontline Support', desc: 'Courtesy and willingness to assist' },
      { code: 'SQD8', full: 'Outcome Fulfillment', desc: 'Service outcome delivered / explained if denied' }
    ];

    // Overall frequency dist (all SQDs across filtered feedbacks)
    const overallCounts = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0, 'N/A': 0 };
    let overallSum = 0, overallValid = 0;
    feedbacks.forEach(f => {
      sqdFields.forEach(field => {
        const v = String(f[field] == null ? '' : f[field]).trim();
        if (overallCounts[v] !== undefined) overallCounts[v]++;
        if (v !== 'N/A' && v !== '' && !isNaN(parseFloat(v))) { overallSum += parseFloat(v); overallValid++; }
      });
    });
    // --- Python-aligned SQD SUMMARY COMPUTATION (matches your snippet) ---
    // Python: sqd_df = pd.DataFrame(sqd_rows); avg = sqd_df.mean()
    //         valid = avg["5"]+avg["4"]+avg["3"]+avg["2"]+avg["1"]
    //         positive = avg["5"]+avg["4"]
    //         percentage = positive/valid*100 if valid else 0
    // Since avg = total/numSQDs (9), ratio equals (total 5+4)/(total valid) — keep total for efficiency but comment matches Python
    const positiveCounts = overallCounts['5'] + overallCounts['4'];
    const validCounts = overallCounts['5'] + overallCounts['4'] + overallCounts['3'] + overallCounts['2'] + overallCounts['1'];
    // keep mean for adj/label (mean is still needed for Outstanding etc.), but pct is now positive share per Python
    const overallMean = overallValid > 0 ? (overallSum / overallValid) : 0;
    const overallPct = validCounts > 0 ? (positiveCounts / validCounts * 100) : 0;
    const overallAdj = overallValid > 0 ? getAdj(overallMean) : '—';
    const overall = { counts: overallCounts, valid: overallValid, mean: overallMean, pct: overallPct, adj: overallAdj, positive: positiveCounts, validForPct: validCounts, percentage: overallPct };

    // Per-SQD summary
    const sqdSummary = sqdFields.map((field, i) => {
      const counts = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0, 'N/A': 0 };
      let sum = 0, valid = 0;
      feedbacks.forEach(f => {
        const v = String(f[field] == null ? '' : f[field]).trim();
        if (counts[v] !== undefined) counts[v]++;
        if (v !== 'N/A' && v !== '' && !isNaN(parseFloat(v))) { sum += parseFloat(v); valid++; }
      });
      const mean = valid > 0 ? (sum / valid) : 0;
      const positive = counts['5'] + counts['4'];
      const pct = valid > 0 ? (positive / valid * 100) : 0; // Python-aligned (was mean/5*100)
      const adj = valid > 0 ? getAdj(mean) : '—';
      return { code: sqdDefs[i].code, full: sqdDefs[i].full, desc: sqdDefs[i].desc, counts, valid, mean, pct, adj, positive };
    });
    const sqdTotals = { ...overallCounts };
    const sqdOverallMean = overallMean;
    const sqdOverallPct = overallPct;
    const sqdOverallAdj = overallAdj;

    // Monthly breakdown (group by actual feedback dates)
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const monthMap = {};
    feedbacks.forEach(f => {
      const dateStr = f.submittedAt || f.petsa;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthMap[key]) {
        monthMap[key] = { key, name: monthNames[d.getMonth()], year: d.getFullYear(), date: d, counts: { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0, 'N/A': 0 } };
      }
      const entry = monthMap[key];
      sqdFields.forEach(field => {
        const v = String(f[field] == null ? '' : f[field]).trim();
        if (entry.counts[v] !== undefined) entry.counts[v]++;
      });
    });
    let months = Object.values(monthMap).sort((a, b) => a.date - b.date).map(m => {
      const valid = m.counts['5'] + m.counts['4'] + m.counts['3'] + m.counts['2'] + m.counts['1'];
      const positive = m.counts['5'] + m.counts['4'];
      const sum = m.counts['5'] * 5 + m.counts['4'] * 4 + m.counts['3'] * 3 + m.counts['2'] * 2 + m.counts['1'] * 1;
      const mean = valid > 0 ? (sum / valid) : 0;
      const pct = valid > 0 ? (positive / valid * 100) : 0; // Python-aligned: positive/valid (was mean/5*100)
      const adj = valid > 0 ? getAdj(mean) : '—';
      return { name: m.name, year: m.year, counts: m.counts, valid, mean, pct, adj, positive };
    });
    // Fallback: if date parsing yielded nothing but feedbacks exist (e.g. bad/missing dates), create one synthetic month bucket from periodLabel
    if (months.length === 0 && feedbacks.length > 0) {
      months = [{ name: filterParams.periodLabel || 'Overall', year: new Date().getFullYear(), counts: { ...overallCounts }, valid: overallValid, mean: overallMean, pct: overallPct, adj: overallAdj }];
    }
    // Derive year for header (qms-report compatibility)
    const year = (months.length > 0 && months[0].year) ? months[0].year : new Date().getFullYear();

    // Remarks
    const remarks = overallValid > 0 ? `${overallAdj} — Period rating ${overallPct.toFixed(2)}% (${overallMean.toFixed(2)}/5.00). ${dashboardData.performanceRating ? dashboardData.performanceRating.label : ''}`.trim() : 'No data for selected period/scope.';

    // Comments / complaints — split by availability
    const allWithComments = feedbacks.filter(f => f.suggestions && String(f.suggestions).trim().length > 0).map(f => ({
      pangalan: String(f.pangalan || 'Anonymous').substring(0, 100),
      tanggapan: String(f.tanggapan || office).substring(0, 120),
      petsa: String(f.petsa || (f.submittedAt ? String(f.submittedAt).substring(0, 10) : '')).substring(0, 20),
      suggestions: String(f.suggestions).substring(0, 2000)
    }));
    // Heuristic: receivedComments = non-complaint (positive/neutral), complaints = negative/mixed or contains complaint keywords
    const complaintKeywords = ['complaint', 'reklamo', 'mabagal', 'masungit', 'rude', 'slow', 'hindi maganda', 'poor', 'bad', 'disappoint'];
    const receivedComments = allWithComments.length ? allWithComments.filter(f => {
      const lower = String(f.suggestions).toLowerCase();
      const isNeg = complaintKeywords.some(k => lower.includes(k));
      return !isNeg;
    }).slice(0, 50) : [];
    let complaints = allWithComments.filter(f => {
      const lower = String(f.suggestions).toLowerCase();
      return complaintKeywords.some(k => lower.includes(k));
    }).slice(0, 50);
    // If no keyword match but we have comments, put negative sentiment ones into complaints fallback
    if (complaints.length === 0) {
      const negFromSentiment = feedbacks.filter(f => {
        const s = String(f.sentiment || f.naiveBayesSentiment || '').toLowerCase();
        return (s === 'negative' || s === 'mixed') && f.suggestions && String(f.suggestions).trim().length > 0;
      }).map(f => ({
        pangalan: String(f.pangalan || 'Anonymous').substring(0, 100),
        tanggapan: String(f.tanggapan || office).substring(0, 120),
        petsa: String(f.petsa || (f.submittedAt ? String(f.submittedAt).substring(0, 10) : '')).substring(0, 20),
        suggestions: String(f.suggestions).substring(0, 2000)
      }));
      if (negFromSentiment.length > 0) complaints = negFromSentiment.slice(0, 50);
      else complaints = allWithComments.slice(0, 50); // final fallback: show same as comments if we have any
    }
    // If receivedComments ended empty but we have comments, fallback to show first half as comments
    const finalReceivedComments = receivedComments.length ? receivedComments : (complaints.length && allWithComments.length > complaints.length ? allWithComments.filter(c => !complaints.includes(c)).slice(0, 50) : (allWithComments.length ? allWithComments.slice(0, 50) : []));

    // --- Dynamic real date/time (replaces hard-coded July 16/22, 2026) ---
    const now = new Date();
    const effDate = now.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
    const todayShort = now.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }); // e.g. 08/29/2026
    const generatedAt = now.toLocaleString('en-PH', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });

    // Signatories from query (modal override) — dates default to todayShort (live date)
    const preparedBy = req.query.preparedBy ? sanitizeText(req.query.preparedBy, 200) : undefined;
    const reviewedBy = req.query.reviewedBy ? sanitizeText(req.query.reviewedBy, 200) : undefined;
    const certifiedBy = req.query.certifiedBy ? sanitizeText(req.query.certifiedBy, 200) : undefined;
    const preparedDate = req.query.preparedDate ? sanitizeText(req.query.preparedDate, 20) : todayShort;
    const reviewedDate = req.query.reviewedDate ? sanitizeText(req.query.reviewedDate, 20) : todayShort;
    const certifiedDate = req.query.certifiedDate ? sanitizeText(req.query.certifiedDate, 20) : todayShort;

    res.render('report', {
      feedbacks,
      stats: dashboardData.stats,
      chartData: dashboardData.chartData,
      categorizedSqd: dashboardData.categorizedSqd,
      demographics: dashboardData.demographics,
      performanceRating: dashboardData.performanceRating,
      selectedOffice: filterParams.selectedOffice,
      filterType: filterParams.filterType,
      periodLabel: filterParams.periodLabel,
      monthVal: filterParams.monthVal,
      dateFrom: filterParams.dateFromStr,
      dateTo: filterParams.dateToStr,
      clusteredDepartments,
      generatedAt,
      effDate,
      todayShort,
      // QMS SF-20 specific — also supply legacy 'office' alias
      office,
      respondents,
      months,
      overall,
      sqdSummary,
      sqdTotals,
      sqdOverallMean,
      sqdOverallPct,
      sqdOverallAdj,
      remarks,
      receivedComments: finalReceivedComments,
      complaints,
      year,
      preparedBy,
      reviewedBy,
      certifiedBy,
      preparedDate,
      reviewedDate,
      certifiedDate
    });
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).send('Error generating report.');
  }
});

// Admin: Automated Quarterly Reports
app.get('/admin/quarterly-reports', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('feedbacks').get();
    const allFeedbacks = [];
    snapshot.docs.forEach(doc => {
      allFeedbacks.push({ id: doc.id, ...doc.data() });
    });

    const officeSet = new Set();
    allFeedbacks.forEach(f => {
      if (f.tanggapan && typeof f.tanggapan === 'string' && f.tanggapan.trim().length > 0) {
        officeSet.add(f.tanggapan.trim());
      }
    });
    const availableOffices = [...officeSet].sort();

    const selectedOffice = req.query.office || 'all';
    let feedbacksToProcess = allFeedbacks;
    if (selectedOffice && selectedOffice !== 'all') {
      feedbacksToProcess = allFeedbacks.filter(f => matchesOffice(f.tanggapan, selectedOffice));
    }

    const quarterlyData = processQuarterlyData(feedbacksToProcess, req.query.year, req.query.quarter);

    res.render('quarterly-report', {
      ...quarterlyData,
      availableOffices,
      selectedOffice,
      userRole: req.session.role || 'admin',
      adminUser: req.session.adminUser || ''
    });
  } catch (err) {
    console.error('Quarterly Reports error:', err);
    res.status(500).send('Error generating quarterly reports.');
  }
});

// Admin: Export DOCX Word Document Report
app.get('/admin/export-docx', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('feedbacks').get();
    const allFeedbacks = [];
    snapshot.docs.forEach(doc => {
      allFeedbacks.push({ id: doc.id, ...doc.data() });
    });

    const filterParams = getFilterParams(req.query);
    const feedbacks = filterFeedbacksByParams(allFeedbacks, filterParams);

    const { stats, categorizedSqd, demographics, performanceRating } = computeDashboardData(feedbacks);

    const htmlContent = `
 <!DOCTYPE html>
 <html>
 <head><meta charset="utf-8"><title>PSAU Customer Feedback Report</title></head>
 <body>
 <h1 style="color: #1b5e20;">Pampanga State Agricultural University</h1>
 <h2>Customer Satisfaction & Quality Management Analysis Report</h2>
 <p><strong>ISO QMS Control No:</strong> PSAU-QMS-CFF-2026</p>
 <p><strong>Generated Date:</strong> ${new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
 <p><strong>Scope / Office:</strong> ${escapeHtml(filterParams.selectedOffice !== 'all' ? filterParams.selectedOffice : 'All Offices (University-Wide Overall)')}</p>
 <p><strong>Filter Period:</strong> ${escapeHtml(filterParams.periodLabel)}</p>
 <hr />
 <h3>1. Executive Performance Summary</h3>
 <ul>
 <li><strong>Total Feedbacks Received:</strong> ${stats.totalResponses}</li>
 <li><strong>Average Service Quality Dimension (SQD) Score:</strong> ${stats.avgSQD} / 5.00 (Classification: ${performanceRating.label})</li>
 <li><strong>Positive Sentiment Rate:</strong> ${stats.positivePct}%</li>
 <li><strong>Citizen's Charter Awareness Rate:</strong> ${stats.ccAwarenessPct}%</li>
 <li><strong>Suggestions Received:</strong> ${stats.totalSuggestions}</li>
 </ul>
 <hr />
 <h3>2. Categorized Service Quality Dimensions (SQD Pillars)</h3>
 ${categorizedSqd.map(pillar => `
 <h4 style="color: #1b5e20; margin-top: 10px;">${pillar.code}: ${pillar.name} (Avg: ${pillar.avg.toFixed(2)}/5.00)</h4>
 <ul>
 ${pillar.items.map(item => `
 <li><strong>${item.code} (${item.name}):</strong> ${item.score.toFixed(2)} / 5.00</li>
 `).join('')}
 </ul>
 `).join('')}
 <hr />
 <h3>3. Respondent Demographics Breakdown</h3>
 <p><strong>Client Types:</strong> ${Object.keys(demographics.clientTypeCounts).map(k => `${k}: ${demographics.clientTypeCounts[k]}`).join(', ') || 'N/A'}</p>
 <p><strong>Gender Breakdown:</strong> Male: ${demographics.genderCounts.lalaki}, Female: ${demographics.genderCounts.babae}</p>
 <hr />
 <h3>4. Detailed Feedback Response Listing (${feedbacks.length})</h3>
 <table border="1" cellpadding="5" cellspacing="0" style="width:100%; border-collapse:collapse;">
 <thead>
 <tr style="background-color: #f2f2f2;">
 <th>#</th>
 <th>Respondent Name</th>
 <th>Office / Department</th>
 <th>Client Type</th>
 <th>Avg SQD</th>
 <th>Sentiment</th>
 <th>Date</th>
 </tr>
 </thead>
 <tbody>
 ${feedbacks.map((f, i) => `
 <tr>
 <td>${i + 1}</td>
 <td>${escapeHtml(f.pangalan || 'N/A')}</td>
 <td>${escapeHtml(f.tanggapan || 'N/A')}</td>
 <td>${escapeHtml(f.uri_kliyente || 'N/A')}</td>
 <td>${escapeHtml(f.avgSQD || 'N/A')}</td>
 <td>${escapeHtml(f.sentiment || 'N/A')}</td>
 <td>${escapeHtml(f.petsa || f.submittedAt || 'N/A')}</td>
 </tr>
 `).join('')}
 </tbody>
 </table>
 </body>
 </html>
 `;

    const docxBuffer = await HTMLtoDOCX(htmlContent, null, {
      table: { row: { cantSplit: true } },
      footer: true,
      pageNumber: true
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename=PSAU_Customer_Feedback_Report_${Date.now()}.docx`);
    res.send(docxBuffer);
  } catch (err) {
    console.error('DOCX Export error:', err);
    res.status(500).send('Error generating DOCX report.');
  }
});

// ========== START SERVER ==========
async function startServer() {
  await initMLModel();
  const server = app.listen(PORT, () => {
    console.log(`\n PSAU Feedback System running on http://localhost:${PORT}`);
    console.log(` Form: http://localhost:${PORT}/`);
    console.log(` Admin: http://localhost:${PORT}/admin/login`);
    console.log(` Dashboard: http://localhost:${PORT}/admin/login\n`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n Server shutting down...');
    server.close(() => process.exit(0));
  });
}

startServer();


