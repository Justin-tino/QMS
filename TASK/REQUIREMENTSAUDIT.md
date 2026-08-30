# Requirements Audit & Gap Analysis
**Project:** Development and Implementation of a Machine Learning-Driven Feedback Sentiment Analysis System for Pampanga State Agricultural University (PSAU)  
**Proponents:** Timothy P. Bonus, Dane M. Sicat, Jandel J. Duya  
**Adviser:** Agustin Edmin S. Yuzon  
**Technology Stack:** Node.js + Express.js (Backend), Firebase Firestore (Database), EJS (Templating), Naïve Bayes ML (Sentiment Classification)  
**Date of Audit:** August 21, 2026

---

## 1. Executive Summary

This audit evaluates the current implementation of the PSAU Feedback System against the objectives and functional requirements stated in the capstone paper (`TIMO.docx`). The system uses **Node.js, Express.js, and Firebase Firestore** as its technology stack. Machine learning is handled entirely by a **local Trilingual Naïve Bayes classifier** and a **custom K-Means Clustering algorithm** — both written in JavaScript. **No third-party AI agents or services** are used.

> **Important Note on TIMO.docx Contradictions:** The capstone paper itself contains internal contradictions. The "Development Tools & Technologies" section (Section 2.3) explicitly specifies **Node.js, Express.js, and Firebase Firestore**, yet the "Expected Output" section (8.8) references "MySQL database, managed through the Laravel system." The "Machine Learning Tools" section also references "Pollination AI" alongside the local ML algorithms. Per project decision, **only the local ML approach (Naïve Bayes + K-Means) using Node.js and Firestore is authoritative**.

---

## 2. Requirement Traceability Matrix

| # | Capstone Paper Requirement | TIMO.docx Reference | Current Implementation | Status |
|:--|:---|:---|:---|:---|
| 1 | **Web-Based Feedback Form** | Section 8.2 — Web app, no installation required, collects SQD ratings + text comments | `views/form.ejs` — mobile-responsive web form collecting SQD0–SQD8, CC1–CC3, demographics, and text suggestions | ✅ **Fully Met** |
| 2 | **QR-Based Feedback Access** | Section 8.1 — Unique QR per department, scan to open form | QR code integration via external QR API (`api.qrserver.com`), department identification through form fields | ✅ **Fully Met** |
| 3 | **Offline-First / PWA Support** | Section 2.2 — Offline data saved locally, auto-sync when online; IndexedDB + Service Workers | Service Worker (`public/sw.js`), Web Manifest (`public/manifest.json`), IndexedDB offline storage & auto-sync (`public/js/offline-sync.js`) | ✅ **Fully Met** |
| 4 | **Naïve Bayes Sentiment Analysis** | Specific Objective #3 — Naïve Bayes for text classification | `naiveBayes.js` — Multinomial Naïve Bayes with Laplace smoothing, unigram+bigram tokenization, incremental online learning, Firestore model persistence | ✅ **Fully Met** |
| 5 | **K-Means Clustering for Rating Patterns** | Specific Objective #3 — K-Means for SQD rating pattern analysis | `server.js` `runKMeansClustering()` — Custom K-Means (k=3) on 9-dimensional SQD feature vectors per department, labels: Outstanding / Satisfactory / Needs Attention | ✅ **Fully Met** |
| 6 | **Multilingual Sentiment (EN, Tagalog, Kapampangan)** | Specific Objective #4 — English, Tagalog, Kapampangan | `naiveBayes.js` seed corpus contains trilingual training data for all 3 languages | ✅ **Fully Met** |
| 7 | **QMS / Citizen's Charter Compliance** | Specific Objective #5 — Follow QMS code-controlled procedures | CC1, CC2, CC3 evaluation fields + SQD0–SQD8 rating dimensions + QMS control number (`QMS-CFF-2026`) in reports | ✅ **Fully Met** |
| 8 | **Required User Identification Fields** | Specific Objective #6 — Name, transaction details required | Form enforces mandatory fields: `pangalan` (name), `kasarian`, `edad`, `tanggapan`, etc. | ✅ **Fully Met** |
| 9 | **Quarterly Customer Feedback Reports** | Specific Objective #7 — Generate reports on quarterly basis | `quarterlyReports.js` — Automated Q1–Q4 bucketing, SQD averages, sentiment stats, top/bottom departments; `views/quarterly-report.ejs` UI | ✅ **Fully Met** |
| 10 | **Data Visualization & Analytics Dashboard** | Section 8.6 — Charts, graphs, summary reports; avg ratings, sentiment, dept performance | `views/dashboard.ejs` — Chart.js visualizations, categorized SQD pillars (A–D), demographic breakdowns, K-Means cluster results, performance badges | ✅ **Fully Met** |
| 11 | **Decision Support System (DSS)** | Section 8.7 — Interpret analyzed data, provide recommendations | `generateLocalReport()` in `server.js` — Automated recommendations based on lowest-scoring SQD dimensions, performance classification (Outstanding to Poor) | ✅ **Fully Met** |
| 12 | **Automated Email Notifications** | Section 8.3 — Confirmation to user + copy to admin via SMTP | `emailService.js` — Nodemailer SMTP integration; user confirmation email + admin alert (with low-rating warnings for SQD < 3.0) | ✅ **Fully Met** |
| 13 | **Firebase Firestore Database** | Section 2.3 — Firebase/Firestore as primary storage | `firebase.js` — Firestore collections: `feedbacks`, `ml_model_state`; all CRUD operations use Firestore Admin SDK | ✅ **Fully Met** |
| 14 | **DOCX Report Export** | Section 8.9 — Report generation | `/admin/export-docx` route — `html-to-docx` generates downloadable Word documents with full feedback listing, SQD pillars, demographics | ✅ **Fully Met** |
| 15 | **Role-Based Access Control (RBAC)** | Section 2.3 — User Authentication, role-based access | Session-based auth via Firebase Auth API; `admin` vs `staff` roles; `requireAuth` middleware; CSRF protection tokens | ✅ **Fully Met** |

