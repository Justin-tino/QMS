# Development Sessions Log
**Project:** PSAU Machine Learning-Driven Feedback Sentiment Analysis System  
**Stack:** Node.js + Express.js | Firebase Firestore | Local Naïve Bayes ML | EJS Templating

---

## Session 1: Core Architecture & Offline-First PWA (August 2026)

### 1. Offline-First PWA Capabilities (IndexedDB & Service Worker)

- **Web App Manifest (`public/manifest.json`)**: Configured standalone PWA settings, theme colors (`#1b5e20`), and icon definitions.
- **Service Worker (`public/sw.js`)**: Implemented caching strategies (App Shell pre-caching + Stale-While-Revalidate asset caching + Network-First HTML navigation with offline fallback).
- **IndexedDB Storage Engine (`public/js/offline-sync.js`)**: Intercepts form submissions when internet connectivity is offline, saves entries to IndexedDB (`PSAU_Feedback_DB`), shows real-time user status notifications, and automatically synchronizes queued records to Firebase/Node backend when back online.

### 2. Trilingual Local Naïve Bayes Sentiment Model (`naiveBayes.js`)

- Built a custom **Multinomial Naïve Bayes Classifier** trained on English, Tagalog (Filipino), and Kapampangan sentiment corpora.
- Implemented Laplace smoothing and log probability calculations for local text classification.
- Classifies feedback into `Positive`, `Negative`, `Neutral`, and `Mixed` categories with confidence scores.
- Supports **incremental online learning** — each submitted feedback trains the model further.
- Model state is **persisted to Firestore** (`ml_model_state` collection) and loaded on server restart.

### 3. Automated Email Notification System (`emailService.js`)

- Integrated `nodemailer` (SMTP) to dispatch automated confirmation emails to respondents upon submission.
- Integrated admin alert emails for new feedback submissions with special warning triggers for low ratings (SQD < 3.00).
- Falls back to Console/Test mode when SMTP credentials are not configured.

### 4. Automated Quarterly Reporting & DOCX Export (`quarterlyReports.js`)

- **Quarterly Processor**: Automatically buckets feedback data into Q1 (Jan–Mar), Q2 (Apr–Jun), Q3 (Jul–Sep), and Q4 (Oct–Dec). Calculates quarterly SQD averages, Citizen's Charter awareness rates, and top/bottom performing departments.
- **Quarterly View (`views/quarterly-report.ejs`)**: Dedicated ISO QMS-compliant report UI with annual matrix comparison.
- **DOCX Word Export (`/admin/export-docx`)**: Generates downloadable `.docx` reports using `html-to-docx`.

### 5. Role-Based Access Control (RBAC) & Security Hardening

- Added **Role Support** (`System Administrator` with full access vs `Staff / Department Head` read-only viewer).
- Implemented per-session **CSRF Protection Tokens** for form submissions and administrative login routes.
- **Rate limiting** on login endpoint (10 attempts per 15 minutes).
- **Helmet.js** security headers with Content Security Policy.

### Files Created/Modified:
- `manifest.json`, `sw.js`, `offline-sync.js`
- `form.ejs`, `thank-you.ejs`, `login.ejs`, `dashboard.ejs`
- `naiveBayes.js`, `emailService.js`, `quarterlyReports.js`
- `quarterly-report.ejs`, `report.ejs`, `print-ai-report.ejs`
- `server.js`, `firebase.js`

---

## Session 2: Flexible Period Filtering & Categorized Reporting (August 2026)

### 6. Centralized Filter Management

- **`server.js`**: Implemented `getFilterParams()` and `filterFeedbacksByParams()` helpers supporting `overall` totals, `month` filtering (`YYYY-MM`), and custom date ranges (`dateFrom` to `dateTo`).

### 7. Categorized SQD Pillars & Demographics

- Restructured analytics computation into 4 core SQD Pillars:
  - **Pillar A:** Overall Satisfaction & Outcome (SQD0, SQD8)
  - **Pillar B:** Process Efficiency & Compliance (SQD1, SQD2, SQD3)
  - **Pillar C:** Access & Financial Fairness (SQD4, SQD5)
  - **Pillar D:** Equity, Courtesy & Frontline Support (SQD6, SQD7)
- Demographic breakdowns: Client type, Gender, Age distributions.
- Performance classification badges: Outstanding, Very Satisfactory, Satisfactory, Needs Improvement, Poor.

### 8. Publication-Ready Printable & DOCX Reports

- **`views/report.ejs`**: Overhauled printable feedback report UI with ISO 9001 control metadata, executive narratives, progress bar visuals for SQD metrics, and sign-off blocks.

### 9. Dashboard Interactive Report Modal

- **`views/dashboard.ejs`**: Added a modal allowing administrators to select period filters and instantly view/print PDF, download DOCX, or generate local ML analysis reports.

---

## Session 3: Local ML Report Generation & Cleanup (August 2026)

### 10. Local ML Report Generator (`generateLocalReport()`)

- Structured report output with:
  - Executive Performance Summary (total respondents, overall SQD score, performance classification)
  - Top Performance Strengths & Priority Areas for Attention (sorted SQD dimensions)
  - Trilingual Naïve Bayes Sentiment Classification Analysis (Positive/Neutral/Negative/Mixed breakdown)
  - Recommended Institutional Action Plan (context-aware recommendations per lowest SQD dimension)

### 11. K-Means Clustering Integration

- **`runKMeansClustering()`** in `server.js`: Custom JavaScript K-Means (k=3) clustering departments into performance segments based on 9-dimensional SQD feature vectors.
- Labels: Outstanding Performance / Satisfactory Performance / Needs Attention.
- Results displayed on dashboard as department performance clusters.

### 12. ML Model Persistence via Firestore

- On server startup: loads model state from `ml_model_state/naive_bayes` Firestore document.
- On each feedback submission: incrementally trains model and saves updated state back to Firestore.
- Ensures ML model learning persists across server restarts.

---

## Technology Stack Summary

| Component | Technology |
|:--|:--|
| Backend Runtime | Node.js + Express.js |
| Templating Engine | EJS |
| Database | Firebase Firestore (NoSQL Cloud) |
| Authentication | Firebase Auth REST API + Express Sessions |
| Sentiment Analysis | Custom Trilingual Naïve Bayes Classifier (JavaScript) |
| Rating Pattern Analysis | Custom K-Means Clustering (JavaScript, k=3) |
| Email Notifications | Nodemailer (SMTP) |
| Offline Support | Service Worker + IndexedDB + Web App Manifest (PWA) |
| Report Export | html-to-docx (DOCX), Browser Print (PDF) |
| Security | Helmet.js, CSRF Tokens, Rate Limiting, RBAC |
| Frontend Charts | Chart.js |