---

## 3. Identified Issues & Contradictions in TIMO.docx

The following items in the TIMO.docx are **contradictory or outdated** relative to the actual project decisions and implementation:

### A. ❌ Section 8.8 References MySQL + Laravel (WRONG)
- **TIMO.docx says:** "All feedback data will be securely stored in a MySQL database, managed through the Laravel system."
- **Reality:** The same document's Section 2.3 (Development Tools) explicitly specifies **Firebase Firestore** and **Node.js**. The current system correctly uses Firestore. Section 8.8 was never updated to match the technology decision.

### B. ❌ Machine Learning Tools Section References "Pollination AI" (WRONG)
- **TIMO.docx says:** "Pollination AI – The primary AI engine used for sentiment analysis..."
- **Reality:** No third-party AI agents are used. All sentiment analysis is performed by the **local Trilingual Naïve Bayes classifier** (`naiveBayes.js`). This line in the TIMO.docx contradicts the project's specific objectives which state "Naïve Bayes and K-Means Clustering" as the ML techniques.

### C. ❌ Section 2.3 References "Rubix ML library...compatible with PHP and Laravel" (WRONG)
- **TIMO.docx says:** "Naive Bayes for text classification and K-Means clustering may be implemented using the Rubix ML library, which is compatible with PHP and Laravel systems."
- **Reality:** Rubix ML is a PHP library. The project uses Node.js. The ML algorithms are implemented as custom JavaScript modules (`naiveBayes.js` for Naïve Bayes, `runKMeansClustering()` in `server.js` for K-Means).

### D. ❌ Email Section References "SMTP integrated within the Laravel framework" (WRONG)
- **TIMO.docx says:** Email functionality "will be implemented using SMTP...integrated within the Laravel framework."
- **Reality:** Email is implemented using `nodemailer` in Node.js (`emailService.js`). Laravel is not used anywhere in the project.

### E. ⚠️ Sustainability Plan References "Laravel-based system" and "MySQL database" (WRONG)
- **TIMO.docx Section 9 (Sustainability)** mentions: "The Laravel-based system..." and "All feedback data stored in the MySQL database will be regularly backed up..."
- **Reality:** These references are outdated. The actual stack is Node.js + Firestore.

---

## 4. Minor Codebase Cleanup Items (Non-Critical)

| Item | Description | Impact |
|:--|:--|:--|
| Legacy route naming | Routes still use `generate-ai-report`, `print-ai-report` naming convention | Cosmetic — functions correctly but implies third-party AI usage |
| Variable naming | `aiAnalysis`, `aiAnalysisCleaned` variables in server and EJS templates | Cosmetic — these now return local ML output, not AI-generated content |
| `print-ai-report.ejs` filename | Template named after "AI report" but renders local Naïve Bayes output | Cosmetic — works correctly |

---

## 5. Verification Items for Deployment Readiness

### A. Environment Configuration
- **Action:** Ensure `.env` contains valid `FIREBASE_API_KEY`, `SESSION_SECRET`, and SMTP credentials (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`).
- **Action:** Verify `serviceAccountKey.json` is properly secured and not committed to version control.

### B. Offline-First Sync Testing
- **Action:** Test offline submission by disconnecting network in Chrome DevTools → submit feedback → reconnect → verify auto-sync to Firestore.

### C. ML Model Tuning
- **Action:** The Naïve Bayes classifier uses a seed corpus and learns incrementally from submitted feedback. Periodically review classification accuracy for Kapampangan dialect terms.

### D. SMTP Email Configuration
- **Action:** Supply valid institutional SMTP credentials. Without them, emails run in Console/Test mode (submissions still succeed).

### E. ISO 25010 Evaluation Questionnaires
- **Action:** Prepare digital evaluation forms for alpha testing (ICT experts) and beta testing (students/staff) as specified in the TIMO.docx methodology.

---

## 6. Conclusion

The system **correctly implements all core objectives** from the capstone proposal using the **authorized technology stack** (Node.js + Firestore + local Naïve Bayes ML). The contradictions identified in Section 3 exist **within the TIMO.docx itself** — where certain sections were not updated to reflect the finalized technology decisions documented in the Development Tools section. No third-party AI agents are used; all machine learning is performed locally using custom JavaScript implementations of Naïve Bayes and K-Means Clustering.
